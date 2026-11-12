import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE = join(ROOT, "node_modules/.bin/vite");

await new Promise((resolve, reject) => {
  const child = spawn(VITE, ["build", "--config", "vite.node.config.ts"], { cwd: ROOT, stdio: "inherit", env: process.env });
  child.on("close", code => {
    if (code === 0) resolve();
    else reject(new Error(`vite build exited ${code}`));
  });
});
