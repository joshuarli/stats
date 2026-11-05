import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
const osConstants = constants;
import { BUCKET_MS } from "../src/projects/queries.ts";
import { collectAt, seed } from "../local/seed.ts";
import { describeUnexpected } from "../local/outbound.ts";
import { cliEnv, startStack } from "../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../local/topology.ts";

const USAGE = `usage:
  node scripts/local-stack.mjs run [--producer DIR]... -- <command> [args...]       run a command against an ephemeral, seeded stack
  node scripts/local-stack.mjs dev [--state DIR] [--port N] [--producer DIR]...    serve a persistent stack until SIGINT or SIGTERM
  --producer DIR hosts a producer export's Worker beside stats, tailed by stats-observe and served on its own origin`;
const DEFAULT_STATE = join(CLOUDFLARE_ROOT, "../.work/local/state");
const DEFAULT_PORT = 8789;

function usage(message) {
  console.error(`local-stack: ${message}\n${USAGE}`);
  process.exit(2);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function producerLines(stack) {
  return stack.producers.map(producer => `producer ${producer.service}: ${producer.origin}  (listening on 127.0.0.1:${producer.port}, version ${producer.versionId}; its outbound requests reach only ${producer.providers.map(origin => origin.origin).join(", ")}, which you start; its cron ${producer.crons.join(", ") || "(none)"} is not fired here)`);
}

async function run(producers, command) {
  if (command.length === 0) usage("run needs a command after --");
  const stack = await startStack({ nowMs: null, producers });
  for (const line of producerLines(stack)) console.error(line);
  let code = 1;
  try {
    await seed(stack, Date.now());
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...cliEnv(stack.origin) } });
    // Miniflare's exit hook exits 128 + signal on SIGINT and SIGTERM, so the child is signalled first and the scratch state removed on exit.
    const forward = signal => child.kill(signal);
    process.prependListener("SIGINT", forward);
    process.prependListener("SIGTERM", forward);
    process.on("exit", () => rmSync(stack.persist, { recursive: true, force: true }));
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status, signal) => resolve(status ?? (signal === null ? 1 : 128 + osConstants.signals[signal])));
    });
  } finally {
    await stack.dispose();
  }
  return code;
}

function options(args, known) {
  const values = new Map(known.map(name => [name, []]));
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!values.has(name)) usage(`unknown option ${name}`);
    if (value === undefined) usage(`${name} needs a value`);
    values.get(name).push(value);
  }
  return values;
}

function single(values, name, fallback) {
  const given = values.get(name);
  if (given.length > 1) usage(`${name} is given more than once`);
  return given[0] ?? fallback;
}

async function dev(args) {
  const values = options(args, ["--state", "--port", "--producer"]);
  const state = single(values, "--state", DEFAULT_STATE);
  const port = Number(single(values, "--port", String(DEFAULT_PORT)));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) usage("--port must be a TCP port");
  const stack = await startStack({ nowMs: null, persist: state, port, localExplorer: true, producers: values.get("--producer") });
  const hosts = await (await stack.fetch("/api/v1/hosts")).json();
  let reported = 0;
  const reportUnexpected = () => {
    const unexpected = stack.outbound.unexpected();
    if (unexpected.length > reported) console.error(`local-stack: ${describeUnexpected(unexpected.slice(reported))}`);
    reported = unexpected.length;
  };
  if (hosts.hosts.length === 0) await seed(stack, Date.now());
  else await collectAt(stack, Date.now());
  reportUnexpected();
  const schedule = () => {
    setTimeout(async () => {
      try {
        await collectAt(stack, Date.now());
      } catch (error) {
        console.error(`local-stack: scheduled collection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      reportUnexpected();
      schedule();
    }, BUCKET_MS - (Date.now() % BUCKET_MS));
  };
  schedule();
  const env = cliEnv(stack.origin);
  console.log(`stats local stack: ${stack.origin}  (state ${state}, scheduled collection every 5 minutes)`);
  console.log(`local explorer: ${stack.origin}/cdn-cgi/local/explorer`);
  console.log(`statsctl environment:\n${Object.entries(env).map(([key, value]) => `  export ${key}=${shellQuote(value)}`).join("\n")}`);
  for (const line of producerLines(stack)) console.log(line);
  console.log("ready");
  // Miniflare's exit hook disposes workerd and exits 128 + signal on SIGINT and SIGTERM.
  await new Promise(() => {});
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "run") {
  const separator = rest.indexOf("--");
  if (separator === -1) usage("run takes -- before the command");
  process.exit(await run(options(rest.slice(0, separator), ["--producer"]).get("--producer"), rest.slice(separator + 1)));
} else if (mode === "dev") {
  await dev(rest);
} else {
  usage(mode === undefined ? "no mode" : `unknown mode ${mode}`);
}
