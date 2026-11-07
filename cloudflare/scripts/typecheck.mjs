import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const configs = [
  "tsconfig.json",
  "binary.tsconfig.json",
  "deployments.tsconfig.json",
  "observe.tsconfig.json"
];

const TSRS = join(ROOT, "node_modules/.bin/tsrs");

function check(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(TSRS, ["-p", config, "--noEmit", "--fast"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { output += chunk.toString("utf8"); });
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${config}:\n${output}`));
    });
  });
}

try {
  await Promise.all(configs.map(check));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
