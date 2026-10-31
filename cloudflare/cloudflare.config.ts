import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const domain = process.env.NICEFORGE_TELEMETRY_DOMAIN;

export default defineConfig({
  worker: {
    name: "niceforge-telemetry",
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    exports: {
      Installation: exports.durableObject({ storage: "sqlite" })
    },
    env: {
      ENVIRONMENT: bindings.text("production"),
      INSTALLATION: bindings.durableObject({ worker: "niceforge-telemetry", exportName: "Installation" }),
      ASSETS: bindings.assets()
    },
    assets: { runWorkerFirst: true },
    workersDev: false,
    previewUrls: false,
    domains: domain === undefined ? [] : [domain]
  }
});
