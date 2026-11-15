import type { OperationInput } from "../../producer/src/index.ts";
import { SQLITE_OPERATIONS, type ActorRole } from "./contract.ts";

export interface BridgePolicy {
  readonly resourceService: string;
  readonly openorangeVersion: string;
  readonly rivetkitVersion: string;
  readonly samplePpm: number;
  readonly actors: readonly { readonly role: ActorRole; readonly name: string; readonly key: string }[];
}
export interface ProjectedBatch {
  readonly events: readonly OperationInput[];
  readonly received: number;
  readonly filtered: number;
  readonly invalid: number;
}
const TRACE = /^(?!0{32})[a-f0-9]{32}$/u;
const SPAN = /^(?!0{16})[a-f0-9]{16}$/u;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/u;
const NS = /^\d{1,20}$/u;
const MAX_SPANS = 256;
const ATTRIBUTES = new Set(["service.name", "service.version", "openorange.version", "rivetkit.version", "rivet.actor.name", "rivet.actor.key", "http.response.status_code"]);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function attributes(value: unknown): ReadonlyMap<string, string> | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result = new Map<string, string>();
  for (const entry of value) {
    if (!record(entry) || typeof entry["key"] !== "string" || !ATTRIBUTES.has(entry["key"])) continue;
    const raw = entry["value"];
    if (!record(raw)) return null;
    const text = raw["stringValue"] ?? raw["intValue"];
    if (typeof text !== "string" || text.length > 256 || result.has(entry["key"])) return null;
    result.set(entry["key"], text);
  }
  return result;
}
export function validatePolicy(policy: BridgePolicy): void {
  if (!RELEASE.test(policy.resourceService) || !RELEASE.test(policy.openorangeVersion) || !RELEASE.test(policy.rivetkitVersion) || !Number.isInteger(policy.samplePpm) || policy.samplePpm < 1 || policy.samplePpm > 1_000_000) throw new TypeError("invalid platform bridge policy");
  if (policy.actors.length !== 2 || new Set(policy.actors.map(actor => actor.role)).size !== 2) throw new TypeError("both Stats actor roles are required");
  for (const actor of policy.actors) {
    const prefix = actor.role === "installation" ? "installation-" : actor.role === "observation" ? "observation-store-" : null;
    if (prefix === null || !new RegExp(`^${prefix}[a-f0-9]{8}$`, "u").test(actor.name) || !/^[a-f0-9]{64}$/u.test(actor.key)) throw new TypeError("invalid Stats actor selector");
  }
}
export function projectBatch(value: unknown, policy: BridgePolicy): ProjectedBatch {
  if (!record(value) || !Array.isArray(value["resourceSpans"]) || value["resourceSpans"].length > 32) throw new TypeError("invalid OTLP envelope");
  const events: OperationInput[] = [];
  let received = 0, filtered = 0, invalid = 0;
  for (const resource of value["resourceSpans"]) {
    if (!record(resource) || !record(resource["resource"]) || !Array.isArray(resource["scopeSpans"]) || resource["scopeSpans"].length > 32) throw new TypeError("invalid OTLP resource");
    const tags = attributes(resource["resource"]["attributes"]);
    for (const scope of resource["scopeSpans"]) {
      if (!record(scope) || !record(scope["scope"]) || !Array.isArray(scope["spans"])) throw new TypeError("invalid OTLP scope");
      received += scope["spans"].length;
      if (received > MAX_SPANS) throw new RangeError("OTLP span cap exceeded");
      for (const raw of scope["spans"]) {
        if (tags?.get("service.name") !== policy.resourceService || tags.get("rivetkit.version") !== policy.rivetkitVersion || tags.get("openorange.version") !== policy.openorangeVersion || scope["scope"]["name"] !== "rivetkit") { filtered++; continue; }
        if (!record(raw)) { invalid++; continue; }
        const attrs = attributes(raw["attributes"]);
        const actor = policy.actors.find(candidate => candidate.name === attrs?.get("rivet.actor.name") && candidate.key === attrs.get("rivet.actor.key"));
        if (actor === undefined) { filtered++; continue; }
        const name = raw["name"];
        const sqlite = typeof name === "string" && name.startsWith("rivet.sqlite.") ? name.slice("rivet.sqlite.".length) : null;
        const operation = name === `${actor.name}/onRequest` ? `platform.${actor.role}.invoke` : sqlite !== null && SQLITE_OPERATIONS.some(allowed => allowed === sqlite) ? `platform.${actor.role}.sqlite.${sqlite}` : null;
        if (operation === null) { filtered++; continue; }
        const { traceId, spanId, startTimeUnixNano: start, endTimeUnixNano: end } = raw;
        const sourceRelease = tags.get("service.version");
        const release = `${sourceRelease}_oo-${policy.openorangeVersion}_rk-${policy.rivetkitVersion}`;
        if (typeof traceId !== "string" || !TRACE.test(traceId) || typeof spanId !== "string" || !SPAN.test(spanId) || typeof start !== "string" || !NS.test(start) || typeof end !== "string" || !NS.test(end) || sourceRelease === undefined || !RELEASE.test(release)) { invalid++; continue; }
        const startNs = BigInt(start), durationNs = BigInt(end) - startNs;
        const atMs = Number(startNs / 1_000_000n);
        if (!Number.isSafeInteger(atMs) || atMs <= 0 || durationNs < 0n || durationNs > 86_400_000_000_000n) { invalid++; continue; }
        const durationUs = Number((durationNs + 500n) / 1000n);
        const status = raw["status"];
        const failed = (record(status) && status["code"] === 2) || /^[5][0-9]{2}$/u.test(attrs?.get("http.response.status_code") ?? "");
        events.push({ eventId: `${traceId}-${spanId}`, atMs, operation, release, outcome: failed ? "error" : "ok", durationMs: Math.round(durationUs / 1000), work: { duration_us: durationUs, sample_ppm: policy.samplePpm }, trace: { traceId, spanId }, ...(failed ? { errorCode: sqlite === null ? "platform.actor.failed" : "platform.sqlite.failed" } : {}) });
      }
    }
  }
  return { events, received, filtered, invalid };
}
