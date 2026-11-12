import { ensureBuild } from "./ensure-build.ts";

try { await ensureBuild("node", { clean: process.argv.includes("--clean") }); }
catch (error) { console.error(error); process.exitCode ||= 1; }
