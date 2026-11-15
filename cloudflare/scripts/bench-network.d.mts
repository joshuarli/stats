export interface NetworkRecord {
  path: string;
  kind: "asset" | "json" | "history" | "observe";
  status: number;
  bytes: number;
}
export interface NetworkSummary {
  requests: number;
  apiRequests: number;
  byClass: Record<NetworkRecord["kind"], number>;
  jsBytes: number;
  jsKb: number;
  cssBytes: number;
  cssKb: number;
  apiBytes: number;
  apiKb: number;
  historyBytes: number;
  observeBytes: number;
  jsonBytes: number;
  requestList: string[];
  apiRequestList: string[];
  failedRequests: { path: string; status: number }[];
}
interface TrackedRequest {
  url(): string;
  method(): string;
  response(): Promise<{ status(): number; body(): Promise<Uint8Array> } | null>;
}
interface NetworkPage {
  on(event: "request", callback: (request: TrackedRequest) => void): unknown;
  on(event: "requestfinished", callback: (request: TrackedRequest) => void): unknown;
  on(event: "requestfailed", callback: (request: TrackedRequest) => void): unknown;
}
export function createNetworkTracker(page: NetworkPage, activeBase: string): {
  reset(): void;
  snapshot(): NetworkRecord[];
  waitForQuiet(quietMs?: number, timeoutMs?: number): Promise<void>;
};
export function summarizeNetwork(records: readonly NetworkRecord[]): NetworkSummary;
