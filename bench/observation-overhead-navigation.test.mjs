import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
await test("variant navigation creates a fresh document instead of retaining delivery counters", { skip: spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status !== 0, timeout: 45000 }, async () => {
  const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script>window.deliveryCount=0</script><main>Navigation fixture</main>'));
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  let session;
  const command = async args => (await exec("agent-browser", args, { timeout: 15000 })).stdout.trim();
  const decode = text => { const value = JSON.parse(text); return typeof value === "string" ? JSON.parse(value) : value; };
  try {
    session = await command(["session", "id", "--scope", "worktree", "--prefix", "stats-overhead-navigation"]);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = args => command(["--session", session, ...args]);
    await browser(["open", `${origin}/?variant=disabled&round=0#/projects`]);
    await browser(["eval", "window.deliveryCount=160"]);
    await browser(["open", `${origin}/?variant=disabled&round=0#/project/stats`]);
    assert.equal(decode(await browser(["eval", "window.deliveryCount"])), 160, "hash navigation retains the previous variant's counters");
    await browser(["open", `${origin}/?variant=enabled&round=0#/projects`]);
    assert.equal(decode(await browser(["eval", "window.deliveryCount"])), 0, "variant query parameters create a new document");
  } finally {
    if (session) await command(["--session", session, "close"]);
    server.closeAllConnections(); await new Promise(done => server.close(done));
  }
});
