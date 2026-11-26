import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApp } from "./app-release.mts";

const HOST = "stats-standby", ROUTE_HOST = "lisa", BOUND_S = 300, DEADLINE_S = 300;
const READY_S = 120;
const LIMITS = { observe: 120000, authority: 30000, remote: 30000, build: 600000, test: 900000, stage: 600000, start: 1800000 };
const EXIT = { promoted: 0, notPromoted: 3, lockHeld: 4, needsOperator: 5 } as const;

export interface Run { readonly status: number; readonly stdout: string }
export interface RunOptions { readonly timeoutMs: number; readonly log?: string }
export interface StandbyEffects {
  readonly mode: "check" | "deploy";
  readonly root: string;
  readonly state: string;
  readonly sshConfig: string;
  readonly rollout: string;
  readonly hosts: string | undefined;
  readonly statsctl: string | undefined;
  readonly node: string;
  readonly run: (file: string, args: readonly string[], options: RunOptions) => Run;
  readonly report: (message: string) => void;
  readonly now: () => number;
}
export interface Check { readonly name: string; readonly argv: readonly string[]; readonly exitCode: number; readonly log: string }
export interface AdmissionSpec {
  readonly baseline: { readonly releaseId: string; readonly artifactDigest: string };
  readonly candidate: { readonly releaseId: string; readonly artifactDigest: string; readonly components: { readonly runtime: string } };
  readonly source: { readonly repository: string; readonly commit: string };
  readonly checks: readonly Check[];
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function evidenceFiles(root: string, directory = root): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), info = lstatSync(path);
    if (info.isDirectory()) return evidenceFiles(root, path);
    if (!info.isFile()) throw new Error(`evidence may hold only regular files: ${path}`);
    return [relative(root, path).split(sep).join("/")];
  });
}

/** Builds the stats-app-admission/1 receipt that Stuff's rollout controller verifies for native-app releases. */
export function admissionReceipt(spec: AdmissionSpec, evidence: string, now: number) {
  const inputs = evidenceFiles(evidence).sort().map(path => {
    const data = readFileSync(join(evidence, path));
    return { path, sha256: sha256(data), bytes: data.length };
  });
  const listed = new Set(inputs.map(item => item.path));
  if (spec.checks.length === 0) throw new Error("admission needs at least one check");
  for (const check of spec.checks) if (!listed.has(check.log)) throw new Error(`check ${check.name} log ${check.log} is not in the evidence`);
  const reasonCodes = spec.checks.filter(check => check.exitCode !== 0).map(check => `check-failed:${check.name}`);
  return {
    schema: "stats-app-admission/1",
    baseline: spec.baseline,
    candidate: spec.candidate,
    source: spec.source,
    checks: spec.checks,
    inputs,
    decision: { verdict: reasonCodes.length ? "refused" : "admitted", reasonCodes, evaluatedAtMs: now },
    createdAtMs: now,
  };
}

function json(run: Run, what: string): Record<string, unknown> {
  if (run.status !== 0) throw new Error(`${what} failed (exit ${run.status})`);
  const value: unknown = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} returned no JSON object`);
  return value as Record<string, unknown>;
}
const text = (value: unknown, what: string) => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${what} is unknown`);
  return value;
};

export type Outcome = "checked" | "unchanged" | "promoted" | "not-promoted" | "lock-held" | "needs-operator";

export function deployStandby(effects: StandbyEffects): Outcome {
  const { root, sshConfig, rollout, run, report } = effects;
  const observed = json(run(rollout, ["observe", "--target-kind", "native-app", "--host", HOST, "--ssh-config", sshConfig, "--json"], { timeoutMs: LIMITS.observe }), "observing the standby app");
  const baseline = text(observed.selected, "the standby's selected app");
  if (observed.running !== baseline) throw new Error(`the standby runs ${String(observed.running)}, not its selected app ${baseline}`);
  const baselineDigest = text(observed.digest, "the standby app digest");
  const components = observed.components as Record<string, unknown> | undefined;
  const runtime = text(components?.runtime, "the standby's selected runtime");
  const authority = json(run(effects.node, [join(root, "deploy/orange/writer-authority.mjs"), "--route-host", ROUTE_HOST], { timeoutMs: LIMITS.authority }), "reading writer authority");
  if (authority.ok !== true) throw new Error(`${ROUTE_HOST}'s recovery route does not name the standby as the Stats writer`);
  const pins = run("ssh", ["-F", sshConfig, "-o", "BatchMode=yes", HOST, "sha256sum /opt/native-rehearsal/orange/package.json /opt/native-rehearsal/orange/pnpm-lock.yaml"], { timeoutMs: LIMITS.remote });
  if (pins.status !== 0) throw new Error("cannot read the standby runtime pins");
  const remote = new Map(pins.stdout.trim().split("\n").map(line => { const [sum, path] = line.split(/\s+/); return [path?.split("/").at(-1), sum]; }));
  for (const file of ["package.json", "pnpm-lock.yaml"]) {
    if (remote.get(file) !== sha256(readFileSync(join(root, "deploy/orange", file)))) throw new Error(`deploy/orange/${file} differs from the standby runtime; roll out a matching runtime first`);
  }
  report(`standby runs ${baseline} on runtime ${runtime}; runtime pins match`);
  if (effects.mode === "check") return "checked";

  const hosts = text(effects.hosts, "STATS_CHECK_HOSTS");
  const statsctl = text(effects.statsctl, "STATSCTL");
  if (run("git", ["-C", root, "status", "--porcelain"], { timeoutMs: LIMITS.remote }).stdout.trim() !== "") throw new Error("commit or stash local changes first");
  const commit = run("git", ["-C", root, "rev-parse", "HEAD"], { timeoutMs: LIMITS.remote }).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("cannot read the commit");
  const release = `stats-${commit.slice(0, 12)}`;
  mkdirSync(join(root, ".work/tmp"), { recursive: true });
  const work = mkdtempSync(join(root, ".work/tmp/standby-"));
  const evidence = join(work, "evidence"), app = join(work, "release"), context = join(work, "ctx");
  mkdirSync(evidence); mkdirSync(app);
  const checks: Check[] = [];
  const admit = (name: string, argv: readonly string[], timeoutMs: number) => {
    report(`admission check ${name}`);
    const log = `${name}.log`;
    const [file, ...args] = argv;
    const result = run(file!, args, { timeoutMs, log: join(evidence, log) });
    checks.push({ name, argv: [...argv], exitCode: result.status, log });
    if (result.status !== 0) throw new Error(`admission check ${name} failed; see ${join(evidence, log)}`);
  };
  const built = buildApp(step => admit(step.name, step.argv, LIMITS.build), effects.node, context, app, commit);
  admit("cloudflare-test", ["make", "cloudflare-test"], LIMITS.test);

  const staged = json(run(rollout, ["stage", "--target-kind", "native-app", "--host", HOST, "--ssh-config", sshConfig, "--dir", app, "--source", `stats@${commit}`, "--bound-s", String(BOUND_S)], { timeoutMs: LIMITS.stage }), "staging the app release");
  const candidate = text(staged.release, "the staged release"), digest = text(staged.digest, "the staged digest");
  if (candidate !== built.release || digest !== built.digest) throw new Error(`the guest staged ${candidate} (${digest}), not the local build ${built.release} (${built.digest})`);
  rmSync(context, { recursive: true, force: true });
  if (candidate === baseline) {
    report(`standby already runs ${candidate} (${release})`);
    rmSync(work, { recursive: true, force: true });
    return "unchanged";
  }

  const record = join(effects.state, "apps", candidate, new Date(effects.now()).toISOString().replaceAll(":", ""));
  mkdirSync(join(record, "tools"), { recursive: true });
  cpSync(evidence, join(record, "evidence"), { recursive: true });
  for (const tool of ["functional-check.mjs", "writer-authority.mjs"]) copyFileSync(join(root, "deploy/orange", tool), join(record, "tools", tool));
  const receipt = admissionReceipt({ baseline: { releaseId: baseline, artifactDigest: baselineDigest }, candidate: { releaseId: candidate, artifactDigest: digest, components: { runtime } }, source: { repository: "joshuarli/stats", commit }, checks }, join(record, "evidence"), effects.now());
  writeFileSync(join(record, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  const policy = {
    max_age_s: 3600, ready_s: READY_S, observation_s: 120, check_interval_s: 30,
    functional_check: { argv: [effects.node, join(record, "tools/functional-check.mjs"), "--target-kind", "native-app", "--ssh-config", sshConfig, "--host", HOST, "--hosts", hosts, "--statsctl", statsctl, "--rollout", rollout], timeout_s: 120 },
    authority_check: { argv: [effects.node, join(record, "tools/writer-authority.mjs"), "--route-host", ROUTE_HOST], timeout_s: 30 },
  };
  writeFileSync(join(record, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx" });
  rmSync(work, { recursive: true, force: true });

  report(`activating ${candidate} (${release}) over ${baseline}; admission record ${record}`);
  const journals = join(effects.state, "rollouts");
  mkdirSync(journals, { recursive: true });
  const started = run(rollout, ["start", "--target-kind", "native-app", "--host", HOST, "--ssh-config", sshConfig, "--candidate", candidate, "--artifact", digest, "--baseline", baseline, "--policy", join(record, "policy.json"), "--receipt", join(record, "receipt.json"), "--evidence-dir", join(record, "evidence"), "--journal-dir", journals, "--bound-s", String(BOUND_S), "--deadline-s", String(DEADLINE_S)], { timeoutMs: LIMITS.start });
  const runLine = started.stdout.trim().split("\n")[0] ?? "";
  report(`rollout ${runLine}`);
  switch (started.status) {
    case EXIT.promoted: return "promoted";
    case EXIT.notPromoted: return "not-promoted";
    case EXIT.lockHeld: return "lock-held";
    case EXIT.needsOperator: return "needs-operator";
    default: throw new Error(`rollout start failed (exit ${started.status}); inspect ${journals}`);
  }
}

function execute(file: string, args: readonly string[], { timeoutMs, log }: RunOptions): Run {
  const fd = log === undefined ? undefined : openSync(log, "wx");
  try {
    const result = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 << 20, stdio: ["ignore", fd ?? "pipe", fd ?? "inherit"] });
    if (result.error) throw new Error(`${file}: ${result.error.message}`);
    return { status: result.status ?? 128, stdout: result.stdout ?? "" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const MESSAGES: Record<Outcome, string> = {
  checked: "", unchanged: "", promoted: "promoted",
  "not-promoted": "the rollout was rejected or recovered to the previous app; see its journal",
  "lock-held": "another operation holds the standby lease; nothing changed",
  "needs-operator": "the rollout needs an operator; inspect its journal and the standby before retrying",
};

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`usage: node --experimental-strip-types deploy/orange/standby-deploy.mts [--check]\n\nDeploys the committed tree to the native Stats standby writer through Stuff's rollout\ntransaction: build, admission checks, stage an immutable app release, then rollout start\n--target-kind native-app, which holds one lease through activation, verification and\nconditional recovery.\n--check: read the app identity, writer authority and runtime pins; changes nothing.\nEnvironment: STANDBY_SSH_CONFIG and STATS_ROLLOUT; deploying also needs\nSTATS_CHECK_HOSTS and STATSCTL. Records go to ~/.local/state/openorange/apps\nand journals to ~/.local/state/openorange/rollouts.\nExit codes: 0 promoted, checked or unchanged; 3 rejected or recovered; 4 lease held;\n5 needs operator; 1 error; 2 usage.`);
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) { console.error("usage: deploy/orange/standby-deploy.mts [--check]; use --help"); process.exitCode = 2; return; }
  const root = resolve(import.meta.dirname, "../..");
  process.chdir(root);
  process.env.TMPDIR = join(root, ".work/tmp");
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return resolve(value); };
  const optional = (name: string) => process.env[name] ? resolve(process.env[name]!) : undefined;
  try {
    const outcome = deployStandby({
      mode: args[0] === "--check" ? "check" : "deploy", root, state: join(homedir(), ".local/state/openorange"),
      sshConfig: required("STANDBY_SSH_CONFIG"), rollout: required("STATS_ROLLOUT"), hosts: optional("STATS_CHECK_HOSTS"), statsctl: optional("STATSCTL"),
      node: process.execPath, run: execute, report: message => console.log(message), now: Date.now,
    });
    if (MESSAGES[outcome]) console.log(`standby-deploy: ${MESSAGES[outcome]}`);
    process.exitCode = { checked: 0, unchanged: 0, promoted: EXIT.promoted, "not-promoted": EXIT.notPromoted, "lock-held": EXIT.lockHeld, "needs-operator": EXIT.needsOperator }[outcome];
  } catch (error) {
    console.error(`standby-deploy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
