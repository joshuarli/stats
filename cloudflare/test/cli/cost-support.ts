import type { IncomingMessage, ServerResponse } from "node:http";
import { encodeProjectBundle } from "../../src/history-frame.ts";
import { main } from "../../src/cli/run.ts";
import type { ProjectHistory } from "../../src/projects/history.ts";
import { authorized, fakeOrigin, projectEntry, sendJson, tokenEnv, type FakeOrigin } from "./support.ts";

export const NOW_MS = Date.UTC(2026, 10, 15, 12, 20, 0);
const HOUR = 3_600_000;
const RANGE_MS: Readonly<Record<string, number>> = { "1h": HOUR, "6h": 6 * HOUR, "24h": 24 * HOUR, "7d": 168 * HOUR, "30d": 720 * HOUR };
const NAMESPACE = "b25c2595ba784bb1bd51a87a3e87c62b";

export interface WorldProject {
  readonly id: string;
  readonly worker: string;
  readonly routes: number;
  readonly objects: boolean;
  readonly fail?: (url: URL) => number | undefined;
}

export const STATS: WorldProject = { id: "stats", worker: "stats", routes: 3, objects: true };
export const PLAIN: WorldProject = { id: "plain", worker: "plain-worker", routes: 2, objects: false };

function stepFor(spanMs: number): number {
  return [300_000, 900_000, HOUR].find(width => spanMs / width <= 900) ?? HOUR;
}

function series(metric: string, rows: number, base: number): { metric: string; values: number[] } {
  return { metric, values: Array.from({ length: rows }, (_, row) => base + (row % 5)) };
}

function metrics(project: WorldProject, kind: string, rows: number): { metric: string; values: number[] }[] {
  switch (kind) {
    case "worker": return [series("worker.invocations", rows, 20_000), series("worker.cpuMsSum", rows, 80_000), series("worker.status.2xx", rows, 3900), series("worker.status.5xx", rows, 10)];
    case "routes": return Array.from({ length: project.routes }, (_, index) => [series(`route.GET /r${String(index).padStart(2, "0")}.invocations`, rows, 300 + index), series(`route.GET /r${String(index).padStart(2, "0")}.cpuMsSum`, rows, 1000 + 100 * index)]).flat();
    case "durable-objects": return [series("do.invocations", rows, 800), series("do.errors", rows, 1), series("do.cpuMsSum", rows, 4000), series("do.cpuMsMax", rows, 30), series("do.wallMsSum", rows, 9000), series("do.storageBytes", rows, 5_000_000)];
    default: return [];
  }
}

export function historyFrame(project: WorldProject, url: URL, nowMs: number): Uint8Array {
  const range = url.searchParams.get("range");
  const wanted = range === null ? Number(url.searchParams.get("from")) : nowMs - (RANGE_MS[range] ?? HOUR);
  const toMs = range === null ? Math.min(Number(url.searchParams.get("to")), nowMs) : nowMs;
  const stepMs = stepFor(toMs - wanted);
  const fromMs = Math.floor(wanted / stepMs) * stepMs;
  const rows = Math.max(0, Math.floor((toMs - fromMs) / stepMs) + 1);
  const histories: ProjectHistory[] = (url.searchParams.get("kinds") ?? "").split(",").map((kind): ProjectHistory => kind === "collector"
    ? { projectId: project.id, kind: "collector", fromMs, toMs, runs: [] }
    : { projectId: project.id, ...(range === null ? {} : { range: range as "1h" }), kind: kind as "worker", fromMs, toMs, stepMs, series: metrics(project, kind, rows) });
  return encodeProjectBundle(project.id, histories);
}

export interface World {
  readonly projects: readonly WorldProject[];
  readonly nowMs?: number;
}

export async function serve(world: World): Promise<FakeOrigin> {
  const nowMs = world.nowMs ?? NOW_MS;
  return fakeOrigin((request: IncomingMessage, response: ServerResponse) => {
    if (!authorized(request)) return sendJson(response, {}, 401);
    const url = new URL(request.url ?? "/", "http://origin");
    if (url.pathname === "/api/v1/projects") {
      return sendJson(response, world.projects.map(project => projectEntry(project.id, { worker: project.worker, ...(project.objects ? { durableObjectNamespaces: [NAMESPACE] } : {}) })));
    }
    const history = /^\/api\/v1\/projects\/([a-z0-9-]+)\/history$/u.exec(url.pathname);
    if (history !== null) {
      const project = world.projects.find(candidate => candidate.id === history[1]);
      if (project === undefined) return sendJson(response, {}, 404);
      const status = project.fail?.(url);
      if (status !== undefined) return sendJson(response, {}, status);
      response.writeHead(200, { "content-type": "application/vnd.stats.history.v1", etag: '"h"' });
      return void response.end(historyFrame(project, url, nowMs));
    }
    if (url.pathname === "/api/observe/stats/objects") {
      const from = Number(url.searchParams.get("from"));
      return sendJson(response, { fromMs: from, toMs: Number(url.searchParams.get("to")), methods: [{ label: "Installation.jsrpc", requests: 5000, failed: 2, cpuMs: 900, wallMs: 4000, p50WallMs: 3, p95WallMs: 40 }] });
    }
    sendJson(response, {}, 404);
  });
}

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function statsctl(args: readonly string[], options: { readonly origin?: string; readonly nowMs?: number; readonly env?: Readonly<Record<string, string>> } = {}): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const argv = options.origin === undefined ? [...args] : [...args, "--origin", options.origin];
  const code = await main(argv, {
    env: { PATH: process.env["PATH"] ?? "", ...tokenEnv(), ...options.env },
    io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, isTty: false },
    now: () => options.nowMs ?? NOW_MS
  });
  return { code, stdout, stderr };
}

export interface Payload {
  readonly requests: { readonly shared: number; readonly total: number };
  readonly projects: readonly { readonly id: string; readonly status: string; readonly requests: number; readonly report?: PresentedReportShape; readonly error?: { readonly code: string } }[];
}

export interface PresentedReportShape {
  readonly windows: { readonly current: { readonly fromMs: number; readonly toMs: number }; readonly previous: { readonly fromMs: number; readonly toMs: number } };
  readonly lines: readonly { readonly id: string; readonly trend?: unknown; readonly children: readonly { readonly id: string; readonly kind: string; readonly trend?: unknown }[]; readonly omitted: { readonly count: number } | null }[];
  readonly planBill: { readonly kind: string; readonly basis?: string; readonly billed?: unknown };
  readonly total: { readonly monthly: { readonly now: number } };
  readonly comparison: { readonly baseline: string };
  readonly warnings: readonly { readonly code: string }[];
}

export const documentOf = (ran: Ran): Record<string, unknown> => JSON.parse(ran.stdout) as Record<string, unknown>;
export const payloadOf = (ran: Ran): Payload => documentOf(ran)["payload"] as Payload;
