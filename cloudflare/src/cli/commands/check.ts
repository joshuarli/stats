import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { decodeAck, AckDecodeError } from "../../ingest/ack-decode.ts";
import { ACK_MEDIA_TYPE, type Ack } from "../../ingest/ack.ts";
import { encodeFrame } from "../../ingest/encode.ts";
import { openHistory } from "../../binary/history.ts";
import { decodeSummary } from "../../client/history.ts";
import { MINUTE_MS } from "../../limits.ts";
import { authError, CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { defineCommand, type CommandContext } from "../registry.ts";
import { resolveInvocationPath } from "../verify/files.ts";
import { table } from "../text.ts";

export const INGEST_MEDIA_TYPE = "application/vnd.stats.ingest.v2";
export const INGEST_TIMEOUT_MS = 15_000;
const HOST_ID = /^h_[0-9a-f]{32}$/u;
const MAX_CREDENTIAL_FILE_BYTES = 4096;
const MAX_INGEST_REPLY_BYTES = 64 * 1024;

export const STEP_NAMES = ["encode", "ingest", "ack", "latest", "history", "replay", "stored-count"] as const;
export type StepName = (typeof STEP_NAMES)[number];

export interface Step {
  readonly name: StepName;
  readonly ok: boolean;
  readonly ms: number;
  readonly code: string | null;
  readonly detail: string;
}

export interface CheckIngestPayload {
  readonly ok: boolean;
  readonly hostId: string;
  readonly seq: string;
  readonly atMs: number;
  readonly steps: readonly Step[];
}

interface HostCredential {
  readonly hostId: string;
  readonly token: string;
}

export function readCredentialFile(file: string): HostCredential {
  const path = resolveInvocationPath(file);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw authError("credential_file_unreadable", `cannot open the credential file ${path}`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw authError("credential_file_unreadable", `${path} is not a regular file`);
    if ((stat.mode & 0o077) !== 0) throw authError("credential_file_mode", `${path} must not be readable by group or others; run: chmod 600 ${path}`);
    if (stat.size > MAX_CREDENTIAL_FILE_BYTES) throw authError("credential_file_invalid", `${path} is larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch {
      throw authError("credential_file_invalid", `${path} is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null) throw authError("credential_file_invalid", `${path} must be a JSON object with hostId and token`);
    const { hostId, token } = parsed as Record<string, unknown>;
    if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw authError("credential_file_invalid", `${path} has no valid hostId`);
    if (typeof token !== "string" || token === "" || /[^!-~]/u.test(token)) throw authError("credential_file_invalid", `${path} has no valid token`);
    return { hostId, token };
  } finally {
    closeSync(descriptor);
  }
}

function bootIdFor(hostId: string): string {
  const hex = createHash("sha256").update(`statsctl-check-ingest:${hostId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function syntheticFrame(hostId: string, atMs: number): { readonly frame: Uint8Array; readonly seq: bigint } {
  const tick = String(atMs);
  const frame = encodeFrame({
    hostId,
    bootId: bootIdFor(hostId),
    samples: [{
      seq: tick,
      atMs: tick,
      monoMs: tick,
      cpu: { user: tick, system: tick, idle: String(atMs * 7), iowait: tick, steal: "0", total: String(atMs * 10) }
    }]
  });
  return { frame, seq: BigInt(atMs) };
}

type IngestReply =
  | { readonly kind: "ack"; readonly ack: Ack }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string };

async function post(context: CommandContext, credential: HostCredential, frame: Uint8Array, seq: bigint): Promise<IngestReply> {
  const target = new URL("/ingest/v2/batches", context.origin);
  if (target.origin !== context.origin) throw new TypeError("request would leave the configured origin");
  const timeout = AbortSignal.timeout(INGEST_TIMEOUT_MS);
  let response: Response;
  let body: Uint8Array;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": INGEST_MEDIA_TYPE, accept: ACK_MEDIA_TYPE },
      body: frame as Uint8Array<ArrayBuffer>,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([context.signal, timeout])
    });
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    if (context.signal.aborted) throw transportError("cancelled", "request cancelled");
    if (timeout.aborted) throw transportError("timeout", `ingest request exceeded ${INGEST_TIMEOUT_MS} ms`);
    throw transportError("network", "ingest request failed before a response");
  }
  const { status } = response;
  if (status === 401 || status === 403) throw authError("ingest_unauthorized", `${target.pathname} answered ${status}; the host token was refused`);
  if (status >= 300 && status < 400) return { kind: "failed", code: `http_${status}`, detail: `${target.pathname} answered a redirect that is not followed` };
  if (status !== 200) return { kind: "failed", code: `http_${status}`, detail: `${target.pathname} answered ${status}${errorCode(body)}` };
  if (response.headers.get("content-type") !== ACK_MEDIA_TYPE) return { kind: "failed", code: "ack_media_type", detail: "the acknowledgment has the wrong content type" };
  if (body.length > MAX_INGEST_REPLY_BYTES) return { kind: "failed", code: "ack_invalid", detail: "the acknowledgment is too large" };
  try {
    return { kind: "ack", ack: decodeAck(body, [seq]) };
  } catch (error) {
    if (error instanceof AckDecodeError) return { kind: "failed", code: "ack_invalid", detail: error.message };
    throw error;
  }
}

function errorCode(body: Uint8Array): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" && /^[a-z_]{1,40}$/u.test(parsed.error.code) ? ` (${parsed.error.code})` : "";
  } catch {
    return "";
  }
}

class StepFailure extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

interface Stored {
  readonly latestSeq: string;
  readonly rows: number;
  readonly hasSample: boolean;
}

export const checkIngestCommand = defineCommand<CheckIngestPayload>({
  name: "check ingest",
  summary: "send one known sample through production ingest and read it back",
  description: [
    "MUTATION: writes one real sample. Encodes one sample with a fresh sequence and time, POSTs it, expects accepted 1, reads it back from the latest-sample route and the host history, re-POSTs the identical bytes and expects duplicate 1, and confirms the stored count did not change.",
    "The host token comes from the credential file and is sent only to the configured origin, in the Authorization header of the two ingest requests. Reads use the usual Access credential on the Cloudflare origin and no credential on a tailnet origin, where tailscale serve adds the identity.",
    "Exit 0 when every step passes, 7 when a step fails (the failing step and its reason code are printed), 3 when the credential file or the host token is refused, 4 on transport failure.",
    "Use only with the synthetic-check host credential."
  ],
  access: "mutation",
  targets: ["cloudflare", "node"],
  options: {
    "credential-file": { type: "string", placeholder: "FILE", required: true, description: "host credential JSON {hostId, token} as returned by POST /api/v1/admin/hosts, mode 0600; never passed in argv" }
  },
  examples: ["statsctl check ingest --credential-file .work/credentials/synthetic-check.json --json"],
  limitations: [
    "The Worker allows 6 ingest requests per host per minute; one run makes 2, so run it at most twice a minute per host.",
    "The sample uses the current time as its sequence, so two runs in the same millisecond collide and the second reports a duplicate where accepted was expected."
  ],
  async run(context) {
    const path = context.option("credential-file");
    if (path === undefined) throw usageError("missing required option --credential-file");
    const credential = readCredentialFile(path);
    const atMs = context.now();
    const steps: Step[] = [];
    let failed = false;

    async function step<T>(name: StepName, body: () => Promise<T>, detail: (value: T) => string): Promise<T | undefined> {
      if (failed) return undefined;
      const started = performance.now();
      const ms = () => Math.round((performance.now() - started) * 10) / 10;
      try {
        const value = await body();
        steps.push({ name, ok: true, ms: ms(), code: null, detail: detail(value) });
        return value;
      } catch (error) {
        if (!(error instanceof StepFailure)) throw error;
        failed = true;
        steps.push({ name, ok: false, ms: ms(), code: error.reason, detail: error.message });
        return undefined;
      }
    }

    const { hostId } = credential;
    const sent = await step("encode", async () => syntheticFrame(hostId, atMs), value => `${value.frame.length} bytes, seq ${value.seq}`);
    const seq = sent?.seq ?? 0n;
    const first = await step("ingest", async () => {
      const reply = await post(context, credential, sent!.frame, seq);
      if (reply.kind === "failed") throw new StepFailure(reply.code, reply.detail);
      return reply.ack;
    }, () => "request accepted by the Worker");
    await step("ack", async () => {
      if (first!.rejected.length > 0) throw new StepFailure(`rejected_${first!.rejected[0]!.code}`, `the sample was rejected: ${first!.rejected.map(item => item.code).join(", ")}`);
      if (first!.accepted !== 1 || first!.duplicates !== 0) throw new StepFailure("not_accepted", `expected accepted 1 and duplicates 0, got accepted ${first!.accepted} and duplicates ${first!.duplicates}`);
      return first!;
    }, () => "accepted 1, duplicates 0");

    const fromMs = Math.floor(atMs / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
    const toMs = atMs + 2 * MINUTE_MS;
    const read = async (): Promise<Stored> => {
      const latest = await context.http.getJson(`/api/v1/hosts/${hostId}/latest`, decodeLatest).catch(missing("latest_missing", "the host has no readable latest sample"));
      const history = await context.http.getBytes(`/api/v1/hosts/${hostId}/history?from=${fromMs}&to=${toMs}&kind=summary`).catch(missing("history_missing", "the host history is not readable"));
      if (latest.kind !== "ok" || history.kind !== "ok") throw transportError("contract", "an unconditional read answered not-modified");
      let times: readonly number[];
      try {
        times = decodeSummary(openHistory(history.value).root).table.times;
      } catch {
        throw new StepFailure("history_invalid", "the host history is not a valid summary frame");
      }
      return { latestSeq: latest.value, rows: times.length, hasSample: times.includes(atMs) };
    };
    const before = await step("latest", async () => {
      const stored = await read();
      if (stored.latestSeq !== String(seq)) throw new StepFailure("latest_mismatch", `latest sample has seq ${stored.latestSeq}, expected ${seq}`);
      return stored;
    }, stored => `latest seq ${stored.latestSeq}`);
    await step("history", async () => {
      if (!before!.hasSample) throw new StepFailure("history_missing_sample", `history for [${fromMs}, ${toMs}) has ${before!.rows} rows and none at ${atMs}`);
      return before!.rows;
    }, rows => `${rows} rows in the window, including atMs ${atMs}`);
    await step("replay", async () => {
      const reply = await post(context, credential, sent!.frame, seq);
      if (reply.kind === "failed") throw new StepFailure(reply.code, reply.detail);
      if (reply.ack.rejected.length > 0 || reply.ack.accepted !== 0 || reply.ack.duplicates !== 1) {
        throw new StepFailure("not_duplicate", `expected accepted 0 and duplicates 1, got accepted ${reply.ack.accepted}, duplicates ${reply.ack.duplicates}, rejected ${reply.ack.rejected.length}`);
      }
      return reply.ack;
    }, () => "accepted 0, duplicates 1");
    await step("stored-count", async () => {
      const after = await read();
      if (after.latestSeq !== before!.latestSeq || after.rows !== before!.rows) {
        throw new StepFailure("count_changed", `latest seq ${before!.latestSeq} -> ${after.latestSeq}, history rows ${before!.rows} -> ${after.rows}`);
      }
      return after.rows;
    }, rows => `unchanged at ${rows} history rows`);

    const payload: CheckIngestPayload = { ok: !failed, hostId, seq: String(seq), atMs, steps };
    return { payload, exit: failed ? EXIT.regressed : EXIT.ok };
  },
  render(payload) {
    const lines = [`check ingest ${payload.ok ? "passed" : "FAILED"} for ${payload.hostId} (seq ${payload.seq})`];
    lines.push(...table(payload.steps.map(item => [item.ok ? "pass" : "FAIL", item.name, `${item.ms} ms`, item.code ?? "", item.detail])));
    return lines;
  }
});

function decodeLatest(value: unknown): string {
  const sample = (value as { sample?: { seq?: unknown } } | null)?.sample;
  if (typeof sample?.seq !== "string") throw new Error("invalid latest sample");
  return sample.seq;
}

function missing(reason: string, detail: string): (error: unknown) => never {
  return error => {
    if (error instanceof CommandError && error.code === "not_found") throw new StepFailure(reason, detail);
    throw error;
  };
}
