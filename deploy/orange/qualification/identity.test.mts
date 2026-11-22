import assert from "node:assert/strict";
import { test } from "node:test";
import { experimentIdentity } from "./identity.mts";

const runtime = (n: string) => ({ releaseId: `rt-${n.repeat(12)}`, artifactDigest: `sha256:${n.repeat(64)}` });
const app = (n: string) => ({ releaseId: `app-${n.repeat(12)}`, artifactDigest: `sha256:${n.repeat(64)}` });

test("the changed layer names the qualification", () => {
  assert.deepEqual(experimentIdentity({ runtime: runtime("1"), app: app("a") }, { runtime: runtime("2"), app: app("a") }), { layer: "runtime", baseline: runtime("1"), candidate: runtime("2") });
  assert.deepEqual(experimentIdentity({ runtime: runtime("1"), app: app("a") }, { runtime: runtime("1"), app: app("b") }), { layer: "app", baseline: app("a"), candidate: app("b") });
});

test("a combined change is attributed to the runtime and app pair", () => {
  const result = experimentIdentity({ runtime: runtime("1"), app: app("a") }, { runtime: runtime("2"), app: app("b") });
  assert.equal(result.layer, "combined");
  assert.equal(result.candidate.releaseId, `rt-${"2".repeat(12)}+app-${"b".repeat(12)}`);
  assert.match(result.candidate.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(result.candidate.artifactDigest, result.baseline.artifactDigest);
  assert.ok(result.candidate.releaseId.length <= 128 && !/\s/.test(result.candidate.releaseId));
});

test("identical deployments and relabelled identical bytes are refused", () => {
  assert.throws(() => experimentIdentity({ runtime: runtime("1"), app: app("a") }, { runtime: runtime("1"), app: app("a") }), /identical/);
  assert.throws(() => experimentIdentity({ runtime: runtime("1"), app: app("a") }, { runtime: { ...runtime("1"), releaseId: "rt-renamed0000" }, app: app("a") }), /identical/);
});
