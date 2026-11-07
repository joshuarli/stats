import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE = join(ROOT, "node_modules/.bin/vite");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", env: process.env });
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

await run("node", [join(ROOT, "scripts/check-config.mjs")]);
await run("pnpm", ["--filter", "@joshuarli/ui", "build"]);
await Promise.all([
  run(VITE, ["build"]),
  run(VITE, ["build", "--config", "observe-worker/vite.config.ts"])
]);
