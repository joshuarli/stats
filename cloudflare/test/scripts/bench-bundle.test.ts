import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(root, "cloudflare/scripts/bench-bundle.mjs");

type BundleReport = { routes: { projects: { js: { gzip: number; raw: number } } } };
type ComparisonReport = { comparison: { routes: { projects: { needsReview: boolean } }; pass: boolean } };

await test("bundle growth above five percent requests review without imposing historical reductions", () => {
  const tmpRoot = join(root, ".work/tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(tmpRoot, "bundle-review-"));
  try {
    const assets = join(tmp, "assets");
    mkdirSync(assets);
    writeFileSync(join(tmp, "index.html"), '<script src="/assets/index-abcdefgh.js"></script><link rel="stylesheet" href="/assets/index-abcdefgh.css">');
    writeFileSync(join(assets, "index-abcdefgh.js"), 'import "./ProjectsPage-abcdefgh.js";');
    writeFileSync(join(assets, "ProjectsPage-abcdefgh.js"), 'export const label = "Projects";');
    writeFileSync(join(assets, "index-abcdefgh.css"), "body{color:black}");
    const baseline = JSON.parse(execFileSync(process.execPath, [script, "--assets", tmp, "--json"], { encoding: "utf8" })) as BundleReport;
    const gzip = baseline.routes.projects.js.gzip;
    baseline.routes.projects.js.gzip = Math.floor(baseline.routes.projects.js.gzip / 1.1);
    const baselinePath = join(tmp, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const result = spawnSync(process.execPath, [script, "--assets", tmp, "--compare", baselinePath, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const comparison = (JSON.parse(result.stdout) as ComparisonReport).comparison;
    assert.equal(comparison.routes.projects.needsReview, true);
    assert.equal(comparison.pass, true);
    baseline.routes.projects.js.gzip = gzip;
    baseline.routes.projects.js.raw = Math.floor(baseline.routes.projects.js.raw / 1.1);
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const rawResult = spawnSync(process.execPath, [script, "--assets", tmp, "--compare", baselinePath, "--json"], { encoding: "utf8" });
    assert.equal(rawResult.status, 0, rawResult.stderr);
    assert.equal((JSON.parse(rawResult.stdout) as ComparisonReport).comparison.routes.projects.needsReview, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
