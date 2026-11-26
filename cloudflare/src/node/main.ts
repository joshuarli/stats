import { INFRA_SERVICE } from "../../../packages/infra-collector/src/contract.ts";
import type { Server, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { MetricStore } from "../metrics/store.ts";
import { handleMetricRequest } from "../metrics/http.ts";
import { BUILT_ASSETS, openAssets } from "./assets.ts";
import { nodeConfig, NodeConfigError, type Listen } from "./config.ts";
import { DatabaseInUseError, openNodeInstallation, type NodeInstallation } from "./installation.ts";
import { createStatsServer, observeHandler } from "./server.ts";
import { listenOnSocket } from "./socket.ts";

function listenOn(server: Server, listen: Listen): Promise<void> {
  if (listen.kind === "unix") return listenOnSocket(server, listen.path);
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = nodeConfig(process.env);
  const assets = await openAssets(BUILT_ASSETS);
  let installation: NodeInstallation;
  try {
    installation = openNodeInstallation({ path: config.databasePath, projects: "[]" });
  } catch (error) {
    if (error instanceof DatabaseInUseError) throw new NodeConfigError(`STATS_DATA_DIR ${dirname(config.databasePath)} is in use by another server`);
    throw error;
  }
  const directory = `${config.databasePath}.metrics`;
  let metrics: MetricStore | undefined;
  const metricStore = () => {
    if (metrics === undefined) {
      mkdirSync(directory, { recursive: true });
      metrics = new MetricStore(join(directory, `${INFRA_SERVICE}.sqlite`));
    }
    return metrics;
  };
  const server = createStatsServer({
    auth: config.auth,
    metricsVerifier: process.env["INFRA_METRICS_TOKEN_SHA256"],
    metrics: request => handleMetricRequest(request, metricStore()),
    installation: request => installation.core.fetch(request),
    observe: observeHandler(installation),
    assets,
    transport: config.listen.kind === "unix" ? "unix" : "tcp"
  });
  let draining = false;
  const inFlight = new Set<ServerResponse>();
  server.on("request", (_incoming, outgoing: ServerResponse) => {
    inFlight.add(outgoing);
    if (draining) outgoing.shouldKeepAlive = false;
    outgoing.on("close", () => {
      inFlight.delete(outgoing);
      if (draining) setImmediate(() => server.closeIdleConnections());
    });
  });
  try {
    await listenOn(server, config.listen);
  } catch (error) {
    installation.close();
    throw error;
  }
  const address = server.address();
  console.log(JSON.stringify(typeof address === "string" || address === null ? { event: "listening", socket: address } : { event: "listening", host: address.address, port: address.port }));
  const stop = (signal: NodeJS.Signals) => {
    if (draining) return;
    draining = true;
    console.log(JSON.stringify({ event: "stopping", signal }));
    server.close(error => {
      installation.close();
      metrics?.close();
      if (error !== undefined) {
        console.error(JSON.stringify({ event: "stop_failed", name: error.name }));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ event: "stopped" }));
    });
    for (const outgoing of inFlight) if (!outgoing.headersSent) outgoing.shouldKeepAlive = false;
    server.closeIdleConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

try {
  await main();
} catch (error) {
  if (!(error instanceof NodeConfigError)) throw error;
  console.error(`stats: ${error.message}`);
  process.exitCode = 2;
}
