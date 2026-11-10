import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const NAME = "profile-fixture";

export default defineConfig({
  worker: {
    name: NAME,
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    exports: {
      Ledger: exports.durableObject({ storage: "sqlite" })
    },
    env: {
      LEDGER: bindings.durableObject({ worker: NAME, exportName: "Ledger" }),
      MEDIA: bindings.r2({ name: "profile-fixture-media" }),
      GREETING: bindings.text("hello from the profile fixture")
    },
    workersDev: false,
    previewUrls: false
  }
});
