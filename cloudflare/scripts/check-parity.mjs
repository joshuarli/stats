import { spawnSync } from "node:child_process";
import { readHistory } from "../test/support/history.ts";

const HOST = process.env.STATS_URL ?? "https://stats.17166969.xyz";
const PROJECT = process.env.PROJECT_ID ?? "stuff";
const SCRIPT = process.env.WORKER_SCRIPT ?? "stuff";
const SETTLE_MS = 45 * 60_000;
const GATE = 0.05;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const account = JSON.parse(run("cf", ["accounts", "list"]));
if (account.length !== 1) throw new Error("set CLOUDFLARE_ACCOUNT_ID: the profile sees more than one account");
const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID ?? account[0].id;
const token = run("cf", ["access", "token", HOST]).trim();

const response = await fetch(`${HOST}/api/v1/projects/${PROJECT}/history?range=24h&kind=worker`, { headers: { "cf-access-token": token } });
if (!response.ok) throw new Error(`history answered ${response.status}; run cf access login ${HOST}`);
const history = readHistory(Buffer.from(await response.arrayBuffer()));
const stored = history.series.find((entry) => entry.metric === "worker.invocations").values;

const now = Date.now();
const startMs = history.fromMs;
const body = JSON.stringify({
  query: "SELECT toDate(timestamp) AS day, toHour(timestamp) AS hour, floor(toMinute(timestamp) / 5) AS slot, COUNT(*) AS invocations FROM logs.workersLogs WHERE scriptName = $script AND logType = 'cf-worker-event' AND attributes['$workers.executionModel'] = 'stateless' AND timestamp >= $start GROUP BY toDate(timestamp), toHour(timestamp), floor(toMinute(timestamp) / 5) LIMIT 2000",
  params: { script: SCRIPT, start: new Date(startMs).toISOString() },
  scope: { accountTag },
});
const direct = new Map();
for (const row of JSON.parse(run("cf", ["sql", "query", "-", "--body", body])).data) {
  const atMs = Date.parse(`${row.day}T00:00:00Z`) + row.hour * 3_600_000 + row.slot * 300_000;
  direct.set(atMs, Number(row.invocations));
}

let compared = 0;
let exact = 0;
let storedTotal = 0;
let directTotal = 0;
const differing = [];
stored.forEach((value, index) => {
  const atMs = history.fromMs + index * history.stepMs;
  if (atMs + history.stepMs + SETTLE_MS > now || value === null) return;
  const expected = direct.get(atMs) ?? 0;
  compared += 1;
  storedTotal += value;
  directTotal += expected;
  if (value === expected) exact += 1;
  else differing.push({ at: new Date(atMs).toISOString(), stored: value, direct: expected });
});

const error = directTotal === 0 ? 0 : (storedTotal - directTotal) / directTotal;
console.log(`${compared} settled buckets compared, ${exact} exact, ${differing.length} differ`);
for (const entry of differing) console.log(`  ${entry.at} stored=${entry.stored} direct=${entry.direct}`);
console.log(`total stored=${storedTotal} direct=${directTotal} error=${(error * 100).toFixed(1)}% (gate ${GATE * 100}%)`);
if (Math.abs(error) > GATE) process.exit(1);
