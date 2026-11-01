import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { parseProjects, type ProjectConfig } from "./src/projects/config.ts";

const domain = process.env.STATS_DOMAIN;
const WORKER_NAME = "stats";

const PROJECTS: readonly ProjectConfig[] = [
  {
    id: "stuff",
    name: "stuff",
    worker: "stuff",
    buckets: ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"],
    probes: [
      { name: "crates", url: "https://crates.17166969.xyz/current/registry/config.json" },
      { name: "npm", url: "https://npm.17166969.xyz/current/" },
      { name: "pypi", url: "https://pypi.17166969.xyz/current/simple/" },
      { name: "site", url: "https://stuff.17166969.xyz/" }
    ]
  }
];
const PROJECTS_JSON = JSON.stringify(PROJECTS);
parseProjects(PROJECTS_JSON);

export default defineConfig({
  worker: {
    name: WORKER_NAME,
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    exports: {
      Installation: exports.durableObject({ storage: "sqlite" })
    },
    env: {
      ENVIRONMENT: bindings.text("production"),
      INSTALLATION: bindings.durableObject({ worker: WORKER_NAME, exportName: "Installation" }),
      ASSETS: bindings.assets(),
      ANALYTICS_SQL: bindings.analytics(),
      PROJECTS: bindings.text(PROJECTS_JSON)
    },
    triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
    assets: { runWorkerFirst: true },
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 0.1 }
    },
    ...(domain === undefined ? {} : { domains: [domain] })
  }
});
