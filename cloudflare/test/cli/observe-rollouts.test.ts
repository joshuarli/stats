import assert from "node:assert/strict";
import { test } from "node:test";
import type { RolloutFinding, RolloutsPayload } from "../../src/cli/commands/observe-rollouts.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { authorized, deploymentHistory, fakeOrigin, projectEntry, runCli, sendJson, type FakeOrigin, type Handler } from "./support.ts";

const HOUR = 3_600_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const V_OLD = uuid(901);
const V_NEW = uuid(902);
const FINGERPRINT = "c".repeat(64);

interface Rollout {
  readonly id: string;
  readonly ageMs: number;
}

const settled = (n: number): Rollout => ({ id: uuid(n), ageMs: 5 * HOUR });
const young = (n: number): Rollout => ({ id: uuid(n), ageMs: HOUR });
const stale = (n: number): Rollout => ({ id: uuid(n), ageMs: 30 * HOUR });

const issue = { fingerprint: FINGERPRINT, name: "TypeError", operation: "request.checkout", frame: "pay (src/pay.ts:9)", occurrences: 4, firstAtMs: 1 };
const versions = (before: [number, number], after: [number, number]) => [
  { version: V_OLD, label: "v1", introduced: false, requests: before[0], failed: before[1] },
  { version: V_NEW, label: "v2", introduced: true, requests: after[0], failed: after[1] }
];
const routeSides = (before: [number, number], after: [number, number]) => ({
  stage: "worker", label: "GET /cart",
  versions: [before, after].map(([mean, stdErr], index) => ({ version: index === 0 ? V_OLD : V_NEW, requests: 1000, cpuMeanMs: mean, cpuStdErrMs: stdErr, p50CpuMs: mean, p95CpuMs: mean, p50WallMs: 1, p95WallMs: 2 }))
});

function impactFor(rollout: Rollout, nowMs: number, overrides: Record<string, unknown> = {}) {
  return {
    rolloutId: rollout.id, atMs: nowMs - rollout.ageMs, previousRolloutId: null, introduced: [V_NEW], state: "measured", baselineMs: HOUR,
    newIssues: [], regressions: [], versions: versions([1000, 10], [1000, 10]), routes: [routeSides([2, 0.1], [2, 0.1])], ...overrides
  };
}

interface Service {
  readonly rollouts: readonly Rollout[];
  readonly impact?: (rollout: Rollout) => Record<string, unknown>;
}

function handler(nowMs: number, services: Readonly<Record<string, Service>>): Handler {
  return (request, response) => {
    if (!authorized(request)) return void response.writeHead(401).end();
    const url = request.url ?? "";
    if (url === "/api/v1/projects") return sendJson(response, Object.keys(services).map(name => projectEntry(name, { worker: name })));
    for (const [name, service] of Object.entries(services)) {
      if (url === `/api/v1/projects/${name}/deployments`) {
        return sendJson(response, deploymentHistory(name, {
          worker: name,
          deployments: service.rollouts.map(rollout => ({ id: rollout.id, atMs: nowMs - rollout.ageMs, source: "wrangler", message: null, deferred: false, versions: [{ id: V_NEW, percentage: 100 }] }))
        }));
      }
      const impact = new RegExp(`^/api/observe/${name}/rollouts/([^/]+)/impact$`, "u").exec(url);
      if (impact !== null) {
        const rollout = service.rollouts.find(item => item.id === impact[1]);
        return rollout === undefined ? void response.writeHead(404).end() : sendJson(response, impactFor(rollout, nowMs, service.impact?.(rollout)));
      }
    }
    response.writeHead(404).end();
  };
}

async function check(services: Readonly<Record<string, Service>>, args: readonly string[], body: (result: { code: number | null; stdout: string; stderr: string; origin: FakeOrigin }) => void): Promise<void> {
  const origin = await fakeOrigin(handler(Date.now(), services));
  try {
    const result = await runCli(["observe", "rollouts", ...args, "--origin", origin.origin], {});
    body({ ...result, origin });
  } finally {
    await origin.close();
  }
}

const payload = (stdout: string) => (JSON.parse(stdout) as { payload: RolloutsPayload }).payload;
const impactRequests = (origin: FakeOrigin) => origin.seen.map(seen => seen.url).filter(url => url.includes("/impact"));

await test("nothing to report exits 0 with an empty findings list", async () => {
  await check({ stats: { rollouts: [settled(1)] } }, ["--json"], result => {
    assert.equal(result.code, EXIT.ok, result.stderr);
    const parsed = payload(result.stdout);
    assert.deepEqual(parsed.findings, []);
    assert.deepEqual(parsed.checked, [{ service: "stats", rollouts: 1 }]);
  });
  await check({ stats: { rollouts: [settled(1)] } }, [], result => {
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout, /1 checked, 0 with findings/u);
    assert.match(result.stdout, /nothing to report/u);
  });
});

await test("a new issue group is reported with its numbers and the drill-in commands, exit 8", async () => {
  await check({ stats: { rollouts: [settled(1)], impact: () => ({ newIssues: [issue] }) } }, ["--json"], result => {
    assert.equal(result.code, EXIT.findings, result.stderr);
    const [finding] = payload(result.stdout).findings as [RolloutFinding];
    assert.equal(finding.rolloutId, uuid(1));
    assert.equal(finding.service, "stats");
    assert.deepEqual(finding.versions, [{ id: V_NEW, label: "v2" }]);
    assert.deepEqual(finding.changes, [{ kind: "new-issue", fingerprint: FINGERPRINT, name: "TypeError", operation: "request.checkout", frame: "pay (src/pay.ts:9)", occurrences: 4 }]);
    assert.deepEqual(finding.drillIn, [
      `statsctl observe deployment --project stats --deployment ${uuid(1)} --json`,
      `statsctl observe issues --project stats --introduced-in ${V_NEW} --json`
    ]);
  });
  await check({ stats: { rollouts: [settled(1)], impact: () => ({ newIssues: [issue] }) } }, [], result => {
    assert.equal(result.code, EXIT.findings);
    assert.match(result.stdout, /new issue: TypeError \[request\.checkout\] pay \(src\/pay\.ts:9\) \(4 occurrences\)/u);
    assert.match(result.stdout, /drill in {2}statsctl observe deployment --project stats/u);
  });
});

await test("a regression is reported", async () => {
  await check({ stats: { rollouts: [settled(1)], impact: () => ({ regressions: [issue] }) } }, ["--json"], result => {
    assert.equal(result.code, EXIT.findings);
    assert.deepEqual(payload(result.stdout).findings[0]?.changes.map(change => change.kind), ["regression"]);
  });
});

await test("failure-rate and CPU changes beyond their spread are reported with numbers", async () => {
  const impact = () => ({ versions: versions([1000, 10], [1000, 100]), routes: [routeSides([2, 0.1], [5, 0.1])] });
  await check({ stats: { rollouts: [settled(1)], impact } }, ["--json"], result => {
    assert.equal(result.code, EXIT.findings);
    const changes = payload(result.stdout).findings[0]?.changes ?? [];
    const failure = changes.find(change => change.kind === "failure-rate");
    const cpu = changes.find(change => change.kind === "cpu");
    assert.ok(failure?.kind === "failure-rate" && Math.abs(failure.change - 0.09) < 1e-9 && failure.twoStdErr < 0.09);
    assert.ok(cpu?.kind === "cpu" && cpu.beforeMs === 2 && cpu.afterMs === 5 && cpu.changeMs === 3 && cpu.route === "GET /cart");
  });
});

await test("changes inside their spread are not reported", async () => {
  const impact = () => ({ versions: versions([1000, 10], [1000, 12]), routes: [routeSides([2, 0.5], [2.4, 0.5])] });
  await check({ stats: { rollouts: [settled(1)], impact } }, ["--json"], result => {
    assert.equal(result.code, EXIT.ok, result.stdout);
    assert.deepEqual(payload(result.stdout).findings, []);
  });
});

await test("a rollout younger than --settle or older than --within is not read", async () => {
  await check({ stats: { rollouts: [young(1), stale(2), settled(3)], impact: () => ({ newIssues: [issue] }) } }, ["--json"], result => {
    assert.equal(result.code, EXIT.findings);
    assert.deepEqual(impactRequests(result.origin), [`/api/observe/stats/rollouts/${uuid(3)}/impact`]);
    assert.deepEqual(payload(result.stdout).findings.map(finding => finding.rolloutId), [uuid(3)]);
  });
  await check({ stats: { rollouts: [young(1), stale(2)], impact: () => ({ newIssues: [issue] }) } }, ["--json"], result => {
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(impactRequests(result.origin), []);
  });
  await check({ stats: { rollouts: [young(1)], impact: () => ({ newIssues: [issue] }) } }, ["--json", "--settle", "30m"], result => {
    assert.equal(result.code, EXIT.findings);
  });
});

await test("without --project every observed service is checked and only the one with changes is reported", async () => {
  const services = {
    stats: { rollouts: [settled(1)] },
    "nanoshop-storied": { rollouts: [settled(2), settled(3)], impact: (rollout: Rollout) => rollout.id === uuid(3) ? { regressions: [issue] } : {} },
    "usr-memories": { rollouts: [] }
  };
  await check(services, ["--json"], result => {
    assert.equal(result.code, EXIT.findings, result.stderr);
    const parsed = payload(result.stdout);
    assert.deepEqual(parsed.checked, [{ service: "nanoshop-storied", rollouts: 2 }, { service: "stats", rollouts: 1 }, { service: "usr-memories", rollouts: 0 }]);
    assert.deepEqual(parsed.findings.map(finding => [finding.service, finding.rolloutId]), [["nanoshop-storied", uuid(3)]]);
  });
  await check(services, ["--json", "--project", "stats"], result => {
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(impactRequests(result.origin), [`/api/observe/stats/rollouts/${uuid(1)}/impact`]);
  });
});

await test("usage errors exit 2 before any impact read", async () => {
  for (const args of [["--settle", "2d", "--within", "1d"], ["--settle", "3 hours"], ["--project", "other"], ["--within", "3h"]]) {
    await check({ stats: { rollouts: [settled(1)] } }, [...args, "--json"], result => {
      assert.equal(result.code, EXIT.usage, args.join(" "));
      assert.deepEqual(impactRequests(result.origin), []);
    });
  }
});

await test("an unrecorded rollout is a contract failure, exit 4", async () => {
  const origin = await fakeOrigin((request, response) => {
    if (request.url === "/api/v1/projects") return sendJson(response, [projectEntry("stats", { worker: "stats" })]);
    if (request.url === "/api/v1/projects/stats/deployments") return sendJson(response, deploymentHistory("stats", { worker: "stats", deployments: [{ id: uuid(1), atMs: Date.now() - 5 * HOUR, source: "wrangler", message: null, deferred: false, versions: [{ id: V_NEW, percentage: 100 }] }] }));
    response.writeHead(404).end();
  });
  try {
    const result = await runCli(["observe", "rollouts", "--json", "--origin", origin.origin], {});
    assert.equal(result.code, EXIT.transport);
  } finally {
    await origin.close();
  }
});
