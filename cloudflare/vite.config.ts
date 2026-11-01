import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";
import { defineConfig, type Plugin } from "vite";

const SERVED_DOCS = ["protocol.md", "architecture.md"] as const;

function servedDocs(): Plugin {
  return {
    name: "served-docs",
    applyToEnvironment: environment => environment.name === "client",
    generateBundle() {
      for (const name of SERVED_DOCS) {
        this.emitFile({ type: "asset", fileName: `docs/${name}`, source: readFileSync(new URL(`../docs/${name}`, import.meta.url)) });
      }
    }
  };
}

export default defineConfig({
  plugins: [solid(), cloudflare(), servedDocs()]
});
