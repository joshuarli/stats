import { test as base } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, join } from "node:path";
import { openAssets } from "../../src/node/assets.ts";
import { ensureBuilds, ROOT } from "../../scripts/ensure-build.ts";
import { processOwner } from "../../scripts/processes.ts";
import { stageNode } from "../../scripts/stage-node.ts";

export { expect, type Page, type Route, type TestInfo } from "@playwright/test";
interface OwnedServer { readonly origin: string; readonly assetsDirectory: string }
type Servers = (kind: "static" | "node") => Promise<OwnedServer>;

export const test = base.extend<{ serverOrigin: string; assetsDirectory: string }, { servers: Servers }>({
  servers: [async ({ browserName }, use) => {
    const owner = processOwner(`browser-${browserName}`);
    const origins = new Map<string, Promise<OwnedServer>>();
    let server: Server | undefined;
    const start: Servers = async kind => {
      const artifacts = await ensureBuilds(kind === "node" ? ["stats", "node"] : ["stats"], { signal: owner.signal });
      if (kind === "static") {
        const assets = await openAssets(join(artifacts[0]!.output, "v0/workers/default/assets"));
        server = createServer((incoming, outgoing) => {
          void assets(new Request(`http://127.0.0.1${incoming.url ?? "/"}`, { method: incoming.method ?? "GET" })).then(async response => {
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(new Uint8Array(await response.arrayBuffer()));
          }).catch(error => { console.error(error); outgoing.writeHead(500).end(); });
        });
        await new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", done); });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("static browser server has no port");
        return { origin: `http://127.0.0.1:${address.port}`, assetsDirectory: join(artifacts[0]!.output, "v0/workers/default/assets") };
      }
      const entry = stageNode(artifacts, owner.directory);
      const data = join(owner.directory, "data");
      mkdirSync(data);
      const child = owner.start("node-server", process.execPath, [entry], { cwd: ROOT, env: { STATS_DATA_DIR: data, STATS_LISTEN: "127.0.0.1:0", STATS_ALLOWED_LOGINS: "playwright@example.com" } });
      let output = "";
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const origin = await Promise.race([
          new Promise<string>(done => { child.child.stdout!.on("data", chunk => {
            output += String(chunk);
            const match = /"event":"listening","host":"127\.0\.0\.1","port":(\d+)/u.exec(output);
            if (match !== null) done(`http://127.0.0.1:${match[1]}`);
          }); }),
          child.done.then((): never => { throw new Error("Node browser server exited before readiness"); })
        ]);
        return { origin, assetsDirectory: join(owner.directory, "cloudflare/.cloudflare/output/v0/workers/default/assets") };
      } finally { clearTimeout(timeout); }
    };
    try { await use(kind => {
      let origin = origins.get(kind);
      if (origin === undefined) { origin = start(kind); origins.set(kind, origin); }
      return origin;
    }); }
    finally {
      server?.closeAllConnections();
      if (server !== undefined) await new Promise<void>((done, reject) => server!.close(error => error === undefined ? done() : reject(error)));
      await owner.close();
    }
  }, { scope: "worker" }],
  serverOrigin: async ({ servers }, use, info) => {
    const file = basename(info.file);
    await use(file === "local-stack.spec.ts" ? "http://local-stack.invalid" : (await servers(file === "node.spec.ts" ? "node" : "static")).origin);
  },
  assetsDirectory: async ({ servers }, use, info) => { await use((await servers(basename(info.file) === "node.spec.ts" ? "node" : "static")).assetsDirectory); },
  baseURL: async ({ serverOrigin }, use) => { await use(serverOrigin); }
});
