import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const scratch = resolve(root, ".work/tmp");

await test("the Orange development command serves locally and removes its runtime and state on SIGTERM", async () => {
  const before = new Set(readdirSync(scratch).filter(name => name.startsWith("orange-dev-")));
  const child = spawn(process.execPath, ["--experimental-strip-types", "deploy/orange/dev.mts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { output += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once("exit", (code, signal) => done({ code, signal })));
  try {
    const deadline = Date.now() + 120_000;
    while (!output.includes("OpenOrange: http://") && child.exitCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    const origin = output.match(/OpenOrange: (http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
    assert.ok(origin, output);
    assert.equal((await fetch(`${origin}/api/v1/hosts`)).status, 200);
    const directories = readdirSync(scratch).filter(name => name.startsWith("orange-dev-") && !before.has(name));
    assert.equal(directories.length, 1);
    const state = resolve(scratch, directories[0]!);
    const processes = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" }).split("\n").flatMap(line => {
      const parts = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return parts === null ? [] : [{ pid: Number(parts[1]), parent: Number(parts[2]), command: parts[3]! }];
    });
    const descendants = new Set([child.pid!]);
    let known = 0;
    while (known !== descendants.size) {
      known = descendants.size;
      for (const entry of processes) if (descendants.has(entry.parent)) descendants.add(entry.pid);
    }
    const engines = processes.filter(entry => /rivet-engine --config /u.test(entry.command) && entry.command.includes(`${state}/`));
    assert.equal(engines.length, 1, "the probe must exercise a real owned Engine");
    for (const engine of engines) descendants.add(engine.pid);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
    for (const pid of descendants) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith("orange-dev-") && !before.has(name)), []);
    await assert.rejects(fetch(`${origin}/health`));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
  }
});
