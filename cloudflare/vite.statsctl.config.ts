import { defineConfig } from "vite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);

function getVersion() {
  try {
    const cargo = readFileSync(join(REPO, "agent/Cargo.toml"), "utf8");
    const match = cargo.match(/^version = "([^"]+)"/m);
    if (match) return match[1];
  } catch {}
  return "0.1.0";
}

const version = getVersion();
const outFile = `statsctl-${version}.mjs`;

export default defineConfig({
  build: {
    ssr: "src/cli/statsctl.ts",
    outDir: join(REPO, "dist"),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        format: "es",
        entryFileNames: outFile,
        banner: `#!/usr/bin/env node
import { createRequire } from 'module'; const require = createRequire(import.meta.url);`
      }
    }
  }
});
