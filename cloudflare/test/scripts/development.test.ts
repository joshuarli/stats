import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
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
    let ps = "ps";
    let rss = (lines: string[]): number => lines.reduce((sum, line) => sum + Number(/^\s*\d+\s+\d+\s+(\d+)/u.exec(line)?.[1] ?? 0), 0);
    if (process.platform === "darwin") {
      ps = join(workspace.repo, "ps");
      copyFileSync("/bin/ps", ps);
      chmodSync(ps, 0o755);
      execFileSync("codesign", ["--force", "--sign", "-", ps]);
      const source = join(workspace.repo, "rss.c");
      const sampler = join(workspace.repo, "rss");
      writeFileSync(source, `#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  unsigned long long total = 0;
  for (int i = 1; i < argc; i++) {
    struct proc_taskinfo info;
    if (proc_pidinfo(atoi(argv[i]), PROC_PIDTASKINFO, 0, &info, sizeof(info)) != sizeof(info)) return 1;
    total += info.pti_resident_size;
  }
  printf("%llu\\n", total / 1024);
  return 0;
}
`);
      execFileSync("clang", ["-o", sampler, source]);
      rss = lines => Number(execFileSync(sampler, lines.map(line => /^\s*(\d+)/u.exec(line)![1]!), { encoding: "utf8" }).trim());
      assert.ok(rss([String(process.pid)]) > 0);
    }
    first = launch("first");
    const started = performance.now();
    const initial = await first.wait("dev-ready");
    const coldMs = performance.now() - started;
    const processes = (): string => execFileSync(ps, ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
    const tree = (root: number): string[] => {
      const lines = processes().trim().split("\n");
      const ids = new Set([root]);
      let count = 0;
      while (count !== ids.size) { count = ids.size; for (const line of lines) { const match = /^\s*(\d+)\s+(\d+)/u.exec(line); if (match && ids.has(Number(match[2]))) ids.add(Number(match[1])); } }
      return lines.filter(line => ids.has(Number(/^\s*(\d+)/u.exec(line)?.[1])));
    };
    const describe = (pids: number[]): string => {
      const rows = execFileSync(ps, ["-axo", "pid=,ppid=,stat=,lstart=,command="], { encoding: "utf8" }).split("\n").filter(line => pids.includes(Number(/^\s*(\d+)/u.exec(line)?.[1])));
      if (process.platform === "linux") for (const pid of pids) {
        try { rows.push(`proc stat: ${readFileSync(`/proc/${pid}/stat`, "utf8").trim()}`); }
        catch { rows.push(`proc stat unavailable: ${pid}`); }
      }
      return rows.join("\n");
    };
    const assertGone = (pids: number[], before: string, launchResult: ReturnType<typeof launch>): void => {
      try {
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `process ${pid} remains`);
      } catch (error) {
        console.error(`dev exit: code=${launchResult.child.child.exitCode} signal=${launchResult.child.child.signalCode} stopped=${launchResult.statuses.some(status => status.event === "dev-stopped")}\nprocess identities before shutdown:\n${before}\nprocesses after shutdown:\n${describe(pids)}`);
        throw error;
      }
    };
    const initialTree = tree(first.child.child.pid!);
    assert.ok(initialTree.some(line => line.includes(`${initial.backendPid} `) && /open-orange\/dist\/bin\.js dev/u.test(line)));
    assert.ok(initialTree.every(line => !/workerd/u.test(line)));
    const rssKb = rss(initialTree);
    assert.ok(rssKb > 0);
    second = launch("second", otherWorkspace);
    const other = await second.wait("dev-ready");
    assert.notEqual(initial.origin, other.origin);
    assert.notEqual(initial.backendOrigin, other.backendOrigin);
    assert.notEqual(initial.runId, other.runId);
    assert.equal((await fetch(`${initial.workerOrigin}/api/v1/hosts`)).status, 401);
    const storedHosts = async (origin: string) => {
      const result = await (await fetch(`${origin}/api/v1/hosts`)).json() as { hosts: { hostId: string; online: boolean }[] };
      return result.hosts.map(({ online, ...stored }) => {
        assert.equal(typeof online, "boolean");
        return stored;
      });
    };
    const before = await storedHosts(initial.origin);
    assert.equal(before.length, 1);
    assert.notEqual(before[0]!.hostId, (await storedHosts(other.origin))[0]!.hostId);
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

    const source = join(workspace.root, "src/core/health.ts");
    const good = readFileSync(source, "utf8").replace('...(options.release === undefined ? {} : { release: options.release })', 'release: "changed"');
    let cursor = first.statuses.length;
    const rebuildStarted = performance.now();
    writeFileSync(source, good);
    const changed = await first.wait("dev-ready", cursor);
    const rebuildMs = performance.now() - rebuildStarted;
    assert.notEqual(changed.backendPid, initial.backendPid);
    assert.equal((await (await fetch(`${initial.origin}/health`)).json() as { release: string }).release, "changed");
    assert.deepEqual(await storedHosts(initial.origin), before);
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
    assert.deepEqual(await storedHosts(initial.origin), before);
    const oldPids = tree(first.child.child.pid!).map(line => Number(/^\s*(\d+)/u.exec(line)![1]));
    const oldIdentities = describe(oldPids);
    await first.stop();
    assert.ok(first.statuses.some(status => status.event === "dev-stopped"), "SIGTERM bypassed dev cleanup");
    const deadline = Date.now() + 5000;
    while (oldPids.some(pid => processes().split("\n").some(line => Number(/^\s*(\d+)/u.exec(line)?.[1]) === pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assertGone(oldPids, oldIdentities, first);
    assert.equal((await fetch(`${other.origin}/health`)).status, 200);
    const warmStarted = performance.now();
    first = launch("first");
    const restarted = await first.wait("dev-ready");
    const warmMs = performance.now() - warmStarted;
    console.log(`dev measurements: cold=${Math.round(coldMs)}ms warm=${Math.round(warmMs)}ms rebuild=${Math.round(rebuildMs)}ms rss=${rssKb}KiB`);
    assert.deepEqual(await storedHosts(restarted.origin), before);
    assert.doesNotMatch(readFileSync(first.child.logPath, "utf8"), /Bearer |eyJhbGci/u);
    const secondPids = tree(second.child.child.pid!).map(line => Number(/^\s*(\d+)/u.exec(line)![1]));
    const secondIdentities = describe(secondPids);
    await second.stop("SIGINT");
    const secondDeadline = Date.now() + 5000;
    while (secondPids.some(pid => processes().split("\n").some(line => Number(/^\s*(\d+)/u.exec(line)?.[1]) === pid)) && Date.now() < secondDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    assertGone(secondPids, secondIdentities, second);
  } finally {
    await first?.stop();
    await second?.stop();
    await browser.close();
    await owner.close();
    workspace.remove();
    otherWorkspace.remove();
  }
});
