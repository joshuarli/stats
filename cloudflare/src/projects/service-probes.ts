import type { ProbeFetch } from "./probes.ts";

export type ProbeStatus = "ok" | "degraded" | "down";
export interface ServiceProbeResult {
  readonly status: ProbeStatus;
  readonly httpStatus: number | null;
  readonly ms: number;
  readonly atMs: number;
  readonly checks: readonly { readonly name: string; readonly status: "degraded" | "down" }[];
  readonly reason: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function status(value: unknown): value is ProbeStatus {
  return value === "ok" || value === "degraded" || value === "down";
}

export function decodeHealthBody(value: unknown, name: string): { status: ProbeStatus; checks: ServiceProbeResult["checks"] } | null {
  if (!object(value) || value["service"] !== name || !status(value["status"]) || !object(value["checks"]) || (value["release"] !== undefined && typeof value["release"] !== "string")) return null;
  if (Object.keys(value).some(key => !["status", "service", "release", "checks"].includes(key))) return null;
  const checks: { name: string; status: "degraded" | "down" }[] = [];
  for (const [checkName, check] of Object.entries(value["checks"])) {
    if (checkName.length === 0 || !object(check) || Object.keys(check).some(key => !["status", "ms", "detail"].includes(key)) || !status(check["status"]) || (check["ms"] !== undefined && (!Number.isSafeInteger(check["ms"]) || (check["ms"] as number) < 0)) || (check["detail"] !== undefined && (typeof check["detail"] !== "string" || check["detail"].length > 256))) return null;
    if (check["status"] !== "ok") checks.push({ name: checkName, status: check["status"] });
  }
  return { status: value["status"], checks };
}

export async function probeService(input: { readonly name: string; readonly url: string; readonly fetch: ProbeFetch; readonly now: number; readonly clock?: () => number; readonly signal?: AbortSignal }): Promise<ServiceProbeResult> {
  const clock = input.clock ?? Date.now;
  const start = clock();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 2000);
  const signal = input.signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, input.signal]);
  let httpStatus: number | null = null;
  let result: { status: ProbeStatus; checks: ServiceProbeResult["checks"] } | null = null;
  let reason: string | null = null;
  let reader: ReadableStreamBYOBReader | undefined;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("aborted"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const request = input.fetch(input.url, { method: "GET", redirect: "manual", signal });
    void request.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => { console.error("service probe cancellation failed"); }); }, () => undefined);
    const response = await Promise.race([request, aborted]);
    httpStatus = response.status;
    if (response.status !== 200 && response.status !== 503) {
      reason = `http ${response.status}`;
      if (response.body !== null) await Promise.race([response.body.cancel(), aborted]);
    } else if (response.body?.getReader === undefined) {
      reason = response.status === 200 ? "invalid body" : `http ${response.status}`;
      if (response.body !== null) await Promise.race([response.body.cancel(), aborted]);
    } else {
      const streamReader = response.body.getReader({ mode: "byob" });
      reader = streamReader;
      const chunks: Uint8Array[] = [];
      let size = 0;
      let complete = false;
      while (size < 4096) {
        const item = await Promise.race([streamReader.read(new Uint8Array(4096 - size)), aborted]);
        if (item.done) break;
        size += item.value.length;
        chunks.push(item.value);
      }
      if (size < 4096) complete = true;
      else {
        complete = await new Promise<boolean>(resolve => {
          const abort = () => resolve(false);
          signal.addEventListener("abort", abort, { once: true });
          void streamReader.closed.then(() => { signal.removeEventListener("abort", abort); resolve(true); }, () => { signal.removeEventListener("abort", abort); resolve(false); });
          if (signal.aborted) abort();
        });
      }
      if (complete) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        try { result = decodeHealthBody(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, input.name); } catch { result = null; }
      } else await Promise.race([streamReader.cancel(), aborted]);
      if (response.status !== 200) reason = `http ${response.status}`;
      else if (result === null || result.status === "down") reason = "invalid body";
    }
  } catch {
    if (reader !== undefined) void reader.cancel().catch(() => { console.error("service probe cancellation failed"); });
    reason = timeout.signal.aborted ? "timeout" : "connection error";
  } finally {
    clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
  return { status: httpStatus === 200 && (result?.status === "ok" || result?.status === "degraded") ? result.status : "down", httpStatus, ms: Math.max(0, Math.round(clock() - start)), atMs: input.now, checks: result?.checks ?? [], reason };
}
