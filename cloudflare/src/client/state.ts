import { createContext, useContext, type Accessor, type Setter } from "solid-js";
import type { Host } from "./api";

export const ranges = ["1h", "6h", "24h", "7d", "90d"] as const;
export type Range = (typeof ranges)[number];
export const rangeLabels: Record<Range, string> = {
  "1h": "Past 1 hour",
  "6h": "Past 6 hours",
  "24h": "Past 24 hours",
  "7d": "Past 7 days",
  "90d": "Past 90 days"
};
export type Theme = "light" | "dark";

export interface TelemetryState {
  readonly range: Accessor<Range>;
  readonly setRange: Setter<Range>;
  readonly now: Accessor<number>;
  readonly hosts: Accessor<readonly Host[]>;
  readonly refreshHosts: () => Promise<void>;
  readonly theme: Accessor<Theme>;
  readonly toggleTheme: () => void;
}

export const TelemetryContext = createContext<TelemetryState>();

export function useTelemetry(): TelemetryState {
  return useContext(TelemetryContext);
}
