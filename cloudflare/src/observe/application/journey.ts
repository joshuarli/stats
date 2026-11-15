import { MAX_DURATION_MS, SPAN_ID, TRACE_ID } from "../ingest/model.ts";

export const UI_JOURNEY_PATH = "/api/v1/ui-journeys";
export const UI_JOURNEY_HEADER = "Stats-Ui-Observations";
export const MAX_UI_JOURNEY_BYTES = 4096;
const PHASES = new Set(["bootstrap_us", "fetch_us", "body_us", "decode_us", "health_us", "render_us", "dispatch_us", "store_us", "query_us", "issues_us", "read_us", "encode_us", "total_us"]);

export interface ProjectJourney {
  readonly schemaVersion: 1;
  readonly source: "navigation" | "range" | "refresh";
  readonly range: "1h" | "6h" | "24h" | "7d" | "30d";
  readonly cache: boolean;
  readonly outcome: "ok" | "error" | "cancelled";
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly trace: { readonly traceId: string; readonly spanId: string };
  readonly work: Readonly<Record<string, number>>;
}

export interface BrowserJourney extends ProjectJourney {
  readonly asset: string;
  readonly dropped: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts only bounded timing fields; client identity, release, URLs and arbitrary attributes are forbidden. */
export function decodeBrowserJourney(value: unknown, nowMs: number): BrowserJourney | null {
  if (!object(value) || Object.keys(value).length !== 11 || value["schemaVersion"] !== 1
    || typeof value["source"] !== "string" || !["navigation", "range", "refresh"].includes(value["source"])
    || typeof value["range"] !== "string" || !["1h", "6h", "24h", "7d", "30d"].includes(value["range"])
    || typeof value["outcome"] !== "string" || !["ok", "error", "cancelled"].includes(value["outcome"]) || typeof value["cache"] !== "boolean"
    || !Number.isSafeInteger(value["startedAtMs"]) || Math.abs(nowMs - Number(value["startedAtMs"])) > MAX_DURATION_MS
    || typeof value["durationMs"] !== "number" || !Number.isFinite(value["durationMs"]) || value["durationMs"] < 0 || value["durationMs"] > MAX_DURATION_MS
    || typeof value["asset"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value["asset"])
    || !Number.isSafeInteger(value["dropped"]) || Number(value["dropped"]) < 0 || Number(value["dropped"]) > 1e12
    || !object(value["trace"]) || Object.keys(value["trace"]).length !== 2
    || typeof value["trace"]["traceId"] !== "string" || !TRACE_ID.test(value["trace"]["traceId"])
    || typeof value["trace"]["spanId"] !== "string" || !SPAN_ID.test(value["trace"]["spanId"])
    || !object(value["work"]) || Object.entries(value["work"]).some(([key, entry]) => !PHASES.has(key) || !Number.isSafeInteger(entry) || Number(entry) < 0 || Number(entry) > MAX_DURATION_MS * 1000)) return null;
  return value as unknown as BrowserJourney;
}
