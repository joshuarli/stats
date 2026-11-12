import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { withWorkspace } from "./harness.ts";

const deployment = readFileSync(resolve(import.meta.dirname, "../../../deploy/node/deploy.sh"), "utf8");
const remote = deployment.split("<<'REMOTE'\n")[1]!.split("\nREMOTE")[0]!;
for (const failure of ["candidate", "replacement", "rename", "none"]) await test(`Node container replacement recovers from ${failure}`, async () => {
  await withWorkspace(async workspace => {
    writeFileSync(`${workspace.state}/stats-node`, "old");
    workspace.install("sleep", "exit 0");
    workspace.install("docker", `
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1" in
container) test -f "$STUB_STATE/$3" ;;
run) for argument; do case "$argument" in stats-node|stats-node-candidate) name=$argument;; esac; done; echo new > "$STUB_STATE/$name" ;;
exec) if [ "$2" = stats-node-candidate ] && [ "$FAILURE" = candidate ]; then exit 1; fi
      if [ "$2" = stats-node ] && [ "$FAILURE" = replacement ] && [ "$(cat "$STUB_STATE/stats-node")" = new ]; then exit 1; fi ;;
rename) if [ "$FAILURE" = rename ] && [ "$2" = stats-node ]; then exit 1; fi; mv "$STUB_STATE/$2" "$STUB_STATE/$3" ;;
rm) for argument; do case "$argument" in stats-node*) rm -f "$STUB_STATE/$argument";; esac; done ;;
stop|start|logs) exit 0 ;;
esac
`);
    const result = spawnSync("/bin/sh", ["-s", "--", "abc123", "owner@example.com"], { input: remote, env: { ...process.env, PATH: `${workspace.bin}:/usr/bin:/bin`, FAILURE: failure, STUB_STATE: workspace.state, STUB_LOG: workspace.log }, encoding: "utf8" });
    assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
    assert.equal(readFileSync(`${workspace.state}/stats-node`, "utf8").trim(), failure === "none" ? "new" : "old");
    const log = readFileSync(workspace.log, "utf8");
    if (failure === "candidate") assert.doesNotMatch(log, /stop -t/u);
    if (failure === "replacement") assert.match(log, /start stats-node/u);
  });
});
