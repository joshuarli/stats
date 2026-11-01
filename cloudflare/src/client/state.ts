import { createContext, createSignal, useContext, type Accessor, type Setter } from "solid-js";
import type { HistoryQuery, Host } from "./api";
import { panWindow, type TimeWindow } from "./chart-data";

export const ranges = ["1h", "6h", "24h", "7d", "90d"] as const;
export type Range = (typeof ranges)[number];
export const rangeLabels: Record<Range, string> = {
  "1h": "Past 1 hour",
  "6h": "Past 6 hours",
  "24h": "Past 24 hours",
  "7d": "Past 7 days",
  "90d": "Past 90 days"
};
export const rangeMs: Record<Range, number> = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "90d": 7_776_000_000
};
export const LIVE_INTERVAL_MS = 15_000;

export interface ViewState {
  readonly view: Accessor<TimeWindow | null>;
  readonly canZoomOut: Accessor<boolean>;
  readonly live: Accessor<boolean>;
  readonly tick: Accessor<number>;
  readonly zoomTo: (window: TimeWindow) => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly pan: (direction: -1 | 1) => void;
  readonly toggleLive: () => void;
  readonly requestRefresh: () => void;
}

export interface TelemetryState extends ViewState {
  readonly range: Accessor<Range>;
  readonly query: Accessor<HistoryQuery>;
  readonly setRange: Setter<Range>;
  readonly now: Accessor<number>;
  readonly hosts: Accessor<readonly Host[]>;
  readonly refreshHosts: () => Promise<void>;
}

export function createViewState(range: Accessor<Range>, now: Accessor<number>): ViewState {
  const [view, setView] = createSignal<TimeWindow | null>(null);
  const [trail, setTrail] = createSignal<readonly (TimeWindow | null)[]>([]);
  const [live, setLive] = createSignal(true);
  const [tick, setTick] = createSignal(0);

  const resetZoom = () => {
    setView(null);
    setTrail([]);
    setLive(true);
  };

  return {
    view,
    canZoomOut: () => trail().length > 0,
    live,
    tick,
    zoomTo: window => {
      setTrail(entries => [...entries, view()]);
      setView(window);
      setLive(false);
    },
    zoomOut: () => {
      const entries = trail();
      if (entries.length === 0) return;
      setView(entries.at(-1) ?? null);
      setTrail(entries.slice(0, -1));
    },
    resetZoom,
    pan: direction => {
      const current = view();
      if (current === null) return;
      setView(panWindow(current, direction, { fromMs: now() - rangeMs[range()], toMs: now() }));
    },
    toggleLive: () => {
      if (view() !== null) resetZoom();
      else setLive(value => !value);
    },
    requestRefresh: () => setTick(value => value + 1)
  };
}

export const TelemetryContext = createContext<TelemetryState>();

export function useTelemetry(): TelemetryState {
  return useContext(TelemetryContext);
}
