import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

await test("Engine configuration change writes the declared config only while stopped, verifies it took effect, and restores the previous one otherwise", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const scratch = join(root, ".work/tmp");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "engine-config-"));
  try {
    const bin = join(directory, "bin"), state = join(directory, "state");
    mkdirSync(bin);
    mkdirSync(state);
    const config = join(directory, "live-engine.json");
    const docker = `case "$*" in
      *"/etc/rivet/config.json"*) printf '%s\\n' "$T/live-engine.json" ;;
      *".State.Running"*) if [ -e "$T/stopped" ]; then echo false; else echo true; fi ;;
      *".State.ExitCode"*) echo 0 ;;
      stop*) echo stop >> "$T/trace"; : > "$T/stopped" ;;
      start*) echo "start $(cat "$T/live-engine.json")" >> "$T/trace"; rm -f "$T/stopped" ;;
      logs*) if [ "$ENGINE_IGNORES" = 1 ]; then printf 'message="resolved storage disk capacities" log_disk_bytes=136319336 log_configured=false cache_directory=/c cache_bytes=136319336 cache_configured=false\\n';
             else printf 'message="resolved storage disk capacities" log_disk_bytes=1073741824 log_configured=true cache_directory=/c cache_bytes=536870912 cache_configured=true\\n'; fi ;;
      *) exit 99 ;;
    esac`;
    for (const [name, contents] of Object.entries({
      docker,
      flock: "exit 0",
      wget: 'test ! -e "$T/stopped"',
      "rc-service": 'case "$2" in status) exit 0 ;; *) echo "$1 $2" >> "$T/trace" ;; esac'
    })) writeFileSync(join(bin, name), `#!/bin/sh\n${contents}\n`, { mode: 0o700 });
    const declared = '{"storage":{"log_shard":{"max_disk_bytes":1073741824},"cold_store":{"disk_cache_bytes":536870912}}}';
    writeFileSync(join(directory, "new.json"), declared);
    const script = join(root, "deploy/orange/recovery/engine-config.sh");
    const run = (args: string[], ignores = false) => spawnSync("sh", [script, ...args], { encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, T: directory, ENGINE_IGNORES: ignores ? "1" : "0" } });
    const apply = (ignores = false) => run(["apply", "live-stats-engine", config, join(directory, "new.json"), state], ignores);
    const trace = () => readFileSync(join(directory, "trace"), "utf8").trim().split("\n");

    writeFileSync(config, '{"old":true}');
    const refused = apply(true);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not the declared/u);
    assert.equal(readFileSync(config, "utf8"), '{"old":true}');
    assert.deepEqual(trace(), ["stats-infra-collector stop", "native-stats stop", "stop", `start ${declared}`, "stop", 'start {"old":true}', "native-stats start", "stats-infra-collector start"]);
    assert.equal(existsSync(join(state, ".config-intent")), false);

    rmSync(join(directory, "trace"));
    const applied = apply();
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(config, "utf8"), declared);
    assert.deepEqual(trace(), ["stats-infra-collector stop", "native-stats stop", "stop", `start ${declared}`, "native-stats start", "stats-infra-collector start"]);
    assert.match(apply().stdout, /already applied/u);

    rmSync(join(directory, "trace"));
    writeFileSync(join(state, ".config-intent"), `container live-stats-engine\nconfig ${config}\nstarted native-stats\n`);
    writeFileSync(join(state, ".config-intent.previous"), '{"old":true}');
    writeFileSync(join(directory, "stopped"), "");
    assert.equal(apply().status, 1);
    const recovered = run(["recover", state]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readFileSync(config, "utf8"), '{"old":true}');
    assert.deepEqual(trace(), ["stop", 'start {"old":true}', "native-stats start"]);
    assert.equal(existsSync(join(state, ".config-intent")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
