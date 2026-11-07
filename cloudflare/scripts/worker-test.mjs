import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const VITEST = join(ROOT, "node_modules/.bin/vitest");
const PLAYWRIGHT = join(ROOT, "node_modules/.bin/playwright");
const OXLINT = join(ROOT, "node_modules/.bin/oxlint");

const active = new Set();

function terminate() {
  for (const child of active) {
    try { child.kill("SIGTERM"); } catch {}
  }
}

process.on("SIGINT", () => { terminate(); process.exit(130); });
process.on("SIGTERM", () => { terminate(); process.exit(143); });

function run(name, command, args) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    active.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("close", code => {
      active.delete(child);
      const elapsed = ((performance.now() - started) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`✓ ${name} (${elapsed}s)`);
        resolve();
      } else {
        const error = new Error(`✗ ${name} (exit ${code}, ${elapsed}s):\n${stdout}\n${stderr}`);
        terminate();
        reject(error);
      }
    });
  });
}

const unitArgs = ["--experimental-strip-types", "--test",
  "test/binary/codecs.test.ts", "test/binary/frames.test.ts", "test/binary/records.test.ts", "test/binary/streams.test.ts",
  "test/ingest/decoder.test.ts", "test/ingest/encoder.test.ts",
  "test/deployments/core.test.ts", "test/deployments/github.test.ts", "test/deployments/marker.test.ts", "test/deployments/routes.test.ts",
  "test/cost/pricing.test.ts",
  "test/scripts/capture.test.ts",
  "test/observe/budget.test.ts", "test/observe/cloudflare-tail.test.ts", "test/observe/count-buffer.test.ts", "test/observe/determinism.test.ts", "test/observe/nanoshop.test.ts", "test/observe/policies.test.ts", "test/observe/pricing.test.ts", "test/observe/store.test.ts", "test/observe/tail.test.ts",
  "test/node/assets.test.ts", "test/node/http-parity.test.ts", "test/node/observe-ingest.test.ts", "test/node/server.test.ts"
];

const cliArgs = ["--experimental-strip-types", "--test",
  "test/cli/check.test.ts", "test/cli/compare.test.ts", "test/cli/config.test.ts", "test/cli/contract.test.ts", "test/cli/cost.test.ts", "test/cli/curl.test.ts", "test/cli/deploy.test.ts", "test/cli/export.test.ts", "test/cli/health.test.ts", "test/cli/help.test.ts", "test/cli/history.test.ts", "test/cli/hosts.test.ts", "test/cli/observe.test.ts", "test/cli/observe-verify.test.ts", "test/cli/routes.test.ts", "test/cli/service-admin.test.ts", "test/cli/service-credentials.test.ts", "test/cli/service-mark.test.ts", "test/cli/snapshot.test.ts", "test/cli/target.test.ts", "test/cli/verify.test.ts"
];

const observeE2eArgs = ["--experimental-strip-types", "--test",
  "test/observe-e2e/agent-memory.test.ts", "test/observe-e2e/external.test.ts", "test/observe-e2e/sampling.test.ts", "test/observe-e2e/sourcemap.test.ts", "test/observe-e2e/tail.test.ts", "test/observe-e2e/trace-determinism.test.ts"
];

const scenariosArgs = ["--experimental-strip-types", "--test", "test/local/scenarios.test.ts"];

const localOtherArgs = ["--experimental-strip-types", "--test",
  "test/local/analytics.test.ts", "test/local/bench.test.ts", "test/local/collection.test.ts", "test/local/launcher.test.ts", "test/local/outbound.test.ts", "test/local/producer.test.ts", "test/local/stack.test.ts", "test/local/topology.test.ts", "test/local/upgrade.test.ts"
];

try {
  await Promise.all([
    run("build assets and workers", NODE, [join(ROOT, "scripts/build-all.mjs")]),
    run("typecheck", NODE, [join(ROOT, "scripts/typecheck.mjs")]),
    run("oxlint", OXLINT, ["--type-aware", "src", "test", "bench", "observe-worker", "vite.config.ts", "playwright.config.ts"])
  ]);
  await Promise.all([
    run("unit tests", NODE, unitArgs),
    run("cli tests", NODE, cliArgs)
  ]);
  await Promise.all([
    run("observe e2e tests", NODE, observeE2eArgs),
    run("worker vitest", VITEST, ["run"]),
    run("local scenarios", NODE, scenariosArgs),
    run("local stack tests", NODE, localOtherArgs)
  ]);
  await run("playwright ui", PLAYWRIGHT, ["test"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
