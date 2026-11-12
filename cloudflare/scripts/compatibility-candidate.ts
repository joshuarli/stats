import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processOwner } from "./processes.ts";

const repo = resolve(import.meta.dirname, "../..");
mkdirSync(join(repo, ".work/tmp"), { recursive: true });
const results = mkdtempSync(join(repo, ".work/tmp/cloudflare-report-"));
const candidate = mkdtempSync(join(repo, ".work/tmp/cloudflare-checkout-"));
const owner = processOwner("cloudflare-candidate");
const metadata = (name: string, channel: string): { version: string; dependencies?: Record<string, string> } => JSON.parse(execFileSync("pnpm", ["view", `${name}@${channel}`, "--json"], { cwd: repo, encoding: "utf8" })) as { version: string; dependencies?: Record<string, string> };
const upstream = (repository: string, number: number): unknown => {
  try {
    const pull = JSON.parse(execFileSync("gh", ["api", `repos/cloudflare/${repository}/pulls/${number}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { html_url: string; state: string; draft: boolean; merged_at: string | null; merge_commit_sha: string | null; title: string };
    return { url: pull.html_url, title: pull.title, state: pull.state, draft: pull.draft, mergedAt: pull.merged_at, mergeCommit: pull.merge_commit_sha };
  } catch { return { repository, number, status: "unavailable; source/merge status is unverified" }; }
};
let created = false;
const report: Record<string, unknown> = { at: new Date().toISOString(), sourceAndMerge: [upstream("workers-sdk", 16684), upstream("workerd", 8176)], releaseContainment: "A merged PR is not proof of inclusion in a release; inspect the linked release before claiming adoption.", contracts: "not run" };
try {
  const vite = metadata("@cloudflare/vite-plugin", "beta");
  const vitest = metadata("@cloudflare/vitest-plugin", "latest");
  const cf = metadata("cf", "latest");
  const miniflare = vite.dependencies?.["miniflare"];
  if (miniflare === undefined || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(miniflare)) throw new Error("Vite beta does not select an exact Miniflare release; review the candidate group manually");
  const mf = metadata("miniflare", miniflare);
  report["sdkCandidates"] = { "@cloudflare/vite-plugin": vite.version, "@cloudflare/vitest-plugin": vitest.version, cf: cf.version, miniflare: mf.version, selectedWorkerd: mf.dependencies?.["workerd"] };
  report["newestWorkerd"] = metadata("workerd", "latest").version;
  await owner.run("checkout", "git", ["clone", "--shared", repo, candidate], { cwd: repo, env: process.env });
  created = true;
  appendFileSync(join(candidate, ".git/info/exclude"), "\n.work/\n");
  await owner.run("install", "pnpm", ["install", "--frozen-lockfile"], { cwd: candidate, env: process.env });
  await owner.run("candidate", "pnpm", ["--dir", "cloudflare", "add", "--save-dev", "--save-exact", `@cloudflare/vite-plugin@${vite.version}`, `@cloudflare/vitest-plugin@${vitest.version}`, `cf@${cf.version}`, `miniflare@${mf.version}`], { cwd: candidate, env: process.env });
  await owner.run("doctor", process.execPath, ["cloudflare/scripts/dev-doctor.ts", "--check"], { cwd: candidate, env: process.env });
  await owner.run("config", process.execPath, ["cloudflare/scripts/check-config.mjs"], { cwd: candidate, env: process.env });
  const inventory = await owner.run("inventory", process.execPath, ["cloudflare/scripts/run-tests.mjs", "--list", "--json"], { cwd: candidate, env: process.env });
  writeFileSync(join(results, "inventory.json"), readFileSync(inventory.logPath));
  await owner.run("smoke", "pnpm", ["--dir", "cloudflare", "run", "test:compat"], { cwd: candidate, env: process.env });
  await owner.run("types", "pnpm", ["--dir", "cloudflare", "run", "typecheck"], { cwd: candidate, env: process.env });
  report["contracts"] = "passed: resolved graph, configured dates, config validation, generated types, STB2/STA2 conformance, Worker/Node parity, auth, outbound guard, real tails, producer and R2 profile";
} catch (error) { report["failure"] = String(error); process.exitCode ||= 1; }
finally {
  if (created) writeFileSync(join(results, "proposed.diff"), execFileSync("git", ["diff", "--", "cloudflare/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], { cwd: candidate }));
  writeFileSync(join(results, "report.json"), JSON.stringify({ ...report, logs: owner.directory }, null, 2));
  await owner.close();
  rmSync(candidate, { recursive: true, force: true });
  console.log(`candidate report: ${results}; logs: ${owner.directory}`);
}
