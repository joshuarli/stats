import test from "node:test";
import assert from "node:assert/strict";
import { rolloutsFromDeployments } from "../../src/observe/cloudflare/rollouts.ts";
import { prepareRollout } from "../../src/observe/core/model.ts";
import type { DeploymentHistory } from "../../src/deployments/model.ts";

const A = "2221f9c2-9bd2-4011-bebb-52133d498752";
const B = "dc8c3793-ef1e-4f93-9d67-6c2ca62021e2";

const history: DeploymentHistory = {
  projectId: "stats", worker: "stats", enabled: true, sync: null,
  deployments: [
    { id: "0b5b2c1e-0f0a-4c4a-9d8e-1a2b3c4d5e6f", atMs: 1_793_750_000_000, source: "Wrangler CLI", message: "split", deferred: false, versions: [{ id: A, percentage: 90 }, { id: B, percentage: 10 }] },
    { id: "1c6c3d2f-1a1b-4d5b-8e9f-2b3c4d5e6f70", atMs: 1_793_740_000_000, source: "api", message: null, deferred: false, versions: [{ id: B, percentage: 100 }] }
  ],
  versions: [{ id: A, tag: "v1.4.0", message: "rollouts" }, { id: B, tag: null, message: null }]
};

await test("Cloudflare deployments become valid rollouts with their traffic split and version tags", async () => {
  const batch = rolloutsFromDeployments(history);
  assert.deepEqual(batch.rollouts.map(rollout => [rollout.source, rollout.shares.map(share => `${share.version.slice(0, 8)}:${share.percent}`)]), [
    ["wrangler-cli", ["2221f9c2:90", "dc8c3793:10"]],
    ["api", ["dc8c3793:100"]]
  ]);
  assert.deepEqual(batch.versions.map(version => version.label), ["v1.4.0", null]);
  for (const rollout of batch.rollouts) assert.equal((await prepareRollout(rollout)).ok, true);
});
