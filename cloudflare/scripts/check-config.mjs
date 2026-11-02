import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
const checks = [
  ["worker name", /const WORKER_NAME = "stats"/u],
  ["workers_dev", /workersDev:\s*false/u],
  ["preview_urls", /previewUrls:\s*false/u],
  ["run_worker_first", /runWorkerFirst:\s*true/u],
  ["assets binding", /ASSETS:\s*bindings\.assets\(\)/u],
  ["production environment", /ENVIRONMENT:\s*bindings\.text\("production"\)/u],
  ["sqlite export", /Installation:\s*exports\.durableObject\(\{\s*storage:\s*"sqlite"\s*\}\)/u],
  ["workers logs", /observability:\s*\{[\s\S]*?enabled:\s*true/u],
  ["log sampling", /logs:\s*\{[\s\S]*?headSamplingRate:\s*0\.1/u],
  ["trace sampling", /traces:\s*\{\s*enabled:\s*true,\s*headSamplingRate:\s*0\.1\s*\}/u]
];
const failures = checks.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
if (failures.length > 0) {
  console.error(`cloudflare.config.ts: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("cloudflare.config.ts: route, asset, and Durable Object protections present");
