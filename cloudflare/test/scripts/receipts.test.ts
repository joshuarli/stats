import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ARTIFACT, LOG_CALL, UNIT, withWorkspace, type Outcome, type Workspace } from "./harness.ts";

const ARTIFACT_HASH = createHash("sha256").update(ARTIFACT).digest("hex");

const SSH = `${LOG_CALL}for cmd; do :; done
case "$cmd" in
  *"test -f /etc/stats/agent.json"*) ;;
  *"rc-service stats status"*) [ -f "$STUB_STATE/restarted" ] || [ -n "$STUB_UNCHANGED" ] || exit 1 ;;
  *"rc-service stats restart"*) touch "$STUB_STATE/restarted" ;;
  *"cat /etc/stats/agent.json"*) echo '{"hostId":"h1"}' ;;
  *"sha256sum /usr/local/bin/stats"*) [ -z "$STUB_UNCHANGED" ] || echo "${ARTIFACT_HASH}" ;;
  *"cat '/etc/init.d/stats'"*) [ -z "$STUB_UNCHANGED" ] || printf '%s' "${UNIT}" ;;
  "mktemp /tmp/stats.XXXXXX") echo /tmp/stats.t1 ;;
esac
cat >/dev/null 2>&1 || true
`;

const CURL = `${LOG_CALL}count() { n=$(cat "$STUB_STATE/$1" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_STATE/$1"; echo "$n"; }
calls=$(count curl)
receipt=1
if [ -f "$STUB_STATE/restarted" ]; then
  receipt=2
  since=$(count since_restart)
  [ "$STUB_NEW_AGENT_UPLOADS" != yes ] || [ "$since" -lt 3 ] || receipt=3
elif [ -n "$STUB_UNCHANGED" ] && [ "$STUB_NEW_AGENT_UPLOADS" = yes ] && [ "$calls" -ge 3 ]; then
  receipt=2
fi
echo "{\\"hosts\\":[{\\"hostId\\":\\"h1\\",\\"lastReceivedAtMs\\":$receipt}]}"
`;

function stubs(workspace: Workspace): void {
  workspace.install("ssh", SSH);
  workspace.install("curl", CURL);
  workspace.install("cf", "echo token\n");
  workspace.install("sleep", "exit 0\n");
  workspace.install("date", `n=$(cat "$STUB_STATE/clock" 2>/dev/null || echo 0); n=$((n + 30)); echo "$n" > "$STUB_STATE/clock"; echo "$n"\n`);
}

function deploy(env: Record<string, string>): Promise<Outcome> {
  return withWorkspace(async workspace => {
    stubs(workspace);
    return workspace.run("deploy-host.sh", ["threadripper"], env);
  });
}

await test("an upload from the old agent during the restart does not prove the new binary", async () => {
  const outcome = await deploy({ STUB_NEW_AGENT_UPLOADS: "no" });
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.stderr, /no fresh receipt/u);
  assert.doesNotMatch(outcome.stdout, /deployed/u);
});

await test("a receipt after the restart proves the new binary", async () => {
  const outcome = await deploy({ STUB_NEW_AGENT_UPLOADS: "yes" });
  assert.equal(outcome.code, 0);
  assert.match(outcome.stdout, /threadripper: deployed/u);
});

await test("an unchanged host that is not uploading fails instead of reporting unchanged", async () => {
  const outcome = await deploy({ STUB_UNCHANGED: "yes", STUB_NEW_AGENT_UPLOADS: "no" });
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.stderr, /no fresh receipt/u);
  assert.doesNotMatch(outcome.stdout, /unchanged/u);
});

await test("an unchanged host that keeps uploading reports unchanged", async () => {
  const outcome = await deploy({ STUB_UNCHANGED: "yes", STUB_NEW_AGENT_UPLOADS: "yes" });
  assert.equal(outcome.code, 0);
  assert.match(outcome.stdout, /threadripper: unchanged/u);
  assert.ok(outcome.log.filter(line => line.startsWith("curl")).length >= 3);
});
