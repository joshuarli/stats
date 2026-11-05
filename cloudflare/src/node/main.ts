import type { Server, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { BUILT_ASSETS, openAssets } from "./assets.ts";
import { nodeConfig, NodeConfigError, type Listen } from "./config.ts";
import { DatabaseInUseError, openNodeInstallation, type NodeInstallation } from "./installation.ts";
import { createStatsServer } from "./server.ts";
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
  const server = createStatsServer({ installation: request => installation.core.fetch(request), assets, allowedLogins: config.allowedLogins, transport: config.listen.kind === "unix" ? "unix" : "tcp" });
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
