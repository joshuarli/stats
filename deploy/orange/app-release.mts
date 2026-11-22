import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appDigest, appReleaseId } from "./qualification/manifest.mts";

const DESCRIPTOR_PARTS = ["stats", "observe", "stats.jsonc", "observe.jsonc"] as const;

export interface BuildStep { readonly name: string; readonly argv: readonly string[] }

/**
 * Builds the app release for `commit` into `app`, the format that standby deployment stages
 * and qualification compares. `run` executes each step and throws when it fails.
 */
export function buildApp(run: (step: BuildStep) => void, node: string, context: string, app: string, commit: string) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full hexadecimal object name");
  const release = `stats-${commit.slice(0, 12)}`;
  mkdirSync(app, { recursive: true });
  run({ name: "build", argv: ["sh", "deploy/orange/build-context.sh", context, commit.slice(0, 12)] });
  if (!readFileSync(join(context, "app/stats.jsonc"), "utf8").includes(`"APPLICATION_EVENTS_RELEASE": "${release}"`)) throw new Error(`built descriptor does not name ${release}`);
  for (const part of DESCRIPTOR_PARTS) cpSync(join(context, "app", part), join(app, part), { recursive: true });
  run({ name: "collector-build", argv: [node, "cloudflare/scripts/build-infra-collector.mjs", "--out", join(app, "collector")] });
  const digest = appDigest(app);
  return { release: appReleaseId(digest), digest, source: release };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "-h" || args[0] === "--help" || args.length !== 2 || args[0] !== "--out") {
    console.log("usage: node --experimental-strip-types deploy/orange/app-release.mts --out DIR\n\nBuilds the committed tree into a Stats app release directory (both Workers, their\ndescriptors and the infrastructure collector) and prints its release id and\nstats-app-manifest/1 digest. DIR must be new and under the repository's .work/tmp.\nThe same directory is what make standby-deploy stages and what\nqualification/promotion.mts takes as --baseline-app or --candidate-app.");
    process.exitCode = args[0] === "-h" || args[0] === "--help" ? 0 : 2;
    return;
  }
  const root = resolve(import.meta.dirname, "../..");
  process.chdir(root);
  process.env.TMPDIR = join(root, ".work/tmp");
  const out = resolve(args[1]!);
  if (!out.startsWith(join(root, ".work/tmp") + "/")) throw new Error("DIR must be under .work/tmp");
  if (existsSync(out)) throw new Error(`${out} already exists`);
  const git = (...argv: string[]) => spawnSync("git", ["-C", root, ...argv], { encoding: "utf8" }).stdout.trim();
  if (git("status", "--porcelain") !== "") throw new Error("commit or stash local changes first");
  const context = mkdtempSync(join(root, ".work/tmp/app-context-"));
  try {
    const built = buildApp(step => {
      const [file, ...rest] = step.argv;
      const result = spawnSync(file!, rest, { stdio: ["ignore", "inherit", "inherit"] });
      if (result.status !== 0) throw new Error(`${step.name} failed (exit ${result.status ?? "signal"})`);
    }, process.execPath, context, out, git("rev-parse", "HEAD"));
    console.log(JSON.stringify(built));
  } finally { rmSync(context, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`app-release: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
