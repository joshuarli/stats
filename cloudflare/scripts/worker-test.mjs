import { runTests } from "./run-tests.ts";

try { await runTests(["--gate", ...process.argv.slice(2)]); } catch (error) { console.error(error.message); process.exitCode ||= 1; }
