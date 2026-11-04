import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "../src/observe/cloudflare/worker.ts" with { type: "cf-worker" };

const WORKER_NAME = "stats-observe";

export default defineConfig({
  worker: {
    name: WORKER_NAME,
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    exports: {
      ObservationStore: exports.durableObject({ storage: "sqlite" })
    },
    env: {
      STORE: bindings.durableObject({ worker: WORKER_NAME, exportName: "ObservationStore" })
    },
    triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
      traces: { enabled: false }
    }
  }
});
