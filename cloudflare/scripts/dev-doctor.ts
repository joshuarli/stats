import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
function packageAt(file: string): { readonly path: string; readonly version: string } {
  let directory = dirname(file);
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`no package for ${file}`);
    directory = parent;
  }
  const data = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version: string };
  return { path: directory, version: data.version };
}

export function runtimeVersions(root = ROOT) {
  return ["miniflare", "@cloudflare/vite-plugin", "@cloudflare/vitest-plugin", "cf"].map(consumer => {
    const directory = realpathSync(join(root, "node_modules", consumer));
    const local = createRequire(join(directory, "package.json"));
    const miniflare = consumer === "miniflare" ? packageAt(join(directory, "index.js")) : packageAt(local.resolve("miniflare"));
    const workerd = packageAt(createRequire(join(miniflare.path, "package.json")).resolve("workerd"));
    return { consumer, ...packageAt(join(directory, "index.js")), miniflare, workerd };
  });
}

export function doctor(root = ROOT) {
  const repo = dirname(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  return {
    revision: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "",
    lockfileSha256: createHash("sha256").update(readFileSync(join(repo, "pnpm-lock.yaml"))).digest("hex"),
    fixturesSha256: createHash("sha256").update(readFileSync(join(repo, "fixtures/v2/manifest.json"))).digest("hex"),
    node: process.version, pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    os: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, cores: cpus().length,
    runtimes: runtimeVersions(root),
    supportedCompatibility: JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", 'import { getLocalWorkerdCompatibilityDate } from "@cloudflare/vite-plugin"; console.log(JSON.stringify(getLocalWorkerdCompatibilityDate()));'], { cwd: root, encoding: "utf8" })) as { readonly date: string; readonly source: string },
    compatibility: ["cloudflare.config.ts", "observe-worker/cloudflare.config.ts"].map(file => ({ file, date: /compatibilityDate: "([^"]+)"/u.exec(readFileSync(join(root, file), "utf8"))?.[1] }))
  };
}

if (import.meta.main) {
  const report = doctor();
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--check")) {
    const miniflare = new Set(report.runtimes.map(runtime => runtime.miniflare.version));
    const workerd = new Set(report.runtimes.map(runtime => runtime.workerd.version));
    if (miniflare.size !== 1 || workerd.size !== 1 || report.supportedCompatibility.source !== "workerd" || report.compatibility.some(config => config.date === undefined || config.date > report.supportedCompatibility.date)) process.exitCode = 1;
  }
}
