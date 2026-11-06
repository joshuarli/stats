import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratchRoot = join(repo, ".work", "tmp");

export const ARTIFACT = "binary";
export const UNIT = "unit\n";

export type Script = "deploy-host.sh" | "add-host.sh" | "deployed-smoke.sh";

export interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly log: string[];
  readonly leftovers: string[];
}

export interface Workspace {
  readonly bin: string;
  readonly state: string;
  readonly log: string;
  readonly tmp: string;
  readonly blocked: string;
  install(name: string, body: string): void;
  run(script: Script, args: readonly string[], env: Record<string, string>, whileRunning?: (blocked: string, kill: (signal: NodeJS.Signals) => void) => Promise<void>): Promise<Outcome>;
}

function findOnPath(command: string): string {
  const found = (process.env.PATH ?? "").split(":").map(directory => join(directory, command)).find(candidate => existsSync(candidate));
  if (found === undefined) throw new Error(`${command} is not on PATH`);
  return found;
}

export async function withWorkspace<T>(use: (workspace: Workspace) => Promise<T>): Promise<T> {
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "deploy-"));
  try {
    const tree = join(scratch, "tree");
    const bin = join(scratch, "bin");
    const state = join(scratch, "state");
    const tmp = join(tree, ".work", "tmp");
    for (const directory of [join(tree, "deploy"), bin, state, tmp, join(tree, "agent", "dist"), join(tree, "agent", "contrib", "openrc"), join(tree, "agent", "contrib", "systemd")]) mkdirSync(directory, { recursive: true });
    copyFileSync(join(repo, "deploy", "hosts.json"), join(tree, "deploy", "hosts.json"));
    writeFileSync(join(tree, "agent", "Cargo.toml"), 'version = "9.9.9"\n');
    writeFileSync(join(tree, "agent", "dist", "stats-9.9.9-x86_64-unknown-linux-musl"), ARTIFACT);
    writeFileSync(join(tree, "agent", "contrib", "openrc", "stats"), UNIT);
    symlinkSync(findOnPath("jaq"), join(bin, "jaq"));
    const log = join(state, "log");
    const blocked = join(state, "blocked");
    writeFileSync(log, "");
    const install = (name: string, body: string): void => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
      chmodSync(join(bin, name), 0o755);
    };
    const run: Workspace["run"] = async (script, args, env, whileRunning) => {
      copyFileSync(join(repo, "deploy", script), join(tree, "deploy", script));
      const child = spawn("/bin/sh", [join(tree, "deploy", script), ...args], { env: { ...process.env, ...env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp, STUB_STATE: state, STUB_LOG: log, STUB_BLOCKED: blocked }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      const closed = new Promise<number | null>(done => child.on("close", code => done(code)));
      await whileRunning?.(blocked, signal => child.kill(signal));
      const code = await closed;
      return { code, stdout, stderr, log: readFileSync(log, "utf8").split("\n").filter(line => line !== ""), leftovers: readdirSync(tmp) };
    };
    return await use({ bin, state, log, tmp, blocked, install, run });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function untilExists(path: string): Promise<void> {
  for (let waited = 0; !existsSync(path); waited += 20) {
    if (waited > 5000) throw new Error(`${path} never appeared`);
    await new Promise(done => setTimeout(done, 20));
  }
}

export const LOG_CALL = `printf '%s\\n' "$(basename "$0") $(printf '%s ' "$@" | tr '\\n' ' ')" >> "$STUB_LOG"\n`;
