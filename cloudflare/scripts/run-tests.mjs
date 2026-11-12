import { runTests } from "./run-tests.ts";

try { await runTests(); } catch (error) { console.error(error.message); process.exitCode ||= 1; }
