import { DEPLOYMENT_RETENTION_MS, parseDeployment, parseVersion, record, type Deployment, type DeploymentPoll, type VersionMetadata } from "./model.ts";
import { reportError } from "../observe/producer/report.ts";

const MAX_PAGES = 3;
const PAGE_SIZE = 100;
const MAX_VERSION_READS = 4;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface DeploymentStore {
  recordDeploymentPoll(poll: DeploymentPoll): Promise<void>;
  knownDeploymentVersions(project: string, worker: string): Promise<readonly string[]>;
}
export type DeploymentFetch = (url: string, init: RequestInit) => Promise<Response>;

export function deploymentsEnabled(env: { readonly DEPLOYMENTS_ACCOUNT_ID?: string; readonly DEPLOYMENTS_API_TOKEN?: string }): boolean {
  return Boolean(env.DEPLOYMENTS_ACCOUNT_ID || env.DEPLOYMENTS_API_TOKEN);
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES || response.body === null) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("invalid_response");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

async function collectProject(input: {
  readonly project: { readonly id: string; readonly worker: string };
  readonly account: string;
  readonly token: string;
  readonly now: number;
  readonly store: DeploymentStore;
  readonly fetch: DeploymentFetch;
}): Promise<void> {
  const { project, now, store } = input;
  let code = "upstream";
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.account}/workers/scripts/${encodeURIComponent(project.worker)}`;
  // One deadline bounds pagination, body reads, and optional metadata requests together.
  const signal = AbortSignal.timeout(20_000);
  const request = async (suffix: string): Promise<Record<string, unknown>> => {
    const response = await input.fetch(`${base}${suffix}`, { method: "GET", headers: { Authorization: `Bearer ${input.token}` }, redirect: "manual", signal });
    if (!response.ok) {
      code = response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 429 ? "rate_limited" : "upstream";
      await response.body?.cancel();
      throw new Error(code);
    }
    code = "invalid_response";
    const envelope = record(await readJson(response));
    if (envelope["success"] !== true) throw new Error(code);
    return envelope;
  };
  try {
    const deployments = new Map<string, Deployment>();
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE), since: new Date(Math.max(0, now - DEPLOYMENT_RETENTION_MS)).toISOString(), until: new Date(now).toISOString() });
      const envelope = await request(`/deployments?${params}`);
      const values = record(envelope["result"])["deployments"];
      if (!Array.isArray(values) || values.length > PAGE_SIZE) throw new Error("invalid_response");
      const parsed = values.map(parseDeployment);
      const previousSize = deployments.size;
      for (const deployment of parsed) {
        if (deployment.atMs > now || deployment.atMs < now - DEPLOYMENT_RETENTION_MS) throw new Error("invalid_response");
        deployments.set(deployment.id, deployment);
      }
      const info = envelope["result_info"] === undefined ? {} : record(envelope["result_info"]);
      const pages = info["total_pages"];
      if (pages !== undefined && (typeof pages !== "number" || !Number.isSafeInteger(pages) || pages < 0)) throw new Error("invalid_response");
      if (typeof pages === "number" ? page >= pages : values.length < PAGE_SIZE) break;
      if (deployments.size === previousSize || page === MAX_PAGES) { truncated = true; break; }
    }
    const ordered = [...deployments.values()].sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id));
    const known = new Set(await store.knownDeploymentVersions(project.id, project.worker));
    const missing = [...new Set(ordered.flatMap(deployment => deployment.versions.map(version => version.id)))].filter(id => !known.has(id)).slice(0, MAX_VERSION_READS);
    const versions: VersionMetadata[] = [];
    for (const id of missing) {
      try { versions.push(parseVersion((await request(`/versions/${id}`))["result"], id)); }
      catch (error) { reportError("deployments.version", error); }
    }
    await store.recordDeploymentPoll({ project: project.id, worker: project.worker, atMs: now, error: null, deployments: ordered, versions, truncated });
  } catch (error) {
    reportError("deployments.poll", error);
    try {
      await store.recordDeploymentPoll({ project: project.id, worker: project.worker, atMs: now, error: signal.aborted ? "timeout" : code, deployments: [], versions: [], truncated: false });
    } catch (recordError) {
      reportError("deployments.record", recordError);
      console.error(JSON.stringify({ event: "deployment_poll_unrecorded" }));
    }
  }
}

/** This collector never throws into the existing metrics collection path. */
export async function collectDeployments(input: {
  readonly projects: readonly { readonly id: string; readonly worker: string }[];
  readonly account?: string;
  readonly token?: string;
  readonly now: number;
  readonly store: DeploymentStore;
  readonly fetch: DeploymentFetch;
}): Promise<void> {
  if (!input.account && !input.token) return;
  if (!/^[a-f0-9]{32}$/i.test(input.account ?? "") || !input.token || /[\r\n]/u.test(input.token)) {
    for (const project of input.projects) {
      try { await input.store.recordDeploymentPoll({ project: project.id, worker: project.worker, atMs: input.now, error: "configuration", deployments: [], versions: [], truncated: false }); }
      catch (error) {
        reportError("deployments.record", error);
        console.error(JSON.stringify({ event: "deployment_poll_unrecorded" }));
      }
    }
    return;
  }
  const account = input.account!, token = input.token;
  // Bound fan-out even if the configured project list grows.
  for (let index = 0; index < input.projects.length; index += 2) {
    await Promise.all(input.projects.slice(index, index + 2).map(project => collectProject({ project, account, token, now: input.now, store: input.store, fetch: input.fetch })));
  }
}
