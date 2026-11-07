import { spawnSync } from "node:child_process";
import {
  parseD1Rows,
  parseD1StatementRows,
  parseD1StorageRows,
  parseDurableObjectRows,
  parseR2OperationRows,
  parseR2StorageRows,
  parseRouteRows,
  parseWorkerRows,
} from "../src/cloudflare/projects/parse.ts";
import {
  BUCKET_MS,
  d1Query,
  d1StatementQuery,
  d1StorageQuery,
  durableObjectQuery,
  r2OperationsQuery,
  r2StorageQuery,
  routeQuery,
  workerQuery,
} from "../src/projects/queries.ts";

const PROJECT = {
  worker: "stuff",
  buckets: ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"],
  durableObjectNamespaces: ["b25c2595ba784bb1bd51a87a3e87c62b"],
  d1Databases: ["9870c4da-3758-4f0c-ab6d-2372eb34009b"],
};
const WINDOW_MS = 90 * 60_000;

function cf(args, input) {
  const run = spawnSync("cf", ["-q", ...args], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (run.error) {
    throw run.error;
  }
  if (run.status !== 0) {
    throw new Error(`cf ${args.slice(0, 2).join(" ")} failed: ${run.stderr || run.stdout}`);
  }
  return JSON.parse(run.stdout);
}

function accountTag() {
  const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (fromEnv) {
    return fromEnv;
  }
  const accounts = cf(["accounts", "list"]);
  if (accounts.length !== 1) {
    throw new Error("set CLOUDFLARE_ACCOUNT_ID: the profile sees more than one account");
  }
  return accounts[0].id;
}

function run(tag, bound) {
  const body = JSON.stringify({
    query: bound.query,
    params: bound.params,
    scope: { accountTag: tag },
  });
  const result = cf(["sql", "query", "-", "--body", body]);
  if (!Array.isArray(result.data) || result.rows !== result.data.length) {
    throw new Error("response lacks the data and rows shape the binding returns");
  }
  return result;
}

const now = Date.now();
const startMs = Math.floor((now - WINDOW_MS) / BUCKET_MS) * BUCKET_MS;
const tag = accountTag();

const checks = [
  ["worker", workerQuery(PROJECT.worker, startMs), parseWorkerRows],
  ["routes", routeQuery(PROJECT.worker, startMs), parseRouteRows],
  ["durable objects", durableObjectQuery(PROJECT.durableObjectNamespaces, startMs), parseDurableObjectRows],
  ["r2 operations", r2OperationsQuery(PROJECT.buckets, startMs), parseR2OperationRows],
  ["r2 storage", r2StorageQuery(PROJECT.buckets, startMs), parseR2StorageRows],
  ["d1 totals", d1Query(PROJECT.d1Databases, startMs), parseD1Rows],
  ["d1 statements", d1StatementQuery(PROJECT.d1Databases, startMs), parseD1StatementRows],
  ["d1 storage", d1StorageQuery(PROJECT.d1Databases, startMs), parseD1StorageRows],
];

let failed = false;
for (const [name, bound, parse] of checks) {
  try {
    const result = run(tag, bound);
    const points = parse(result.data);
    console.log(
      `${name}: ${result.rows} rows, ${points.length} points, ${result.statistics.rows_read} rows read, ${result.statistics.elapsed_ms} ms`,
    );
  } catch (error) {
    failed = true;
    console.error(`${name}: ${error instanceof Error ? error.message : error}`);
  }
}
if (failed) {
  process.exit(1);
}
