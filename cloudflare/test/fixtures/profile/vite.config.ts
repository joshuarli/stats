import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [cloudflare()]
});
