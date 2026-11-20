import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const watchdog = join(root, "deploy/orange/recovery/stats-recovery-vm-watchdog");

function shim(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

function run(statuses: readonly string[], options: { readonly maxRestarts?: number; readonly consoles?: number } = {}) {
  mkdirSync(join(root, ".work/tmp"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work/tmp/watchdog-"));
  const bin = join(dir, "bin"), vm = join(dir, "vm");
  mkdirSync(bin); mkdirSync(vm);
  writeFileSync(join(dir, "statuses"), statuses.map(status => `${status}\n`).join(""));
  writeFileSync(join(vm, "console.log"), "boot log\n");
  for (let index = 0; index < (options.consoles ?? 0); index++) writeFileSync(join(vm, `console.log.crash-${1000 + index}`), "old\n");
  shim(bin, "sleep", `n=$(wc -l < "${dir}/statuses"); [ "$n" -gt 0 ]`);
  shim(bin, "rc-service", `case "$2" in
status) s=$(head -n 1 "${dir}/statuses"); tail -n +2 "${dir}/statuses" > "${dir}/rest"; mv "${dir}/rest" "${dir}/statuses"; echo " * status: $s" ;;
restart) echo restart >> "${dir}/calls" ;;
esac`);
  shim(bin, "logger", `shift 2; echo "$*" >> "${dir}/log"`);
  let clock = 2000;
  shim(bin, "date", `echo ${clock++}`);
  const result = spawnSync("/bin/sh", [watchdog], {
    env: { PATH: `${bin}:/usr/bin:/bin`, WATCHDOG_RECOVERY_DIR: vm, WATCHDOG_INTERVAL: "0", WATCHDOG_MAX_RESTARTS: String(options.maxRestarts ?? 3) },
    encoding: "utf8",
    timeout: 10_000
  });
  const read = (name: string) => { try { return readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
  const outcome = { status: result.status, restarts: read("calls").length, log: read("log"), consoles: readdirSync(vm).filter(name => name.startsWith("console.log.crash-")).sort() };
  rmSync(dir, { recursive: true, force: true });
  return outcome;
}

await test("the watchdog leaves a started or stopped VM alone", () => {
  const outcome = run(["started", "stopped", "started"]);
  assert.equal(outcome.status, 0);
  assert.equal(outcome.restarts, 0);
  assert.deepEqual(outcome.log, []);
});

await test("a crashed VM is restarted once per crash and its console is kept", () => {
  const outcome = run(["crashed", "started", "started"]);
  assert.equal(outcome.restarts, 1);
  assert.equal(outcome.consoles.length, 1);
  assert.match(outcome.log[0]!, /crashed; keeping its console and restarting \(1 of 3/u);
});

await test("repeated crashes stop after the restart budget and log the give-up once", () => {
  const outcome = run(["crashed", "crashed", "crashed", "crashed", "crashed"], { maxRestarts: 2 });
  assert.equal(outcome.restarts, 2);
  assert.equal(outcome.log.filter(line => line.includes("leaving it down")).length, 1);
});

await test("only the newest five crash consoles are kept", () => {
  const outcome = run(["crashed", "started"], { consoles: 6 });
  assert.equal(outcome.consoles.length, 5);
  assert.ok(outcome.consoles.includes("console.log.crash-2000"));
  assert.ok(!outcome.consoles.includes("console.log.crash-1000"));
});
