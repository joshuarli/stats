import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/cloudflare/index.ts" with { type: "cf-worker" };
import { parseProjects, type ProjectConfig } from "./src/projects/config.ts";

const domain = process.env.STATS_DOMAIN;
const WORKER_NAME = "stats";

const PROJECTS: readonly ProjectConfig[] = [
  {
    id: "stuff",
    name: "stuff",
    worker: "stuff",
    workerBilling: "requests-and-cpu",
    buckets: ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"],
    durableObjectNamespaces: [],
    d1Databases: [],
    probes: [
      { name: "crates", url: "https://crates.17166969.xyz/current/registry/config.json" },
      { name: "npm", url: "https://npm.17166969.xyz/current/" },
      { name: "pypi", url: "https://pypi.17166969.xyz/current/simple/" },
      { name: "site", url: "https://stuff.17166969.xyz/" }
    ]
  },
  {
    id: "usr-memories",
    name: "usr-memories",
    worker: "usr-memories",
    workerBilling: "requests-and-cpu",
    buckets: ["usr-memories"],
    durableObjectNamespaces: [],
    d1Databases: ["9870c4da-3758-4f0c-ab6d-2372eb34009b"],
    probes: []
  },
  {
    id: "stats",
    name: "stats",
    worker: WORKER_NAME,
    workerBilling: "requests-and-cpu",
    buckets: [],
    durableObjectNamespaces: ["b25c2595ba784bb1bd51a87a3e87c62b"],
    d1Databases: [],
    probes: domain === undefined ? [] : [{ name: "health", url: `https://${domain}/health` }]
  },
  {
    id: "stats-observe",
    name: "stats-observe",
    worker: "stats-observe",
    workerBilling: "cpu-only",
    buckets: [],
    durableObjectNamespaces: ["ac72b89f443a4c8783b59755101cd1e5"],
    d1Databases: [],
    probes: []
  },
  {
    id: "nanoshop-storied",
    name: "nanoshop-storied",
    worker: "nanoshop-storied",
    workerBilling: "requests-and-cpu",
    buckets: [],
    durableObjectNamespaces: [],
    d1Databases: [],
    probes: []
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
      PROJECTS: bindings.text(PROJECTS_JSON),
      WORKER_NAME: bindings.text(WORKER_NAME),
      OBSERVE: bindings.worker({ worker: "stats-observe" })
    },
    triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
    tailConsumers: [{ worker: "stats-observe" }],
    assets: { runWorkerFirst: true },
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 0.1 },
      traces: { enabled: true, headSamplingRate: 0.1 }
    },
    ...(domain === undefined ? {} : { domains: [domain] })
  }
});
