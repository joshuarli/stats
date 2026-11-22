import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

await test("Engine capture restarts its container after a failed stopped copy, and recover restores an interrupted capture's intent", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const scratch = join(root, ".work/tmp");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "engine-capture-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    for (const leaf of ["log", "objects"]) mkdirSync(join(directory, "state", leaf), { recursive: true });
    const docker = `case "$*" in
      *"/var/lib/rivet/log"*) printf '%s\\n' "$CAPTURE_TEST/state/log" ;;
      *"/var/lib/rivet/objects"*) printf '%s\\n' "$CAPTURE_TEST/state/objects" ;;
      *"/etc/rivet/config.json"*) printf '%s\\n' "$CAPTURE_TEST/engine.json" ;;
      *".State.Running"*) if [ -e "$CAPTURE_TEST/stopped" ]; then echo false; else echo true; fi ;;
      *".State.ExitCode"*) echo 0 ;;
      *".Config.Image"*) echo 'test:engine sha256:test' ;;
      stop*) echo stop >> "$CAPTURE_TEST/trace"; : > "$CAPTURE_TEST/stopped" ;;
      start*) echo start >> "$CAPTURE_TEST/trace"; rm -f "$CAPTURE_TEST/stopped" ;;
      *) exit 99 ;;
    esac`;
    for (const [name, contents] of Object.entries({
      docker,
      flock: 'test "$CAPTURE_LOCKED" = 0',
      timeout: 'shift\nexec "$@"',
      rsync: 'test "$CAPTURE_COPY_FAILS" = 0',
      wget: 'test ! -e "$CAPTURE_TEST/stopped"',
      "rc-service": 'exit 3'
    })) writeFileSync(join(bin, name), `#!/bin/sh\n${contents}\n`, { mode: 0o700 });
    writeFileSync(join(directory, "engine.json"), "{}");
    const env = (locked: boolean, copyFails: boolean) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`,
      CAPTURE_TEST: directory, CAPTURE_LOCKED: locked ? "1" : "0", CAPTURE_COPY_FAILS: copyFails ? "1" : "0" });
    const script = join(root, "deploy/orange/recovery/capture-engine.sh");
    const run = (output: string, locked = false, copyFails = false) => spawnSync("sh", [
      script, "capture", "fixture-engine", join(directory, "state"), join(directory, output)
    ], { encoding: "utf8", env: env(locked, copyFails) });
    const trace = () => readFileSync(join(directory, "trace"), "utf8");
    const rejected = run("locked", true);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /already owns/u);
    assert.equal(existsSync(join(directory, "trace")), false);
    assert.equal(run("failed", false, true).status, 1);
    assert.equal(existsSync(join(directory, "failed")), false);
    assert.equal(existsSync(join(directory, "failed.partial", "captured-at")), true);
    assert.equal(trace(), "stop\nstart\n");
    assert.equal(existsSync(join(directory, "state", ".capture-intent")), false);
    const captured = run("sealed");
    assert.equal(captured.status, 0, captured.stderr);
    assert.equal(existsSync(join(directory, "sealed", "restarted-at")), true);
    assert.equal(trace(), "stop\nstart\nstop\nstart\n");
    writeFileSync(join(directory, "state", ".capture-intent"), "container fixture-engine\nrunning fixture-engine\n");
    writeFileSync(join(directory, "stopped"), "");
    assert.equal(run("blocked").status, 1);
    const recovered = spawnSync("sh", [script, "recover", join(directory, "state")], { encoding: "utf8", env: env(false, false) });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(trace(), "stop\nstart\nstop\nstart\nstart\n");
    assert.equal(existsSync(join(directory, "state", ".capture-intent")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
