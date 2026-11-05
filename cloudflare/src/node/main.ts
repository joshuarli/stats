import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BUILT_ASSETS, openAssets } from "./assets.ts";
import { nodeConfig, NodeConfigError } from "./config.ts";
import { openNodeInstallation } from "./installation.ts";
import { createStatsServer } from "./server.ts";

async function main(): Promise<void> {
  const config = nodeConfig(process.env);
  const assets = await openAssets(BUILT_ASSETS);
  const installation = openNodeInstallation({ path: config.databasePath, projects: "[]" });
  const server = createStatsServer({ installation: request => installation.core.fetch(request), assets, allowedLogins: config.allowedLogins });
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  console.log(JSON.stringify({ event: "listening", host: address.address, port: address.port }));
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
