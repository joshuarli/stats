import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
export function createBenchServer(options: {
  assetsDir: string;
  upstream: string;
  port?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<{ server: Omit<Server, "address"> & { address(): AddressInfo }; close(): Promise<void> }>;
