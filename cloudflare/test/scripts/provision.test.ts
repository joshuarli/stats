import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withWorkspace } from "./harness.ts";

for (const os of ["Darwin", "Linux"]) await test(`reprovisioning ${os} preserves optional collection settings`, async () => {
  await withWorkspace(async workspace => {
    const tree = resolve(workspace.tmp, "../..");
    mkdirSync(join(tree, "agent/target/release"), { recursive: true });
    mkdirSync(join(tree, "agent/contrib/launchd"), { recursive: true });
    writeFileSync(join(tree, "agent/target/release/stats"), "binary");
    writeFileSync(join(tree, "agent/dist/stats-9.9.9-aarch64-unknown-linux-musl"), "binary");
    copyFileSync(resolve(import.meta.dirname, "../../../agent/contrib/launchd/xyz.17166969.stats.plist"), join(tree, "agent/contrib/launchd/xyz.17166969.stats.plist"));
    const existing = { endpoint: "https://old.example.com", hostId: "h1", tokenFile: "/old/token", services: [{ name: "web", unit: "web.service" }], includeVirtualFilesystems: true, sampleIntervalMs: 1000, includeVirtualInterfaces: true };
    writeFileSync(join(workspace.state, "existing.json"), JSON.stringify(existing));
    writeFileSync(join(workspace.state, "ssh.mjs"), `
import { readFileSync, writeFileSync } from "node:fs";
const command = process.argv.at(-1);
const marker = command.match(/__STATS_STATUS_\\d+__/u)[0];
let output = "";
if (command.includes("uname -s")) output = "${os}";
else if (command.includes("uname -m")) output = "arm64";
else if (command.includes('printf %s')) output = "/home/owner";
else if (command.includes("cat >") && command.includes("agent.json.new")) writeFileSync(process.env.STUB_STATE + "/installed.json", readFileSync(0));
else if (command.includes("cat ") && command.includes("agent.json")) output = readFileSync(process.env.STUB_STATE + "/existing.json", "utf8");
else if (command.includes("id -u")) output = "1000";
if (output) process.stdout.write(output + "\\n");
process.stderr.write("\\n" + marker + "0\\n");
`);
    workspace.install("ssh", `exec '${process.execPath}' "$STUB_STATE/ssh.mjs" "$@"`);
    workspace.install("uname", `case "$1" in -s) echo Darwin;; -m) echo arm64;; esac`);
    workspace.install("cf", "echo access-token");
    workspace.install("curl", `n=$(cat "$STUB_STATE/receipts" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_STATE/receipts"; echo "{\\"hosts\\":[{\\"hostId\\":\\"h1\\",\\"name\\":\\"lab\\",\\"lastReceivedAtMs\\":$n}]}"`);
    const result = await workspace.run("add-host.sh", ["lab", "root@lab"], {});
    assert.equal(result.code, 0, result.stderr);
    const installed = JSON.parse(readFileSync(join(workspace.state, "installed.json"), "utf8"));
    assert.deepEqual(installed, { ...existing, endpoint: "https://stats.17166969.xyz", tokenFile: os === "Linux" ? "/etc/stats/token" : "/home/owner/.config/stats/token" });
  });
});
