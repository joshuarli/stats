import { createContext, createSignal, useContext, type Accessor, type Setter } from "solid-js";
import type { HistoryQuery, Host } from "./api";
import { panWindow, type TimeWindow } from "./chart-data";
import { HOUR_MS, MINUTE_MS, MINUTE_RETENTION_MS, RAW_RETENTION_MS, RAW_STEP_MS, RANGES, RANGE_MS, type RangeKey } from "../limits";

export const ranges = RANGES;
export type Range = RangeKey;
export const rangeLabels: Record<Range, string> = {
  "1h": "Past 1 hour",
  "6h": "Past 6 hours",
  "24h": "Past 24 hours",
  "7d": "Past 7 days",
  "30d": "Past 30 days"
};
export const rangeMs = RANGE_MS;
export const LIVE_INTERVAL_MS = 15_000;
export const PROJECT_REFRESH_TICKS = 20;

export interface ViewState {
  readonly view: Accessor<TimeWindow | null>;
  readonly canZoomOut: Accessor<boolean>;
  readonly live: Accessor<boolean>;
  readonly tick: Accessor<number>;
  readonly manualTick: Accessor<number>;
  readonly zoomTo: (window: TimeWindow) => boolean;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly pan: (direction: -1 | 1) => void;
  readonly toggleLive: () => void;
  readonly autoRefresh: () => void;
  readonly requestRefresh: () => void;
}

type ViewMode =
  | { readonly kind: "live" }
  | { readonly kind: "paused" }
  | { readonly kind: "zoomed"; readonly window: TimeWindow };

export interface TelemetryState extends ViewState {
  readonly range: Accessor<Range>;
  readonly query: Accessor<HistoryQuery>;
  readonly setRange: Setter<Range>;
  readonly showWindow: (window: TimeWindow) => boolean;
  readonly now: Accessor<number>;
  readonly hosts: Accessor<readonly Host[]>;
  readonly refreshHosts: () => Promise<void>;
}

export function smallestRangeCovering(fromMs: number, now: number): Range {
  return ranges.find(candidate => rangeMs[candidate] >= now - fromMs) ?? ranges[ranges.length - 1]!;
}

export function minimumZoomMs(fromMs: number, now: number): number {
  const ageMs = now - fromMs;
  if (ageMs < RAW_RETENTION_MS) return 2 * RAW_STEP_MS;
  if (ageMs < MINUTE_RETENTION_MS) return 2 * MINUTE_MS;
  return 2 * HOUR_MS;
}

export function createViewState(range: Accessor<Range>, now: Accessor<number>): ViewState {
  const [mode, setMode] = createSignal<ViewMode>({ kind: "live" });
  const [trail, setTrail] = createSignal<readonly ViewMode[]>([]);
  const [tick, setTick] = createSignal(0);
  const [manualTick, setManualTick] = createSignal(0);

  const view = () => {
    const current = mode();
    return current.kind === "zoomed" ? current.window : null;
  };
  const live = () => mode().kind === "live";

  const resetZoom = () => {
    if (mode().kind === "live" && trail().length === 0) return;
    setMode({ kind: "live" });
    setTrail([]);
  };

  return {
    view,
    canZoomOut: () => trail().length > 0,
    live,
    tick,
    manualTick,
    zoomTo: window => {
      if (window.toMs - window.fromMs < minimumZoomMs(window.fromMs, now())) return false;
      setTrail(entries => [...entries, mode()]);
      setMode({ kind: "zoomed", window });
      return true;
    },
    zoomOut: () => {
      const entries = trail();
      const previous = entries.at(-1);
      if (previous === undefined) return;
      setMode(previous);
      setTrail(entries.slice(0, -1));
    },
    resetZoom,
    pan: direction => {
      const current = view();
      if (current === null) return;
      setMode({ kind: "zoomed", window: panWindow(current, direction, { fromMs: now() - rangeMs[range()], toMs: now() }) });
    },
    toggleLive: () => {
      if (mode().kind === "zoomed") {
        setMode({ kind: "live" });
        setTrail([]);
      } else {
        setMode(current => current.kind === "live" ? { kind: "paused" } : { kind: "live" });
      }
    },
    autoRefresh: () => setTick(value => value + 1),
    requestRefresh: () => {
      setTick(value => value + 1);
      setManualTick(value => value + 1);
    }
  };
}

export const TelemetryContext = createContext<TelemetryState>();

export function useTelemetry(): TelemetryState {
  return useContext(TelemetryContext);
}
