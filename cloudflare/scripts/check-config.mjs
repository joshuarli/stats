import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const checks = [
  ["workers_dev", /"workers_dev"\s*:\s*false/u],
  ["preview_urls", /"preview_urls"\s*:\s*false/u],
  ["run_worker_first", /"run_worker_first"\s*:\s*true/u],
  ["assets binding", /"binding"\s*:\s*"ASSETS"/u],
  ["production environment", /"ENVIRONMENT"\s*:\s*"production"/u]
];
const failures = checks.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
if (failures.length > 0) {
  console.error(`wrangler.jsonc: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("wrangler.jsonc: route and asset protections present");
