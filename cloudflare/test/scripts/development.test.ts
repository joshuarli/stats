import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { processOwner } from "../../scripts/processes.ts";
import { devWorkspace } from "../support/dev-workspace.ts";

interface Status { readonly event: string; readonly origin: string; readonly backendOrigin: string; readonly workerOrigin: string; readonly backendPid: number; readonly runId: string; readonly artifacts: readonly { readonly target: string; readonly identity: string }[] }

await test("development hot updates, reloads, keeps the last good build and state, and isolates shutdown", { timeout: 180_000 }, async () => {
  const workspace = devWorkspace();
  const otherWorkspace = devWorkspace();
  const owner = processOwner("dev-test");
  const browser = await chromium.launch();
  function launch(state: string, checkout = workspace) {
    const child = owner.start(`dev-${state}`, process.execPath, ["scripts/dev.ts", "--state", join(checkout.repo, ".work/local", state), "--port", "0"], { cwd: checkout.root, env: process.env, stream: false });
    const statuses: Status[] = [];
    const listeners = new Set<() => void>();
    let buffer = "";
    child.child.stdout!.on("data", chunk => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        const status = JSON.parse(line) as Status;
        if (!status.event.startsWith("dev-")) continue;
        statuses.push(status);
        for (const listener of listeners) listener();
      }
    });
    const wait = async (event: string, after = 0): Promise<Status> => {
      const found = statuses.slice(after).find(status => status.event === event);
      if (found !== undefined) return found;
      return await new Promise<Status>((done, reject) => {
        const timeout = setTimeout(() => { listeners.delete(changed); reject(new Error(`missing ${event}: ${readFileSync(child.logPath, "utf8")}`)); }, 120_000);
        const changed = (): void => {
          const value = statuses.slice(after).find(status => status.event === event);
          if (value !== undefined) { clearTimeout(timeout); listeners.delete(changed); done(value); }
        };
        listeners.add(changed);
        void child.done.catch(reject);
      });
    };
    const stop = async (signal: NodeJS.Signals = "SIGTERM"): Promise<void> => { child.kill(signal); await child.done.catch(() => {}); };
    return { child, statuses, wait, stop };
  }
  let first: ReturnType<typeof launch> | undefined;
  let second: ReturnType<typeof launch> | undefined;
  try {
    first = launch("first");
    const started = performance.now();
    const initial = await first.wait("dev-ready");
    const coldMs = performance.now() - started;
    const processes = (): string => execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
    const tree = (root: number): string[] => {
      const lines = processes().trim().split("\n");
      const ids = new Set([root]);
      let count = 0;
      while (count !== ids.size) { count = ids.size; for (const line of lines) { const match = /^\s*(\d+)\s+(\d+)/u.exec(line); if (match && ids.has(Number(match[2]))) ids.add(Number(match[1])); } }
      return lines.filter(line => ids.has(Number(/^\s*(\d+)/u.exec(line)?.[1])));
    };
    const initialTree = tree(first.child.child.pid!);
    assert.ok(initialTree.some(line => line.includes(`${initial.backendPid} `) && /open-orange\/dist\/bin\.js dev/u.test(line)));
    assert.ok(initialTree.every(line => !/workerd/u.test(line)));
    const rssKb = initialTree.reduce((sum, line) => sum + Number(/^\s*\d+\s+\d+\s+(\d+)/u.exec(line)?.[1] ?? 0), 0);
    second = launch("second", otherWorkspace);
    const other = await second.wait("dev-ready");
    assert.notEqual(initial.origin, other.origin);
    assert.notEqual(initial.backendOrigin, other.backendOrigin);
    assert.notEqual(initial.runId, other.runId);
    assert.equal((await fetch(`${initial.workerOrigin}/api/v1/hosts`)).status, 401);
    const hosts = async (origin: string) => await (await fetch(`${origin}/api/v1/hosts`)).json() as { hosts: { hostId: string }[] };
    const before = await hosts(initial.origin);
    assert.equal(before.hosts.length, 1);
    assert.notEqual(before.hosts[0]!.hostId, (await hosts(other.origin)).hosts[0]!.hostId);
    const page = await browser.newPage();
    await page.goto(initial.origin);
    await page.getByRole("table", { name: "Fleet hosts" }).waitFor();
    const css = join(workspace.root, "src/client/styles/index.css");
    const afterCss = first.statuses.length;
    writeFileSync(css, `${readFileSync(css, "utf8")}\n:root { --dev-test-color: passed; }\n`);
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--dev-test-color").trim() === "passed");
    assert.equal(first.statuses.slice(afterCss).filter(status => status.event === "dev-reloading").length, 0);
    await page.evaluate('window.devLoopTestSentinel = "present"');
    const fleet = join(workspace.root, "src/client/pages/FleetPage.tsx");
    writeFileSync(fleet, readFileSync(fleet, "utf8").replaceAll('title="Hosts"', 'title="Hot updated hosts"'));
    await page.getByRole("heading", { name: "Hot updated hosts" }).first().waitFor();
    assert.equal(await page.evaluate("window.devLoopTestSentinel"), "present");
    assert.equal(first.statuses.slice(afterCss).filter(status => status.event === "dev-reloading").length, 0);

    const source = join(workspace.root, "src/core/http.ts");
    const good = readFileSync(source, "utf8").replace('{ ok: true, service: "stats" }', '{ ok: true, service: "stats", devProbe: "changed" }');
    let cursor = first.statuses.length;
    const rebuildStarted = performance.now();
    writeFileSync(source, good);
    const changed = await first.wait("dev-ready", cursor);
    const rebuildMs = performance.now() - rebuildStarted;
    assert.notEqual(changed.backendPid, initial.backendPid);
    assert.equal((await (await fetch(`${initial.origin}/health`)).json() as { devProbe: string }).devProbe, "changed");
    assert.deepEqual(await hosts(initial.origin), before);
    cursor = first.statuses.length;
    writeFileSync(source, "export const = ;");
    await first.wait("dev-build-error", cursor);
    assert.equal((await fetch(`${initial.origin}/health`)).status, 200);
    cursor = first.statuses.length;
    writeFileSync(source, good);
    const recovered = await first.wait("dev-ready", cursor);
    assert.equal(recovered.backendOrigin, changed.backendOrigin);

    const observe = join(workspace.root, "src/observe/cloudflare/worker.ts");
    const original = readFileSync(observe, "utf8");
    cursor = first.statuses.length;
    writeFileSync(observe, original.replace('return handleApi(request, match[2]!, store(env, match[1]!), match[1]!);', 'const response = await handleApi(request, match[2]!, store(env, match[1]!), match[1]!); response.headers.set("X-Dev-Probe", "observe"); return response;'));
    await first.wait("dev-ready", cursor);
    const observed = await fetch(`${initial.origin}/api/observe/stats/health`);
    assert.equal(observed.status, 200);
    assert.equal(observed.headers.get("X-Dev-Probe"), "observe");
    assert.deepEqual(await hosts(initial.origin), before);
    const oldPids = tree(first.child.child.pid!).map(line => Number(/^\s*(\d+)/u.exec(line)![1]));
    await first.stop();
    const deadline = Date.now() + 5000;
    while (oldPids.some(pid => processes().split("\n").some(line => Number(/^\s*(\d+)/u.exec(line)?.[1]) === pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    for (const pid of oldPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `process ${pid} remains`);
    assert.equal((await fetch(`${other.origin}/health`)).status, 200);
    const warmStarted = performance.now();
    first = launch("first");
    const restarted = await first.wait("dev-ready");
    const warmMs = performance.now() - warmStarted;
    console.log(`dev measurements: cold=${Math.round(coldMs)}ms warm=${Math.round(warmMs)}ms rebuild=${Math.round(rebuildMs)}ms rss=${rssKb}KiB`);
    assert.deepEqual(await hosts(restarted.origin), before);
    assert.doesNotMatch(readFileSync(first.child.logPath, "utf8"), /Bearer |eyJhbGci/u);
    const secondPids = tree(second.child.child.pid!).map(line => Number(/^\s*(\d+)/u.exec(line)![1]));
    await second.stop("SIGINT");
    const secondDeadline = Date.now() + 5000;
    while (secondPids.some(pid => processes().split("\n").some(line => Number(/^\s*(\d+)/u.exec(line)?.[1]) === pid)) && Date.now() < secondDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    for (const pid of secondPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `process ${pid} remains`);
  } finally {
    await first?.stop();
    await second?.stop();
    await browser.close();
    await owner.close();
    workspace.remove();
    otherWorkspace.remove();
  }
});
