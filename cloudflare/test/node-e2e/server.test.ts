import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agentDeliversABatch } from "../agent-e2e/flow.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRATCH = resolve(ROOT, "../.work/tmp");
const SMOKE = resolve(ROOT, "../deploy/deployed-smoke.sh");
const LOGIN = "node-e2e@example.com";

interface Started {
  readonly child: ChildProcess;
  readonly origin: string;
  output(): string;
  exited(): Promise<number | null>;
}

function launch(env: Record<string, string>): { child: ChildProcess; output: () => string; exited: () => Promise<number | null> } {
  const child = spawn(process.execPath, ["--experimental-strip-types", process.env["STATS_NODE_ENTRYPOINT"] ?? "src/node/main.ts"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { output += String(chunk); });
  const exit = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
  return { child, output: () => output, exited: () => exit };
}

async function start(dataDir: string): Promise<Started> {
  const launched = launch({ STATS_DATA_DIR: dataDir, STATS_LISTEN: "127.0.0.1:0", STATS_ALLOWED_LOGINS: LOGIN });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not report a port: ${launched.output()}`)), 10_000);
    launched.child.stdout!.on("data", () => {
      const match = /"event":"listening","host":"127\.0\.0\.1","port":(\d+)/u.exec(launched.output());
      if (match === null) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    });
    void launched.exited().then(code => reject(new Error(`server exited with ${code}: ${launched.output()}`)));
  });
  return { ...launched, origin: `http://127.0.0.1:${port}` };
}

async function smoke(origin: string): Promise<{ code: number | null; output: string }> {
  const child = spawn("sh", [SMOKE], { env: { ...process.env, STATS_URL: origin, TMPDIR: SCRATCH, STATSCTL_AUTH_COMMAND: `printf '%s\n' '${LOGIN}'`, STATSCTL_AUTH_HEADER: "Tailscale-User-Login" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const code = await new Promise<number | null>(resolveCode => child.on("exit", resolveCode));
  return { code, output };
}

await test("the Node server passes the deployed smoke, stores the real agent's batch, and keeps it across a graceful SIGTERM", async () => {
  const dataDir = mkdtempSync(join(SCRATCH, "node-e2e-"));
  try {
    const server = await start(dataDir);
    let host: { hostId: string; token: string };
    try {
      const smoked = await smoke(server.origin);
      assert.equal(smoked.code, 0, smoked.output);
      assert.match(smoked.output, /^OK: /mu);
      host = await agentDeliversABatch({ origin: server.origin, credentials: { "Tailscale-User-Login": LOGIN }, request: (url, init) => fetch(url, init) });
    } finally {
      server.child.kill("SIGTERM");
    }
    assert.equal(await server.exited(), 0, server.output());
    assert.match(server.output(), /"event":"stopped"/u);
    assert.ok(!server.output().includes(host.token), "the server log contains a host token");

    const db = new DatabaseSync(join(dataDir, "stats.sqlite"), { readOnly: true });
    try {
      const stored = db.prepare("SELECT COUNT(*) AS samples FROM samples WHERE host_id = ?").get(host.hostId) as { samples: number };
      assert.equal(stored.samples, 1);
    } finally {
      db.close();
    }

    const restarted = await start(dataDir);
    try {
      const latest = await fetch(`${restarted.origin}/api/v1/hosts/${host.hostId}/latest`, { headers: { "Tailscale-User-Login": LOGIN } });
      assert.equal(latest.status, 200);
    } finally {
      restarted.child.kill("SIGINT");
    }
    assert.equal(await restarted.exited(), 0, restarted.output());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

await test("SIGTERM stops new connections but finishes a request already in flight before the server exits", async () => {
  const dataDir = mkdtempSync(join(SCRATCH, "node-e2e-drain-"));
  try {
    const server = await start(dataDir);
    const frame = readFileSync(resolve(ROOT, "../fixtures/v2/frames/minimal.stb2"));
    const { port } = new URL(server.origin);
    const inFlight = httpRequest({ host: "127.0.0.1", port, path: "/ingest/v2/batches", method: "POST", headers: { Authorization: "Bearer nft_drainDRAINdrainDRAINdrainDRAINdrainDRAIN000", "Content-Type": "application/vnd.stats.ingest.v2", "Content-Length": String(frame.byteLength) } });
    const status = new Promise<number>((resolveStatus, reject) => {
      inFlight.on("response", response => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      });
      inFlight.on("error", reject);
    });
    inFlight.write(frame.subarray(0, 8));
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
    server.child.kill("SIGTERM");
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
    await assert.rejects(fetch(`${server.origin}/health`), "a new connection was accepted after SIGTERM");
    inFlight.end(frame.subarray(8));
    assert.equal(await status, 401);
    assert.equal(await server.exited(), 0, server.output());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

await test("the Node server refuses to start without its allowlist or data directory", async () => {
  const dataDir = mkdtempSync(join(SCRATCH, "node-e2e-config-"));
  try {
    for (const [env, message] of [
      [{ STATS_DATA_DIR: dataDir }, /STATS_ALLOWED_LOGINS is required/u],
      [{ STATS_ALLOWED_LOGINS: LOGIN }, /STATS_DATA_DIR is required/u]
    ] as const) {
      const launched = launch(env);
      assert.equal(await launched.exited(), 2, launched.output());
      assert.match(launched.output(), message);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

await test("a second Node server on the same data directory exits 2 and leaves the first serving", async () => {
  const dataDir = mkdtempSync(join(SCRATCH, "node-e2e-lock-"));
  try {
    const first = await start(dataDir);
    try {
      const second = launch({ STATS_DATA_DIR: dataDir, STATS_LISTEN: "127.0.0.1:0", STATS_ALLOWED_LOGINS: LOGIN });
      assert.equal(await second.exited(), 2, second.output());
      assert.match(second.output(), /stats: STATS_DATA_DIR .* is in use by another server/u);
      assert.equal((await fetch(`${first.origin}/health`)).status, 200);
    } finally {
      first.child.kill("SIGTERM");
    }
    assert.equal(await first.exited(), 0, first.output());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function socketServer(dataDir: string, socket: string) {
  return launch({ STATS_DATA_DIR: dataDir, STATS_LISTEN: `unix:${socket}`, STATS_ALLOWED_LOGINS: LOGIN });
}

function overSocket(socket: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const outgoing = httpRequest({ socketPath: socket, path, headers }, response => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function listening(launched: ReturnType<typeof launch>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!launched.output().includes('"event":"listening"')) {
    if (Date.now() > deadline) throw new Error(`server did not listen: ${launched.output()}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

await test("the Node server on a Unix socket serves health and an authorized route, owns the socket 0600, replaces a stale one, refuses a live one, and unlinks it on SIGTERM", async () => {
  const dir = mkdtempSync(join(SCRATCH, "ns-"));
  const socket = join(dir, "s.sock");
  try {
    const first = socketServer(dir, socket);
    await listening(first);
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    assert.equal(await overSocket(socket, "/health"), 200);
    assert.equal(await overSocket(socket, "/api/v1/hosts"), 401);
    assert.equal(await overSocket(socket, "/api/v1/hosts", { "Tailscale-User-Login": LOGIN }), 200);

    const second = socketServer(mkdtempSync(join(dir, "other-")), socket);
    assert.equal(await second.exited(), 2, second.output());
    assert.match(second.output(), /stats: STATS_LISTEN .* is in use by another server/u);
    assert.equal(await overSocket(socket, "/health"), 200);

    first.child.kill("SIGKILL");
    await first.exited();
    assert.ok(existsSync(socket), "a killed server leaves its socket behind");
    const replacement = socketServer(mkdtempSync(join(dir, "again-")), socket);
    await listening(replacement);
    assert.equal(await overSocket(socket, "/health"), 200);
    replacement.child.kill("SIGTERM");
    assert.equal(await replacement.exited(), 0, replacement.output());
    assert.ok(!existsSync(socket), "the socket is removed on shutdown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
