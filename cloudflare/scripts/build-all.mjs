import { ensureBuilds } from "./ensure-build.ts";

try { await ensureBuilds(["stats", "observe"], { clean: process.argv.includes("--clean") }); }
catch (error) { console.error(error); process.exitCode ||= 1; }
