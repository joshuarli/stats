import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import { servedDocs } from "./scripts/served-docs.mjs";

export default defineConfig({
  plugins: [solid(), cloudflare(), servedDocs()]
});
