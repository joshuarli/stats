import { defineConfig } from "vite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);

export default defineConfig({
  ssr: {
    noExternal: true
  },
  build: {
    ssr: "src/node/main.ts",
    outDir: join(REPO, ".work/tmp/node-bundle"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: "esm",
        entryFileNames: "main.mjs"
      }
    }
  }
});
