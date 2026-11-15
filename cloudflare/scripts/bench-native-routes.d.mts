import type { NetworkRecord, NetworkSummary } from "./bench-network.mjs";
export interface BenchRoute {
  name: string;
  hash: string;
  url: string;
  pivotHash: string;
  pivotReady: string;
  ready: string;
}
export function isNative(capabilities: unknown): boolean;
export function nativeRoutes(base: string, service: string): [BenchRoute, BenchRoute, BenchRoute, BenchRoute];
export function selectRoutes<T extends { name: string }>(routes: readonly T[], selection: string | null): readonly T[];
export function accountNetwork<T extends NetworkSummary>(records: readonly NetworkRecord[], summary: T): T & {
  successfulRequests: number;
  requestDetails: readonly NetworkRecord[];
};
export function validSamples<T extends { failedRequests: readonly unknown[] }>(samples: readonly T[]): T[];
