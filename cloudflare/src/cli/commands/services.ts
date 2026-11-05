import { MARKER_ID, MARKER_VERSION, HOST_ID, type Service, type ServiceMarker } from "../../core/installation/services.ts";
import { decodeServiceDeploymentHistory, decodeServiceMarker, decodeServices } from "../../deployments/service-decode.ts";
import type { Deployment } from "../../deployments/model.ts";
import { credentialToken, readCredentialJson } from "../credential-file.ts";
import { authError, CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { REQUEST_TIMEOUT_MS } from "../http.ts";
import { defineCommand, type CommandContext } from "../registry.ts";
import { table, timeText } from "../text.ts";
import { newestFirst, PROJECT_ID, TEXT_ROWS } from "./deployments.ts";

const MARKER_MEDIA_TYPE = "application/json";
const MARKER_ID_PREFIX = "v-";
const MAX_MARKER_REPLY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 1000;

export interface DeployMarkPayload {
  readonly created: boolean;
  readonly marker: ServiceMarker;
}

export interface ServicesPayload {
  readonly services: readonly Service[];
}

export interface ServiceDeploymentsPayload {
  readonly service: string;
  readonly deployments: readonly { readonly deployment: Deployment; readonly markerId: string; readonly hostIds: readonly string[] }[];
}

interface ServiceCredential {
  readonly token: string;
  readonly hostIds: readonly string[] | null;
}

export function readServiceCredential(file: string, service: string): ServiceCredential {
  const credential = readCredentialJson(file, "name and token");
  if (credential.fields["name"] !== service) throw authError("credential_file_service", `${credential.path} is the credential for service ${JSON.stringify(credential.fields["name"] ?? null)}, not ${service}`);
  const token = credentialToken(credential);
  const hosts = credential.fields["hostIds"];
  if (hosts === undefined) return { token, hostIds: null };
  if (!Array.isArray(hosts) || !hosts.every((id): id is string => typeof id === "string" && HOST_ID.test(id))) throw authError("credential_file_invalid", `${credential.path} has invalid hostIds`);
  return { token, hostIds: hosts };
}

export function defaultMarkerId(version: string): string {
  const markerId = `${MARKER_ID_PREFIX}${version}`;
  if (!MARKER_ID.test(markerId)) throw usageError(`--version ${version} cannot be turned into a marker id (no "+", at most 126 characters); pass --marker-id`);
  return markerId;
}

function requireService(context: CommandContext): string {
  const service = context.option("service");
  if (service === undefined || !PROJECT_ID.test(service)) throw usageError("--service must be a service name such as stats-node");
  return service;
}

function hostList(raw: string): string[] {
  const hosts = raw.split(",");
  if (!hosts.every(host => HOST_ID.test(host)) || new Set(hosts).size !== hosts.length) throw usageError("--host must be distinct host ids (h_ and 32 hex digits), comma-separated");
  return hosts.sort();
}

function isHtml(response: Response, body: Uint8Array): boolean {
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return true;
  const head = new TextDecoder().decode(body.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function errorCode(body: Uint8Array): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { error?: { code?: unknown; message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === "string" && /^[\x20-\x7e]{1,200}$/u.test(message) ? `: ${message}` : "";
  } catch {
    return "";
  }
}

async function postMarker(context: CommandContext, service: string, token: string, body: string): Promise<{ readonly status: number; readonly value: DeployMarkPayload }> {
  const path = `/api/v1/services/${service}/deployments`;
  const target = new URL(path, context.origin);
  if (target.origin !== context.origin) throw new TypeError("request would leave the configured origin");
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": MARKER_MEDIA_TYPE, accept: "application/json" },
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([context.signal, timeout])
    });
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    if (context.signal.aborted) throw transportError("cancelled", "request cancelled");
    if (timeout.aborted) throw transportError("timeout", `marker request exceeded ${REQUEST_TIMEOUT_MS} ms`);
    throw transportError("network", "marker request failed before a response");
  }
  const { status } = response;
  const challenged = (status >= 300 && status < 400) || ((status === 200 || status === 401 || status === 403) && isHtml(response, bytes));
  if (challenged) throw authError("access_challenge", `${path} answered ${status}, an Access challenge or login page, so the request never reached the Worker; the path needs a Bypass Access application on ${context.origin}`);
  if (status === 401 || status === 403) throw authError("marker_unauthorized", `${path} answered ${status}${errorCode(bytes)}; the deploy token was refused`);
  if (status === 409) throw new CommandError(EXIT.usage, "marker_conflict", `${path} answered 409${errorCode(bytes)}; this marker id was recorded with a different version, message, or host set; use a new --marker-id`);
  if (status === 400 || status === 413 || status === 415) throw usageError(`${path} answered ${status}${errorCode(bytes)}`);
  if (status === 404) throw transportError("not_found", `${path} answered 404`);
  if (status !== 200 && status !== 201) throw transportError(`http_${status}`, `${path} answered ${status}${errorCode(bytes)}`);
  if (bytes.length > MAX_MARKER_REPLY_BYTES) throw transportError("body_too_large", `${path} reply is larger than ${MAX_MARKER_REPLY_BYTES} bytes`);
  try {
    return { status, value: { created: status === 201, marker: decodeServiceMarker(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), service) } };
  } catch (error) {
    throw transportError("contract", `${path} did not return a marker: ${error instanceof Error ? error.message : "invalid response"}`);
  }
}

export const deployMarkCommand = defineCommand<DeployMarkPayload>({
  name: "deploy mark",
  summary: "record a deployment marker for a service",
  description: [
    "MUTATION: writes one deployment marker for the named service. POSTs {markerId, version, message, hostIds} to /api/v1/services/NAME/deployments and prints the stored marker.",
    "The service deploy token comes from the token file, the JSON returned once when the service was created, and is sent only to the configured origin in the Authorization header. No Access or other credential is sent, on either target.",
    "The marker id defaults to v-VERSION, so repeating a deploy is idempotent. Exit 0 when the marker was recorded (201) and when an identical marker already existed (200, created false). A marker id already recorded with a different version, message, or host set exits 2 with marker_conflict. Use a new --marker-id to record another deploy of the same version.",
    "Exit 3 when the token file or the token is refused, or when an Access challenge intercepts the request (access_challenge). Exit 4 on transport failure."
  ],
  access: "mutation",
  targets: ["cloudflare", "node"],
  options: {
    service: { type: "string", placeholder: "NAME", required: true, description: "service name, as created through POST /api/v1/admin/services" },
    version: { type: "string", placeholder: "V", required: true, description: "what was deployed: a commit, tag, or semver (1-128 of A-Za-z0-9._:+-, starting with a letter or digit)" },
    message: { type: "string", placeholder: "TEXT", description: `free text shown on the timeline, at most ${MAX_MESSAGE_CHARS} characters` },
    host: { type: "string", placeholder: "ID[,ID...]", description: "host ids the deploy reached, comma-separated (default: every host of the service, from the token file)" },
    "marker-id": { type: "string", placeholder: "ID", description: "idempotency key (default: v-VERSION)" },
    "token-file": { type: "string", placeholder: "FILE", required: true, description: "service creation response JSON {name, hostIds, ..., token}, mode 0600; never passed in argv" }
  },
  examples: ["statsctl deploy mark --service stats-node --version 9df651c1a2b3 --message 'make node-deploy' --token-file .work/credentials/stats-node-deploy.json --origin http://threadripper.tailcf741.ts.net:18790"],
  limitations: [
    "Markers older than 30 days are dropped by the server.",
    "On Cloudflare the marker path must bypass Access, as /ingest/* does; otherwise the request fails with access_challenge."
  ],
  async run(context) {
    const service = requireService(context);
    const version = context.option("version");
    if (version === undefined || !MARKER_VERSION.test(version)) throw usageError("--version must be 1-128 letters, digits, or ._:+- starting with a letter or digit");
    const message = context.option("message");
    if (message !== undefined && message.length > MAX_MESSAGE_CHARS) throw usageError(`--message must be at most ${MAX_MESSAGE_CHARS} characters`);
    const explicitMarker = context.option("marker-id");
    if (explicitMarker !== undefined && !MARKER_ID.test(explicitMarker)) throw usageError("--marker-id must be 1-128 letters, digits, or ._:- starting with a letter or digit");
    const markerId = explicitMarker ?? defaultMarkerId(version);
    const explicitHosts = context.option("host");
    const credential = readServiceCredential(context.option("token-file") ?? "", service);
    const hostIds = explicitHosts === undefined ? credential.hostIds : hostList(explicitHosts);
    if (hostIds === null) throw usageError("the token file has no hostIds; pass --host");
    const body = JSON.stringify({ markerId, version, ...(message === undefined ? {} : { message }), hostIds });
    const { value } = await postMarker(context, service, credential.token, body);
    return { payload: value, identities: { deploymentIds: [value.marker.deployment.id], versionIds: [version] } };
  },
  render({ created, marker }) {
    const version = marker.deployment.versions[0]?.id ?? "";
    return [
      `${created ? "recorded" : "already recorded"} ${marker.service} ${version} (marker ${marker.markerId}, deployment ${marker.deployment.id}) at ${timeText(marker.deployment.atMs)}`,
      `hosts: ${marker.hostIds.join(" ")}`
    ];
  }
});

export const servicesCommand = defineCommand<ServicesPayload>({
  name: "services",
  summary: "list the services that report deployment markers",
  description: ["Lists every service with its hosts, health URL, and unit. Deploy tokens are never listed."],
  access: "read",
  targets: ["cloudflare", "node"],
  options: {},
  examples: ["statsctl services", "statsctl services --json --origin http://threadripper.tailcf741.ts.net:18790"],
  limitations: ["Services are created through POST /api/v1/admin/services; see docs/operations.md."],
  async run(context) {
    const fetched = await context.http.getJson("/api/v1/services", decodeServices);
    if (fetched.kind !== "ok") throw transportError("contract", "/api/v1/services answered not-modified to an unconditional request");
    return { payload: { services: fetched.value } };
  },
  render({ services }) {
    if (services.length === 0) return ["no services configured"];
    return table([["service", "hosts", "unit", "health url"], ...services.map(item => [item.name, String(item.hostIds.length), item.unit ?? "-", item.healthUrl ?? "-"])]);
  }
});

export const serviceDeploymentsCommand = defineCommand<ServiceDeploymentsPayload>({
  name: "service deployments",
  summary: "list a service's deployment markers",
  description: ["Lists the service's markers newest first with version, message, and hosts. Markers are kept for 30 days."],
  access: "read",
  targets: ["cloudflare", "node"],
  options: { service: { type: "string", placeholder: "NAME", required: true, description: "service name from `statsctl services`" } },
  examples: ["statsctl service deployments --service stats-node", "statsctl service deployments --service stats-node --json"],
  limitations: [`Text output shows the newest ${TEXT_ROWS} markers; --json carries all of them.`],
  async run(context) {
    const service = requireService(context);
    const path = `/api/v1/services/${encodeURIComponent(service)}/deployments`;
    const fetched = await context.http.getJson(path, value => decodeServiceDeploymentHistory(value, service));
    if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
    const markers = new Map(fetched.value.markers.map(marker => [marker.deploymentId, marker]));
    const deployments = newestFirst(fetched.value.deployments).map(deployment => {
      const marker = markers.get(deployment.id)!;
      return { deployment, markerId: marker.markerId, hostIds: marker.hostIds };
    });
    return {
      payload: { service, deployments },
      identities: { deploymentIds: deployments.map(item => item.deployment.id), versionIds: [...new Set(deployments.map(item => item.deployment.versions[0]?.id ?? ""))] }
    };
  },
  render({ service, deployments }) {
    if (deployments.length === 0) return [`no deployment markers recorded for ${service}`];
    const shown = deployments.slice(0, TEXT_ROWS);
    const lines = [`deployment markers for ${service}`, ...table([
      ["deployment", "time", "version", "marker", "hosts", "message"],
      ...shown.map(item => [item.deployment.id, timeText(item.deployment.atMs), item.deployment.versions[0]?.id ?? "", item.markerId, String(item.hostIds.length), item.deployment.message ?? ""])
    ])];
    if (deployments.length > shown.length) lines.push(`${deployments.length - shown.length} older markers omitted; use --json for all`);
    return lines;
  }
});
