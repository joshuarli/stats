import { bindings, defineConfig, exports, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "nanoshop-storied",
    compatibilityDate: "2026-09-17",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./worker/index.js",
    triggers: [triggers.scheduled({ schedule: "12 * * * *" })],
    tailConsumers: [{ worker: "stats-observe" }],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/static/*", "!/assets/*"],
    },
    exports: {
      TenantStore: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      TENANT_STORE: bindings.durableObject({
        worker: "nanoshop-storied",
        exportName: "TenantStore",
      }),
      ASSETS: bindings.assets(),
      MEDIA: bindings.r2({ name: "nanoshop-media-storied" }),
      STRIPE_SECRET_KEY: bindings.secret(),
      STRIPE_WEBHOOK_SECRET: bindings.secret(),
      STRIPE_WEBHOOK_SECRET_PREVIOUS: bindings.secret(),
      RESEND_API_KEY: bindings.secret(),
      ORDER_ACCESS_KEY: bindings.secret(),
    },
  },
});
