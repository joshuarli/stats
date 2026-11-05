import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { accessToken } from "../access-token.ts";
import { SCRATCH } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../../local/topology.ts";

const LAUNCHER = join(CLOUDFLARE_ROOT, "scripts/local-stack.mjs");
const STATSCTL = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(join(CLOUDFLARE_ROOT, "src/cli/statsctl.ts"))}`;
mkdirSync(SCRATCH, { recursive: true });
const work = mkdtempSync(join(SCRATCH, "launcher-"));

interface Finished { readonly status: number | null; readonly stdout: string; readonly stderr: string }

function finish(child: ChildProcess): Promise<Finished> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise(resolve => child.on("close", status => resolve({ status, stdout, stderr })));
}

function launch(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(process.execPath, [LAUNCHER, ...args], { cwd: CLOUDFLARE_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function descendants(pid: number): number[] {
  const children = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(line => line !== "").map(Number);
  return children.flatMap(child => [child, ...descendants(child)]);
}

try {
  await test("run hands a command the stack's origin and credential, and statsctl never calls cf", async () => {
    const shims = join(work, "shims");
    const log = join(work, "cf.log");
    mkdirSync(shims, { recursive: true });
    writeFileSync(join(shims, "cf"), `#!/bin/sh\necho "cf $*" >> ${JSON.stringify(log)}\nexit 99\n`);
    chmodSync(join(shims, "cf"), 0o755);
    const projects = await finish(launch(["run", "--", "sh", "-c", `${STATSCTL} projects --json`], { ...process.env, PATH: `${shims}:${process.env["PATH"] ?? ""}` }));
    assert.equal(projects.status, 0, projects.stderr);
    const envelope = JSON.parse(projects.stdout) as { schema: string; origin: string };
    assert.equal(envelope.schema, "statsctl/1");
    assert.match(envelope.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(existsSync(log), false, existsSync(log) ? readFileSync(log, "utf8") : "");
  });

  await test("run seeds a collection that statsctl cost prices", async () => {
    const cost = await finish(launch(["run", "--", "sh", "-c", `${STATSCTL} cost --project stuff --window 1h --json`]));
    assert.equal(cost.status, 0, cost.stderr);
    const envelope = JSON.parse(cost.stdout) as { schema: string; payload: { projects: { id: string; status: string }[] } };
    assert.equal(envelope.schema, "statsctl/1");
    assert.deepEqual(envelope.payload.projects.map(project => [project.id, project.status]), [["stuff", "ok"]]);
  });

  await test("a broken or multi-line credential command exits 3", async () => {
    const codes = join(work, "codes");
    const script = [
      `STATSCTL_AUTH_COMMAND=false ${STATSCTL} projects --json > /dev/null; echo "false $?" >> ${JSON.stringify(codes)}`,
      `STATSCTL_AUTH_COMMAND="printf 'one\\ntwo'" ${STATSCTL} projects --json > /dev/null; echo "multi-line $?" >> ${JSON.stringify(codes)}`
    ].join("; ");
    const result = await finish(launch(["run", "--", "sh", "-c", script]));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(codes, "utf8"), "false 3\nmulti-line 3\n");
  });

  await test("dev serves the stack from its state, survives a restart, and leaves no process after SIGTERM or SIGINT", async () => {
    const state = join(work, "state");
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const serve = async () => {
      const child = launch(["dev", "--state", state, "--port", String(port)]);
      const done = finish(child);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      const deadline = Date.now() + 20_000;
      while (!/^ready$/mu.test(output)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`dev did not become ready: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(output.includes(`stats local stack: ${origin}`), output);
      return { child, done };
    };
    const read = async () => {
      const headers = { "cf-access-jwt-assertion": await accessToken() };
      assert.equal((await fetch(`${origin}/health`)).status, 200);
      const page = await fetch(`${origin}/`, { headers });
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/u);
      await page.arrayBuffer();
      const projects = await (await fetch(`${origin}/api/v1/projects`, { headers })).json() as { id: string; collector: { lastSuccessAtMs: number | null } }[];
      const hosts = await (await fetch(`${origin}/api/v1/hosts`, { headers })).json() as { hosts: { hostId: string }[] };
      return { projects: projects.map(project => [project.id, project.collector.lastSuccessAtMs !== null]), hosts: hosts.hosts.map(host => host.hostId) };
    };
    const stopped = async (running: Awaited<ReturnType<typeof serve>>, signal: "SIGTERM" | "SIGINT", status: number) => {
      const pids = [running.child.pid!, ...descendants(running.child.pid!)];
      assert.ok(pids.length > 1, "dev runs workerd as a child");
      running.child.kill(signal);
      const result = await running.done;
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(pids.filter(alive), []);
    };
    const first = await serve();
    const before = await read();
    assert.equal(before.hosts.length, 1);
    assert.ok(before.projects.every(([, collected]) => collected === true));
    await stopped(first, "SIGTERM", 128 + 15);
    const second = await serve();
    assert.deepEqual(await read(), before);
    await stopped(second, "SIGINT", 128 + 2);
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
