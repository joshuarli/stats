import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandError, EXIT } from "../../src/cli/exit.ts";
import { POLICY_SCHEMA } from "../../src/cli/verify/policy.ts";
import { runCli, tokenEnv } from "./support.ts";
import { CANDIDATE, handler, harness, newWorld, POLICY } from "./verify-support.ts";
import { fakeOrigin } from "./support.ts";

interface Document {
  readonly error: { readonly code: string };
  readonly payload: { readonly readiness: unknown };
}

const document = (stdout: string) => JSON.parse(stdout) as Document;

await test("help verify explains every policy field, guardrail, and flag, offline", async () => {
  const { stdout, code } = await runCli(["help", "verify"]);
  assert.equal(code, EXIT.ok);
  for (const field of Object.keys(POLICY)) assert.ok(stdout.includes(`  ${field}`), field);
  for (const needle of [POLICY_SCHEMA, "waivedGuardrails", "never be waived", "ingest-persistence", "--safety-check-file", "--replay", "--readiness", "--wait", "precedence", "never a pass", "Exit codes", "readyAtMs", "SIGINT", "cpu-quantized-ms", "(persisted + duplicate) / received"]) assert.ok(stdout.includes(needle), needle);
});

await test("verify rejects a missing selector, a bad policy, and replay mixed with live options with exit 2", async () => {
  const origin = await fakeOrigin((_, response) => { response.end("{}"); });
  try {
    const bad = join(process.env["TMPDIR"] ?? "/tmp", "verify-cli-bad-policy.json");
    writeFileSync(bad, JSON.stringify({ ...POLICY, minChangePercent: 5 }));
    const cases: [string[], string][] = [
      [["verify", "--project", "stats", "--policy", bad, "--deployment", CANDIDATE.id], "policy_invalid"],
      [["verify", "--project", "stats", "--deployment", CANDIDATE.id], "usage"],
      [["verify", "--project", "stats", "--policy", bad], "usage"],
      [["verify", "--replay", "x.json", "--project", "stats"], "usage"],
      [["verify", "--project", "stats", "--deployment", CANDIDATE.id, "--policy", bad, "--wait", "--readiness"], "usage"]
    ];
    for (const [args, code] of cases) {
      const run = await runCli([...args, "--json", "--origin", origin.origin], tokenEnv());
      assert.equal(run.code, EXIT.usage, `${args.join(" ")}: ${run.stdout}${run.stderr}`);
      assert.equal(document(run.stdout).error.code, code, args.join(" "));
    }
    assert.equal(origin.connections(), 0);
  } finally {
    await origin.close();
  }
});

await test("a safety check file from another origin or without a result is refused", async () => {
  const h = await harness(newWorld());
  try {
    const other = h.safetyFile({}, "https://elsewhere.example");
    await assert.rejects(h.run({ deployment: CANDIDATE.id, "safety-check-file": other }), (error: unknown) => error instanceof CommandError && error.code === "safety_check_invalid");
    const errorOnly = join(h.directory, "error.json");
    writeFileSync(errorOnly, JSON.stringify({ schema: "statsctl/1", command: "check ingest", origin: h.origin.origin, error: { code: "unauthorized", message: "no" } }));
    await assert.rejects(h.run({ deployment: CANDIDATE.id, "safety-check-file": errorOnly }), (error: unknown) => error instanceof CommandError && error.code === "safety_check_invalid");
    assert.equal(h.origin.seen.length, 0);
  } finally {
    await h.close();
  }
});

await test("health --policy lists the policy's signals and a plain health leaves readiness empty", async () => {
  const world = newWorld();
  world.clock.now = Date.now();
  const origin = await fakeOrigin(handler(world));
  const h = await harness(world);
  try {
    const plain = await runCli(["health", "--project", "stats", "--json", "--origin", origin.origin], tokenEnv());
    assert.equal(plain.code, EXIT.ok, plain.stdout + plain.stderr);
    assert.deepEqual(document(plain.stdout).payload.readiness, { policy: null, signals: [] });
    const run = await runCli(["health", "--project", "stats", "--policy", h.policyFile, "--json", "--origin", origin.origin], tokenEnv());
    assert.equal(run.code, EXIT.ok, run.stdout + run.stderr);
    const readiness = document(run.stdout).payload.readiness as { policy: string; signals: { signal: string; status: string }[] };
    assert.equal(readiness.policy, POLICY.id);
    assert.deepEqual(readiness.signals.map(signal => signal.signal), ["analytics-collector", "deployment-history", "observe-events", "observe-invocations", "operation-summaries", "probes"]);
    assert.ok(readiness.signals.every(signal => signal.status === "available"), JSON.stringify(readiness.signals));
    const wrong = await runCli(["health", "--project", "alpha", "--policy", h.policyFile, "--json", "--origin", origin.origin], tokenEnv());
    assert.equal(wrong.code, EXIT.usage);
  } finally {
    await h.close();
    await origin.close();
  }
});
