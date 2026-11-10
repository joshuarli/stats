import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startStack } from "../local/stack.ts";
import { readBuiltWorker } from "../local/topology.ts";
import { DURABLE_OBJECT_MEMORY_GB, LIST_PRICE_PER_MILLION, PRICING_REVISION } from "../src/cost/pricing.ts";
import { MONTH_MS } from "../src/cost/ledger.ts";

const USAGE = `usage:
  node scripts/profile.mjs --producer-worker DIR [--service NAME] [--workload FILE] [--daily N] [--wait SECONDS] [--json]
  --producer-worker DIR  a cf-built output directory holding worker.config.json and bundle/
  --service NAME         the observation label; defaults to the built Worker's name
  --workload FILE        an ES module whose default export receives the producer origin; defaults to DIR/../workload.mjs or DIR/workload.mjs
  --daily N              how many times the measured workload runs per day (default 1000)
  --wait SECONDS         how long to collect manual traffic when no workload runs (default 30)
  --json                 print the profile as JSON`;

const DAY_MS = 86_400_000;
const MONTH_DAYS = MONTH_MS / DAY_MS;

function usage(message) {
  console.error(`profile: ${message}\n${USAGE}`);
  process.exit(2);
}

function options(args) {
  const values = new Map([["--producer-worker", []], ["--service", []], ["--workload", []], ["--daily", []], ["--wait", []], ["--json", []]]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!values.has(name)) usage(`unknown option ${name}`);
    if (name === "--json") { values.get(name).push("true"); continue; }
    const value = args[index + 1];
    if (value === undefined) usage(`${name} needs a value`);
    values.get(name).push(value);
    index += 1;
  }
  return values;
}

function single(values, name, fallback) {
  const given = values.get(name);
  if (given.length > 1) usage(`${name} is given more than once`);
  return given[0] ?? fallback;
}

function positive(values, name, fallback) {
  const raw = single(values, name, String(fallback));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) usage(`${name} must be a positive integer`);
  return value;
}

function resolveWorkload(dir) {
  for (const candidate of [join(dir, "workload.mjs"), join(dir, "..", "workload.mjs")]) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function profile(service, origin, window, daily) {
  const perMillion = (value, rate) => value * rate / 1_000_000;
  const scale = daily * MONTH_DAYS;
  const operations = window.operations.map(operation => {
    const calls = operation.invocations * scale;
    const cpuMs = operation.cpuMs.total * scale;
    const wallMs = operation.wallMs.total * scale;
    const parts = operation.stage === "worker"
      ? {
          requests: perMillion(calls, LIST_PRICE_PER_MILLION.workerRequests),
          cpu: perMillion(cpuMs, LIST_PRICE_PER_MILLION.workerCpuMs)
        }
      : {
          requests: perMillion(calls, LIST_PRICE_PER_MILLION.durableObjectRequests),
          duration: perMillion((wallMs / 1000) * DURABLE_OBJECT_MEMORY_GB, LIST_PRICE_PER_MILLION.durableObjectGbSeconds),
          rowsRead: perMillion(operation.rows.read * scale, LIST_PRICE_PER_MILLION.d1RowsRead),
          rowsWritten: perMillion(operation.rows.written * scale, LIST_PRICE_PER_MILLION.d1RowsWritten)
        };
    const monthly = Object.values(parts).reduce((sum, value) => sum + value, 0);
    return { ...operation, monthly, parts };
  });
  return {
    service,
    producer: origin,
    window: { fromMs: window.fromMs, toMs: window.toMs },
    daily,
    monthDays: MONTH_DAYS,
    pricingRevision: PRICING_REVISION,
    operations,
    totalMonthly: operations.reduce((sum, operation) => sum + operation.monthly, 0)
  };
}

function money(value) {
  return `$${value.toFixed(value === 0 ? 2 : 4)}`;
}

function print(profile) {
  const header = ["operation", "stage", "calls", "cpu p50/p95/total", "wall p50/p95", "rows r/w/stmts", "r2 A/B", "monthly"];
  const rows = profile.operations.map(operation => [
    operation.operation,
    operation.stage,
    String(operation.invocations),
    `${operation.cpuMs.p50}/${operation.cpuMs.p95}/${operation.cpuMs.total}`,
    `${operation.wallMs.p50}/${operation.wallMs.p95}`,
    `${operation.rows.read}/${operation.rows.written}/${operation.rows.statements}`,
    operation.r2 === null ? "-/-" : `${operation.r2.classA}/${operation.r2.classB}`,
    money(operation.monthly)
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map(row => row[index].length)));
  const line = cells => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  console.log(`service ${profile.service}  producer ${profile.producer}`);
  console.log(`window ${new Date(profile.window.fromMs).toISOString()} .. ${new Date(profile.window.toMs).toISOString()}`);
  console.log(`daily ${profile.daily} workload runs/day, ${profile.monthDays}-day month, pricing ${profile.pricingRevision}`);
  console.log(line(header));
  console.log(widths.map(width => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log(line(["total", "", "", "", "", "", "", money(profile.totalMonthly)]));
  console.log("SQLite rows use the row prices in src/cost/pricing.ts. R2 class A/B operations are counted but not priced: that table has no R2 operation tariff.");
}

async function main(args) {
  const values = options(args);
  const output = single(values, "--producer-worker", undefined);
  if (output === undefined) usage("--producer-worker is required");
  const dir = resolve(output);
  const service = single(values, "--service", readBuiltWorker(dir).name);
  const daily = positive(values, "--daily", 1000);
  const waitSeconds = positive(values, "--wait", 30);
  const explicit = single(values, "--workload", undefined);
  const workload = explicit === undefined ? resolveWorkload(dir) : resolve(explicit);
  const json = values.get("--json").length > 0;

  const stack = await startStack({ nowMs: null, workerProducers: [{ dir, service }] });
  const producer = stack.workerProducers[0];
  const fromMs = Date.now() - 60_000;
  const read = () => stack.observe(service, `/profile?from=${fromMs}&to=${Date.now() + 60_000}`);
  try {
    if (workload === null) {
      if (!json) console.error(`listening on ${producer.origin}; send traffic now, or pass --workload FILE`);
      await sleep(waitSeconds * 1000);
    } else {
      const module = await import(pathToFileURL(workload).href);
      if (typeof module.default !== "function") usage(`${workload} must default-export an async function taking the producer origin`);
      await module.default(producer.origin);
    }
    let last = -1;
    let stable = 0;
    let window = await read();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const total = window.operations.reduce((sum, operation) => sum + operation.invocations, 0);
      if (total > 0 && total === last) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      last = total;
      await sleep(250);
      window = await read();
    }
    const result = await profile(service, producer.origin, window, daily);
    if (json) console.log(JSON.stringify(result));
    else print(result);
  } finally {
    await stack.dispose();
  }
}

await main(process.argv.slice(2));
