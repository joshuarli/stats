import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const domain = process.env.STATS_DOMAIN;
const WORKER_NAME = "stats-worker";

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
      ASSETS: bindings.assets()
    },
    assets: { runWorkerFirst: true },
    workersDev: false,
    previewUrls: false,
    ...(domain === undefined ? {} : { domains: [domain] })
  }
});
