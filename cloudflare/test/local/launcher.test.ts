import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { accessToken } from "../access-token.ts";
import { SCRATCH, ephemeralPrefix } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../../local/topology.ts";

const LAUNCHER = join(CLOUDFLARE_ROOT, "scripts/local-stack.mjs");
const PRODUCER_EXPORT = join(CLOUDFLARE_ROOT, "../fixtures/producers/nanoshop-storied");
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

interface ShopResponse { readonly status: number; readonly cookie: string | null; readonly body: string }

function shop(origin: string, path: string, init: { readonly method?: string; readonly cookie?: string; readonly form?: string } = {}): Promise<ShopResponse> {
  const url = new URL(origin);
  const headers: Record<string, string> = { host: url.host };
  if (init.cookie !== undefined) headers["cookie"] = init.cookie;
  if (init.form !== undefined) Object.assign(headers, { origin, "content-type": "application/x-www-form-urlencoded" });
  return new Promise((resolve, reject) => {
    const sent = request({ host: "127.0.0.1", port: Number(url.port), path, method: init.method ?? "GET", headers }, response => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, cookie: response.headers["set-cookie"]?.[0]?.split(";")[0] ?? null, body }));
    });
    sent.on("error", reject);
    sent.end(init.form);
  });
}

async function serveDev(args: readonly string[], ready: RegExp): Promise<{ child: ChildProcess; done: Promise<Finished>; output: string }> {
  const child = launch(["dev", ...args]);
  const done = finish(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const deadline = Date.now() + 30_000;
  while (!ready.test(output)) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill("SIGTERM");
      throw new Error(`dev did not become ready: ${output}\n${(await done).stderr}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { child, done, output };
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

  await test("SIGTERM to run reaches its command and leaves no process or scratch state", async () => {
    const child = launch(["run", "--", "sh", "-c", "echo started; exec sleep 60"]);
    const done = finish(child);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    const deadline = Date.now() + 20_000;
    while (!output.includes("started")) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`run did not start its command: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const pids = [child.pid!, ...descendants(child.pid!)];
    child.kill("SIGTERM");
    assert.equal((await done).status, 128 + 15);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(pids.filter(alive), []);
    assert.deepEqual(readdirSync(SCRATCH).filter(name => name.startsWith(ephemeralPrefix(child.pid!))), []);
  });

  for (const [signal, status] of [["SIGINT", 128 + 2], ["SIGTERM", 128 + 15]] as const) {
    await test(`${signal} while the stack is still starting leaves no scratch state`, async () => {
      const child = launch(["run", "--", "sh", "-c", "exec sleep 60"]);
      const done = finish(child);
      const scratch = () => readdirSync(SCRATCH).filter(name => name.startsWith(ephemeralPrefix(child.pid!)));
      const deadline = Date.now() + 20_000;
      while (scratch().length === 0) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error("run never created its scratch directory");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      child.kill(signal);
      assert.equal((await done).status, status);
      assert.deepEqual(scratch(), []);
    });
  }

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
        if (Date.now() > deadline || child.exitCode !== null) {
          child.kill("SIGTERM");
          await done;
          throw new Error(`dev did not become ready: ${output}`);
        }
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
      const deadline = Date.now() + 2000;
      while (pids.some(alive) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
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

  await test("a producer export whose files changed since export is refused before the stack starts", async () => {
    const tampered = join(work, "tampered");
    cpSync(PRODUCER_EXPORT, tampered, { recursive: true });
    appendFileSync(join(tampered, "release/cloudflare/storied/assets/_headers"), "\n");
    const result = await finish(launch(["run", "--producer", tampered, "--", "true"]));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /StaleProducerExportError: .* no longer matches its manifest digest/u);
  });

  await test("dev hosts a producer export whose tail events statsctl reads under its service and version, and keeps its state across a restart", async () => {
    const manifest = JSON.parse(readFileSync(join(PRODUCER_EXPORT, "producer-export.json"), "utf8")) as { tenants: { serviceName: string; shopOrigin: string; version: { id: string } }[] };
    const [{ serviceName, shopOrigin, version }] = manifest.tenants as [typeof manifest.tenants[0]];
    const state = join(work, "producer-state");
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const producerLine = new RegExp(`^producer ${serviceName}: ${shopOrigin.replaceAll(".", "\\.")}  \\(.*its cron .* is not fired here\\)$`, "mu");
    const args = ["--state", state, "--port", String(port), "--producer", PRODUCER_EXPORT];
    const first = await serveDev(args, /^ready$/mu);
    assert.match(first.output, producerLine);

    const reads = ["/", "/products/tee", "/products/tee", "/search?q=tee", "/cart"];
    for (const path of reads) assert.equal((await shop(shopOrigin, path)).status, 200, path);
    const added = await shop(shopOrigin, "/cart/items", { method: "POST", form: "variant_id=1&quantity=1" });
    assert.equal(added.status, 303);
    assert.notEqual(added.cookie, null);
    const workerInvocations = reads.length + 1;

    const now = Date.now();
    const toMs = now - (now % 300_000) + 300_000;
    const windowPath = `/api/observe/${serviceName}/window?from=${toMs - 3_600_000}&to=${toMs}`;
    type Window = { invocations: { version: string; stage: string; count: number }[] };
    const deadline = Date.now() + 45_000;
    let window: Window;
    for (;;) {
      window = await (await fetch(`${origin}${windowPath}`, { headers: { "cf-access-jwt-assertion": await accessToken() } })).json() as Window;
      const worker = window.invocations.filter(row => row.stage === "worker").reduce((sum, row) => sum + row.count, 0);
      if (worker >= workerInvocations || Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(window.invocations.filter(row => row.stage === "worker").reduce((sum, row) => sum + row.count, 0), workerInvocations);
    assert.deepEqual([...new Set(window.invocations.map(row => row.version))], [version.id]);

    const env = { ...process.env, STATS_URL: origin, STATSCTL_AUTH_COMMAND: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(join(CLOUDFLARE_ROOT, "local/token.ts"))}`, STATSCTL_AUTH_HEADER: "cf-access-jwt-assertion" };
    const routes = await finish(spawn("sh", ["-c", `${STATSCTL} observe routes --project ${serviceName} --window 1h --json`], { env, stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(routes.status, 0, routes.stderr);
    const envelope = JSON.parse(routes.stdout) as { schema: string; project: string; payload: { routes: { label: string }[]; sampling: { kept: number; observed: number } } };
    assert.equal(envelope.schema, "statsctl/1");
    assert.equal(envelope.project, serviceName);
    assert.equal(envelope.payload.sampling.observed, workerInvocations);
    const sentLabels = new Set(["GET /", "GET /products/:handle", "GET /search", "GET /cart", "POST /cart/items"]);
    assert.deepEqual(envelope.payload.routes.map(route => route.label).filter(label => !sentLabels.has(label)), []);

    const cookie = added.cookie!;
    assert.match((await shop(shopOrigin, "/cart", { cookie })).body, /Alpha Tee/u);
    assert.doesNotMatch((await shop(shopOrigin, "/cart")).body, /Alpha Tee/u);
    first.child.kill("SIGTERM");
    assert.equal((await first.done).status, 128 + 15);

    const second = await serveDev(args, /^ready$/mu);
    try {
      assert.match((await shop(shopOrigin, "/cart", { cookie })).body, /Alpha Tee/u);
    } finally {
      second.child.kill("SIGTERM");
      await second.done;
    }
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
