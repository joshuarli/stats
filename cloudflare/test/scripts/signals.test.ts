import test from "node:test";
import assert from "node:assert/strict";
import { LOG_CALL, untilExists, withWorkspace, type Outcome, type Script } from "./harness.ts";

const BLOCKING = `${LOG_CALL}touch "$STUB_BLOCKED"\nsleep 1\n`;

const DEPLOY_HOST_SSH = `${LOG_CALL}for cmd; do :; done
case "$cmd" in
  *"test -f /etc/stats/agent.json"*) ;;
  *"rc-service stats status"*) exit 1 ;;
  *"cat /etc/stats/agent.json"*) echo '{"hostId":"h1"}' ;;
  "mktemp /tmp/stats.XXXXXX") echo /tmp/stats.t1 ;;
  "cat > '/tmp/stats.t1'") touch "$STUB_BLOCKED"; cat >/dev/null; sleep 1 ;;
esac
`;

async function interrupt(script: Script, args: readonly string[], signal: NodeJS.Signals): Promise<Outcome> {
  return withWorkspace(async workspace => {
    workspace.install("ssh", script === "deploy-host.sh" ? DEPLOY_HOST_SSH : BLOCKING);
    workspace.install("curl", script === "deploy-host.sh" ? `${LOG_CALL}echo '{"hosts":[{"hostId":"h1","lastReceivedAtMs":1}]}'\n` : BLOCKING);
    workspace.install("cf", "echo token\n");
    return workspace.run(script, args, {}, async (blocked, kill) => {
      await untilExists(blocked);
      kill(signal);
    });
  });
}

const SCRIPTS = [
  { script: "deployed-smoke.sh", args: [] },
  { script: "add-host.sh", args: ["lab", "root@lab"] },
  { script: "deploy-host.sh", args: ["threadripper"] }
] as const;

for (const { script, args } of SCRIPTS) {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    await test(`${script} stops with ${code} on ${signal} and removes its scratch state`, async () => {
      const outcome = await interrupt(script, args, signal);
      assert.equal(outcome.code, code);
      assert.deepEqual(outcome.leftovers, []);
      if (script !== "deploy-host.sh") assert.equal(outcome.log.length, 1);
    });
  }
}

await test("deploy-host.sh removes the remote temp file once and runs nothing after the signal", async () => {
  const outcome = await interrupt("deploy-host.sh", ["threadripper"], "SIGTERM");
  assert.equal(outcome.code, 143);
  assert.equal(outcome.log.filter(line => line.includes("rm -f '/tmp/stats.t1'")).length, 1);
  assert.match(outcome.log.at(-1) ?? "", /rm -f '\/tmp\/stats\.t1'/u);
});
