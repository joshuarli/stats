import { previousWindowOf } from "../cost/ledger.ts";
import { utcMonthOf } from "../cost/report.ts";
import type { TimeWindow } from "../client/chart-data.ts";
import type { MetricHistory } from "../client/history.ts";
import { settledWindow } from "../client/project-ledger.ts";
import { HOUR_MS, RANGE_MS, RANGES, type RangeKey } from "../limits.ts";
import { CommandError, EXIT, usageError } from "./exit.ts";

export type WindowRequest =
  | { readonly kind: "settled"; readonly range: RangeKey }
  | { readonly kind: "explicit"; readonly window: TimeWindow }
  | { readonly kind: "month-to-date" };

export interface ResolvedWindows {
  readonly current: TimeWindow;
  readonly previous: TimeWindow;
  readonly monthToDate: boolean;
}

export interface WindowOptions {
  readonly window: string | undefined;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly monthToDate: boolean;
}

const EPOCH_MS = /^[0-9]{1,15}$/u;
const MAX_SPAN_MS = RANGE_MS["30d"];

function rangeOf(value: string): RangeKey {
  const found = RANGES.find(range => range === value);
  if (found === undefined) throw usageError(`--window must be one of ${RANGES.join(", ")}`);
  return found;
}

function epochMs(value: string, flag: string): number {
  if (!EPOCH_MS.test(value)) throw usageError(`--${flag} must be epoch milliseconds, digits only`);
  return Number(value);
}

export function parseWindowRequest(options: WindowOptions): WindowRequest {
  if (options.monthToDate) return { kind: "month-to-date" };
  if (options.from !== undefined && options.to !== undefined) {
    const window = { fromMs: epochMs(options.from, "from"), toMs: epochMs(options.to, "to") };
    if (window.fromMs >= window.toMs) throw usageError("--from must be before --to");
    if (window.toMs - window.fromMs > MAX_SPAN_MS) throw usageError("the window may span at most 30 days");
    return { kind: "explicit", window };
  }
  return { kind: "settled", range: rangeOf(options.window ?? "1h") };
}

export function probeRange(request: WindowRequest): RangeKey | null {
  switch (request.kind) {
    case "settled": return request.range;
    case "month-to-date": return "1h";
    case "explicit": return null;
  }
}

export function resolveWindows(request: WindowRequest, worker: MetricHistory | null): ResolvedWindows {
  if (request.kind === "explicit") return { current: request.window, previous: previousWindowOf(request.window), monthToDate: false };
  if (worker === null) throw new TypeError("a settled window needs the worker history");
  if (request.kind === "settled") {
    const current = settledWindow(worker, RANGE_MS[request.range], null);
    return { current, previous: previousWindowOf(current), monthToDate: false };
  }
  const settledMs = settledWindow(worker, HOUR_MS, null).toMs;
  const month = utcMonthOf(settledMs);
  const current = { fromMs: month.fromMs, toMs: settledMs };
  if (current.toMs <= current.fromMs) throw new CommandError(EXIT.pending, "month_not_settled", "no bucket of the current UTC month has settled yet");
  if (current.toMs - current.fromMs > MAX_SPAN_MS) throw usageError("the UTC month so far spans more than the 30 days the history route serves; use --from and --to");
  return { current, previous: previousWindowOf(current), monthToDate: true };
}
