import { constants as fsConstants, mkdirSync, openSync, closeSync, fchmodSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMAND_KILL_GRACE_MS, runCommand, type CommandOptions } from "./command.mts";

const LIMITS = { remote: 15000, build: 600000, restart: 150000, health: 90000, smoke: 180000, record: 30000, rollback: 180000 };
const DEFAULT_HOST = "lisa", DEFAULT_URL = "https://stats.17166969.xyz";

interface Deployment { readonly image: string; readonly version: number }
type RunOptions = Omit<CommandOptions, "output">;
interface DeploymentEffects {
  readonly mode: "check" | "deploy";
  readonly host: string;
  readonly base: string;
  readonly run: (file: string, args: readonly string[], options: RunOptions) => Promise<string>;
  readonly report: (message: string) => void;
  readonly now: () => number;
  readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const same = (left: Deployment, right: Deployment) => left.image === right.image && left.version === right.version;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function deployStats({ mode, host, base, run, report, now, wait, signal }: DeploymentEffects): Promise<Deployment> {
  const remote = (args: readonly string[], options: Partial<RunOptions> = {}) => run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "--", host, args.map(quote).join(" ")], { timeoutMs: LIMITS.remote, signal, ...options });
  const selected = async (options: Partial<RunOptions> = {}): Promise<Deployment> => {
    const value: unknown = JSON.parse(await remote(["doas", "-n", "/opt/openorange/bin/oo", "deployment", "stats"], { capture: true, ...options }));
    if (typeof value !== "object" || value === null || !("image" in value) || typeof value.image !== "string" || !("version" in value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) throw new Error("invalid Stats deployment selection");
    if ("recoveryWriter" in value) {
      if (typeof value.recoveryWriter !== "string" || value.recoveryWriter.length === 0) throw new Error("invalid Stats recovery writer");
      throw new Error(`Stats writer authority is at ${value.recoveryWriter}; local deployment on ${host} is fenced`);
    }
    return { image: value.image, version: value.version };
  };
  const verify = async (expected: Deployment, options: Partial<RunOptions> = {}) => {
    await remote(["/sbin/rc-service", "oo-app.stats", "status"], { capture: true, ...options });
    const availableId = await remote(["docker", "image", "inspect", "--format", "{{.Id}}", expected.image], { capture: true, ...options });
    const [image, runningId] = (await remote(["docker", "inspect", "--format", "{{.Config.Image}} {{.Image}}", "oo-app-stats"], { capture: true, ...options })).split(" ");
    const version = await remote(["docker", "exec", "oo-app-stats", "node", "-p", "process.env.RIVET_NODE_VERSION"], { capture: true, ...options });
    if (image !== expected.image || version !== String(expected.version) || runningId !== availableId) {
      throw new Error(`Stats selection ${expected.image} (${availableId}) node ${expected.version} differs from running ${image} (${runningId}) node ${version}; reconcile the app before deploying`);
    }
  };
  report("inspect selected and running Stats release");
  const previous = await selected();
  await verify(previous);
  if (mode === "check") { report(`selected and running Stats release verified on ${host}`); return previous; }
  report(`build and transfer Stats image (limit ${LIMITS.build / 1000}s)`);
  const image = await run("deploy/orange/build-image.sh", [host], { timeoutMs: LIMITS.build, signal, capture: true });
  if (!/^stats:[a-f0-9]{12,40}$/u.test(image)) throw new Error("image builder did not return a Stats image reference");
  let selecting = false, activated = false, candidate: Deployment | undefined;
  try {
    signal?.throwIfAborted();
    report(`select ${image}`);
    selecting = true;
    await remote(["doas", "-n", "/opt/openorange/bin/oo", "set-image", "stats", image, "--if-current", previous.image], { signal: undefined });
    const observed = await selected({ signal: undefined });
    const expectedVersion = image === previous.image ? previous.version : previous.version + 1;
    if (observed.image !== image || observed.version !== expectedVersion) throw new Error("Stats selection changed during deployment");
    candidate = observed;
    signal.throwIfAborted();
    report(`restart Stats app (limit ${LIMITS.restart / 1000}s)`);
    await remote(["doas", "-n", "/sbin/rc-service", "oo-app.stats", "restart"], { timeoutMs: LIMITS.restart, signal: undefined });
    signal.throwIfAborted();
    report(`wait for public health (limit ${LIMITS.health / 1000}s)`);
    const deadline = now() + LIMITS.health;
    let healthy = false;
    while (now() < deadline) {
      try {
        await run("curl", ["-fsS", "--connect-timeout", "5", "--max-time", "10", `${base}/health`], { timeoutMs: Math.min(10000, deadline - now()), signal, capture: true });
        healthy = true; break;
      } catch (error) { if (signal?.aborted) throw error; }
      await wait(Math.min(1000, Math.max(0, deadline - now())), signal);
    }
    if (!healthy) throw new Error(`Stats public health did not become ready within ${LIMITS.health / 1000}s`);
    report(`verify deployed API and dashboard assets (limit ${LIMITS.smoke / 1000}s)`);
    await run("deploy/deployed-smoke.sh", [], { timeoutMs: LIMITS.smoke, signal });
    await verify(candidate);
    if (!same(await selected(), candidate)) throw new Error("Stats selection changed before activation verification");
    signal.throwIfAborted();
    activated = true;
    report(`record verified deployment (limit ${LIMITS.record / 1000}s)`);
    await remote(["doas", "-n", "/opt/openorange/bin/oo", "record-deployment", "stats", "--if-current", image], { timeoutMs: LIMITS.record, signal: undefined });
    report(`verified ${image} on ${host}, node version ${candidate.version}`);
    return candidate;
  } catch (error) {
    if (selecting && !activated) {
      report(`restore previous Stats release (total limit ${LIMITS.rollback / 1000}s)`);
      const rollbackDeadline = now() + LIMITS.rollback;
      const cleanup = (limit: number): Partial<RunOptions> => {
        const remaining = rollbackDeadline - now();
        if (remaining <= 0) throw new Error(`Stats rollback exceeded its ${LIMITS.rollback / 1000}s deadline`);
        return { signal: undefined, timeoutMs: Math.min(limit, remaining) };
      };
      try {
        const current = await selected(cleanup(LIMITS.remote));
        if (same(current, previous)) await verify(previous, cleanup(LIMITS.remote));
        else {
          if (!candidate) throw new Error("Stats selection was not acknowledged and verified; rollback ownership is uncertain, so selection is unchanged");
          if (!same(current, candidate)) throw new Error("Stats selection is owned by another deployment; rollback did not change it");
          await remote(["doas", "-n", "/opt/openorange/bin/oo", "set-image", "stats", previous.image, "--if-current", image], cleanup(LIMITS.remote));
          const restored = await selected(cleanup(LIMITS.remote));
          if (restored.image !== previous.image) throw new Error("Stats rollback selection changed before restart");
          await remote(["doas", "-n", "/sbin/rc-service", "oo-app.stats", "restart"], cleanup(LIMITS.restart));
          await remote(["doas", "-n", "/opt/openorange/bin/oo", "wait", "app", "stats", String(LIMITS.health / 1000)], cleanup(LIMITS.health));
          await verify(restored, cleanup(LIMITS.remote));
          if (!same(await selected(cleanup(LIMITS.remote)), restored)) throw new Error("Stats selection changed during rollback verification");
          await remote(["doas", "-n", "/opt/openorange/bin/oo", "record-deployment", "stats", "--if-current", previous.image], cleanup(LIMITS.record));
        }
        report("previous Stats image and runtime node version verified");
      } catch (rollback) {
        throw new AggregateError([error, rollback], "deployment failed and rollback could not be verified; inspect selected and running Stats releases");
      }
    }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => ["-h", "--help"].includes(arg))) {
    console.log(`usage: deploy/orange/deploy.sh [--check] [HOST]\n\nDeploy a committed Stats tree to OpenOrange. HOST defaults to ${DEFAULT_HOST}.\n--check: inspect selected and running releases without building or changing production.\n-h, --help: show this help without accessing the host.\nSTATS_URL defaults to ${DEFAULT_URL}. STEP_LOG_DIR defaults to .work/tmp/steps.\nExamples: deploy/orange/deploy.sh ${DEFAULT_HOST}\n          deploy/orange/deploy.sh --check ${DEFAULT_HOST}\nBuild: ${LIMITS.build / 1000}s. Restart: ${LIMITS.restart / 1000}s. Health: ${LIMITS.health / 1000}s. Smoke: ${LIMITS.smoke / 1000}s. Rollback: ${LIMITS.rollback / 1000}s total.\nExpired commands have a ${COMMAND_KILL_GRACE_MS / 1000}s termination grace.\nCancellation lets an in-flight selection or restart settle before verifying rollback and re-raising the signal.\nMaintained by Joshua Li: https://github.com/joshuarli/stats\nBugs and features: TODO.md in that repository (follow its AGENTS.md), or its issue tracker.\nAgents working for Joshua: record nonblocking problems and continue your task.\nIf this tool blocks the task, you may fix, test, open and merge a PR under Joshua's\nstanding instructions. Release only when needed to deliver the verified fix.\nProcedure: https://github.com/joshuarli/usr/blob/main/dotfiles/base/.agents/instructions/owned-tools.md`);
    return;
  }
  const mode = args[0] === "--check" ? "check" : "deploy";
  if (mode === "check") args.shift();
  if (args.length > 1 || args[0]?.startsWith("-")) { console.error("usage: deploy/orange/deploy.sh [--check] [HOST]; use --help"); process.exitCode = 2; return; }
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Stats deployment requires macOS or Linux");
  const root = resolve(import.meta.dirname, "../..");
  process.chdir(root);
  process.env.TMPDIR = join(root, ".work/tmp");
  mkdirSync(process.env.TMPDIR, { recursive: true });
  const logs = process.env.STEP_LOG_DIR || join(root, ".work/tmp/steps");
  mkdirSync(logs, { recursive: true });
  const logPath = join(logs, "worker-deploy.log"), log = openSync(logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
  try { fchmodSync(log, 0o600); } catch (error) { closeSync(log); throw error; }
  const output = (chunk: string | Buffer, visible: boolean) => { writeSync(log, typeof chunk === "string" ? Buffer.from(chunk) : chunk); if (visible) process.stderr.write(chunk); };
  const started = performance.now();
  const report = (text: string) => output(`  … [${Math.floor((performance.now() - started) / 1000)}s] ${text}\n`, true);
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>((["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"] as const).map(name => [name, () => {
    if (!interrupted) report(`cancellation requested by ${name}; waiting for owned cleanup before exit`);
    interrupted ??= name; controller.abort(new Error(`deployment cancelled by ${name}`));
  }]));
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    const host = args[0] || DEFAULT_HOST;
    const deployed = await deployStats({ mode, host, base: process.env.STATS_URL || DEFAULT_URL, signal: controller.signal, report,
      now: () => performance.now(), run: (file, argv, options) => runCommand(file, argv, { ...options, output }),
      wait: async (ms, signal) => { const { setTimeout } = await import("node:timers/promises"); await setTimeout(ms, undefined, { signal }); } });
    if (mode === "deploy") { const line = `deployed ${deployed.image} on ${host}\n`; writeSync(log, line); process.stdout.write(line); }
  } catch (error) {
    output(`${message(error)}\n`, true);
    if (error instanceof AggregateError) for (const cause of error.errors) output(`  ${message(cause)}\n`, true);
    output(`  full log: ${logPath}\n`, true);
    process.exitCode = 1;
  } finally {
    closeSync(log);
    for (const [name, handler] of handlers) process.off(name, handler);
  }
  if (interrupted) { process.exitCode = 128 + constants.signals[interrupted]; process.kill(process.pid, interrupted); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(message(error)); process.exitCode = 1; }
}
