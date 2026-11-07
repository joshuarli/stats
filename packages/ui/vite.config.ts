import { resolve } from "node:path";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [solid()],
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [
        "solid-js",
        "solid-js/web",
        "@solidjs/web",
        "@solidjs/web/jsx-runtime",
      ],
    },
    emptyOutDir: false,
  },
});
