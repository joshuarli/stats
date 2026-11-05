import { spawn } from "node:child_process";
import { join } from "node:path";
import { BUCKET_MS } from "../src/projects/queries.ts";
import { collectAt, seed } from "../local/seed.ts";
import { cliEnv, startStack } from "../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../local/topology.ts";

const USAGE = `usage:
  node scripts/local-stack.mjs run -- <command> [args...]   run a command against an ephemeral, seeded stack
  node scripts/local-stack.mjs dev [--state DIR] [--port N] serve a persistent stack until SIGINT or SIGTERM`;
const DEFAULT_STATE = join(CLOUDFLARE_ROOT, "../.work/local/state");
const DEFAULT_PORT = 8789;

function usage(message) {
  console.error(`local-stack: ${message}\n${USAGE}`);
  process.exit(2);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function run(command) {
  if (command.length === 0) usage("run needs a command after --");
  const stack = await startStack({ nowMs: null });
  let code = 1;
  try {
    await seed(stack, Date.now());
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...cliEnv(stack.origin) } });
    const forward = signal => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status, signal) => resolve(status ?? (signal === null ? 1 : 128)));
    });
  } finally {
    await stack.dispose();
  }
  return code;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined) usage(`${name} needs a value`);
  return value;
}

async function dev(args) {
  const known = new Set(["--state", "--port"]);
  for (let index = 0; index < args.length; index += 2) if (!known.has(args[index])) usage(`unknown option ${args[index]}`);
  const state = option(args, "--state", DEFAULT_STATE);
  const port = Number(option(args, "--port", String(DEFAULT_PORT)));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) usage("--port must be a TCP port");
  const stack = await startStack({ nowMs: null, persist: state, port, localExplorer: true });
  const hosts = await (await stack.fetch("/api/v1/hosts")).json();
  if (hosts.hosts.length === 0) await seed(stack, Date.now());
  else await collectAt(stack, Date.now());
  const schedule = () => {
    setTimeout(async () => {
      try {
        await collectAt(stack, Date.now());
      } catch (error) {
        console.error(`local-stack: scheduled collection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      schedule();
    }, BUCKET_MS - (Date.now() % BUCKET_MS));
  };
  schedule();
  const env = cliEnv(stack.origin);
  console.log(`stats local stack: ${stack.origin}  (state ${state}, scheduled collection every 5 minutes)`);
  console.log(`local explorer: ${stack.origin}/cdn-cgi/local/explorer`);
  console.log(`statsctl environment:\n${Object.entries(env).map(([key, value]) => `  export ${key}=${shellQuote(value)}`).join("\n")}`);
  console.log("ready");
  // Miniflare's exit hook disposes workerd and exits 128 + signal on SIGINT and SIGTERM.
  await new Promise(() => {});
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "run") {
  if (rest[0] !== "--") usage("run takes -- before the command");
  process.exit(await run(rest.slice(1)));
} else if (mode === "dev") {
  await dev(rest);
} else {
  usage(mode === undefined ? "no mode" : `unknown mode ${mode}`);
}
