import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inventory, ROOT, selectTests } from "./test-suites.ts";
import { processOwner } from "./processes.ts";
import type { BuildTarget } from "./ensure-build.ts";

export async function runTests(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    file: { type: "string", multiple: true }, suite: { type: "string", multiple: true }, name: { type: "string" },
    list: { type: "boolean" }, json: { type: "boolean" }, gate: { type: "boolean" }, jobs: { type: "string", default: "2" }
  } });
  const all = inventory();
  const selected = selectTests(all, { files: values.file, suites: values.suite });
  if (values.gate && values.file === undefined && values.suite === undefined) selected.push(...all.filter(test => test.owner === "browser"));
  const jobs = Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error("--jobs must be 1..8 (bounds total Node file concurrency)");
  const report = { discovered: all.length, selected: selected.length, optIn: all.filter(test => test.optIn).length, tests: values.list && values.file === undefined && values.suite === undefined ? all : selected };
  if (values.list) {
    console.log(values.json ? JSON.stringify(report, null, 2) : `${report.selected}/${report.discovered} default files; ${report.optIn} opt-in files\n${report.tests.map(test => `${test.file}\t${test.owner}\t${test.runner}\t${test.prerequisites.join(",") || "none"}${test.optIn ? "\topt-in" : ""}`).join("\n")}`);
    return;
  }
  console.log(`tests: selected ${selected.length}/${all.length} files; ${all.filter(test => test.optIn && !selected.includes(test)).length} explicit opt-in files excluded`);
  const owner = processOwner("tests");
  const env = { ...process.env };
  env["CLOUDFLARE_DEV_REGISTRY_PATH"] = join(owner.directory, "registry");
  try {
    const prerequisites = new Set(selected.flatMap(test => test.prerequisites));
    if (prerequisites.has("NANOSHOP_DIR") && process.env.NANOSHOP_DIR === undefined) throw new Error("producer-external needs NANOSHOP_DIR; see docs/testing.md");
    for (const variable of ["TANSU_DIR", "NICEFORGE_DIR"]) if (prerequisites.has(variable) && process.env[variable] === undefined) throw new Error(`services-external needs ${variable}; see docs/testing.md`);
    if (prerequisites.has("agent-debug")) await owner.run("agent-debug", "cargo", ["build", "--manifest-path", "../agent/Cargo.toml"], { cwd: ROOT, env: process.env });
    const targets = ["stats", "observe", "node"].filter(target => prerequisites.has(target)) as BuildTarget[];
    if (targets.length > 0) {
      const { ensureBuilds } = await import("./ensure-build.ts");
      const artifacts = await ensureBuilds(targets, { signal: owner.signal });
      for (const artifact of artifacts) if (artifact.target !== "node") env[artifact.target === "stats" ? "STATS_STATS_OUTPUT" : "STATS_OBSERVE_OUTPUT"] = join(artifact.output, "v0/workers/default");
      if (targets.includes("node")) env["STATS_NODE_ENTRYPOINT"] = (await import("./stage-node.ts")).stageNode(artifacts, owner.directory);
    }
    if (values.gate) {
      await owner.run("typecheck", "pnpm", ["run", "typecheck"], { cwd: ROOT, env: process.env });
      await owner.run("lint", "pnpm", ["run", "lint"], { cwd: ROOT, env: process.env });
    }
    for (const runner of ["node", "vitest", "playwright"]) {
      const files = selected.filter(test => test.runner === runner).map(test => test.file);
      if (files.length === 0) continue;
      const name = values.name;
      const countsPath = join(owner.directory, "node-counts.jsonl");
      const command = runner === "node" ? process.execPath : join(ROOT, `node_modules/.bin/${runner}`);
      const argv = runner === "node" ? ["--experimental-strip-types", "--test", `--test-concurrency=${jobs}`, "--test-reporter=spec", "--test-reporter-destination=stderr", `--test-reporter=${join(ROOT, "scripts/test-counts.ts")}`, `--test-reporter-destination=${countsPath}`, ...(name === undefined ? [] : [`--test-name-pattern=${name}`]), ...files]
        : runner === "vitest" ? ["run", "--maxWorkers", String(jobs), ...(name === undefined ? [] : ["-t", name]), ...files]
        : ["test", "--workers", String(jobs), ...(name === undefined ? [] : ["--grep", name]), ...files];
      console.log(`tests: ${runner} executing ${files.length} selected files`);
      await owner.run(runner, command, argv, { cwd: ROOT, env });
      if (runner === "node") {
        const counts = readFileSync(countsPath, "utf8").trim().split("\n").filter(Boolean).map(line => (JSON.parse(line) as { counts: { tests: number; skipped: number } }).counts);
        const tests = counts.reduce((total, count) => total + count.tests, 0);
        console.log(`tests: node completed ${tests} test cases (${counts.reduce((total, count) => total + count.skipped, 0)} skipped); summaries ${countsPath}`);
        if (name !== undefined && tests === 0) throw new Error(`unmatched test name filter: ${name}`);
      }
    }
  } finally { await owner.close(); }
}

