import { build } from "esbuild";
await build({ entryPoints: ["src/node/main.ts"], outfile: "../.work/tmp/node-bundle/main.mjs", bundle: true, platform: "node", format: "esm", target: "node26", packages: "bundle" });
