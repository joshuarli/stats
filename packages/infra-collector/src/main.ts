import { reconcileAck } from "./ack.ts";
import { CATALOG_VERSION } from "./catalog.ts";
import { INFRA_METRICS_MEDIA_TYPE } from "./contract.ts";
import { boundBatch } from "./bounds.ts";
import { filterScrape } from "./filter.ts";
import { request, responseText } from "./transport.ts";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseExposition, MAX_SCRAPE_BYTES, type Drops } from "../../../cloudflare/src/metrics/exposition.ts";
import { encodeBatch, INFRA_METRICS_SCHEMA, MAX_METRIC_QUEUE, MAX_METRIC_TARGETS, type Batch, type Scrape } from "../../../cloudflare/src/metrics/codec.ts";

type Target = { id: string; url: string };
type Config = { name: string; targets: Target[]; releaseFile: string; tokenFile?: string; endpoint: string };
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const config = JSON.parse(readFileSync(required("INFRA_COLLECTOR_CONFIG"), "utf8")) as Config;
if (!/^[a-z][a-z0-9-]{0,31}$/u.test(config.name) || !Array.isArray(config.targets) || config.targets.length < 1 || config.targets.length > MAX_METRIC_TARGETS) throw new Error("invalid collector config");
for (const target of config.targets) {
  const url = new URL(target.url);
  const validId = /^(?:worker:[a-z][a-z0-9-]{0,63}:(?:[0-9]|1[0-5])|engine:[a-z][a-z0-9-]{0,63})$/u.test(target.id);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || !validId) {
    throw new Error("invalid target");
  }
}
if (new Set(config.targets.map(target => target.id)).size !== config.targets.length) throw new Error("duplicate target");
const startedAtMs = Date.now();
const collector = { name: config.name, instance: randomBytes(8).toString("hex"), startedAtMs };
const expected = config.targets.map(target => target.id);
const sequences = new Map<string, number>();
const queue: Batch[] = [];
const targets = Object.fromEntries(expected.map(target => [target, { scraped: 0, accepted: 0, duplicates: 0, rejected: 0, dropped: 0, failed: 0 }]));
let queueHigh = 0;
const snapshot = (): Batch["delivery"] => ({ atMs: Date.now(), queued: queue.length, queueHigh, targets: structuredClone(targets) });
let sending: Promise<void> | undefined;
let stopping = false;
let token = config.tokenFile ? readFileSync(config.tokenFile, "utf8").trim() : required("INFRA_METRICS_TOKEN");
const errors = new Map<string, number>();
function log(code: string): void {
  if (Date.now() - (errors.get(code) ?? 0) < 60000) return;
  errors.set(code, Date.now());
  console.error(JSON.stringify({ event: "infra_collector_error", code }));
}
function emptyDrops(): Drops { return { unlisted_family: 0, unlisted_label: 0, non_finite: 0, series_cap: 0 }; }
async function scrape(target: Target): Promise<Scrape> {
  const start = performance.now();
  const release = JSON.parse(readFileSync(config.releaseFile, "utf8")) as { runtime: string; app: string };
  const sequence = (sequences.get(target.id) ?? 0) + 1;
  sequences.set(target.id, sequence);
  targets[target.id]!.scraped++;
  const sample: Scrape = {
    target: target.id, sequence, atMs: Date.now(), monoMs: Math.floor(performance.now()),
    outcome: "ok", durationUs: 0, bytes: 0,
    release: { runtime: release.runtime, app: target.id.startsWith("engine:") ? null : release.app },
    process: { startTime: null }, dropped: emptyDrops(), values: {}
  };
  try {
    const response = await request(target.url, { method: "GET", timeoutMs: 2000 });
    if (response.statusCode !== 200) { response.destroy(); throw new Error("http_status"); }
    if (Number(response.headers["content-length"]) > MAX_SCRAPE_BYTES) { response.destroy(); throw new Error("too_large"); }
    const filtered = await filterScrape(response, bytes => { sample.bytes = bytes; });
    let parsed;
    try { parsed = parseExposition(filtered.text); } catch { throw new Error("parse_error"); }
    parsed.dropped.unlisted_family += filtered.unlisted;
    if (target.id.startsWith("worker:")) {
      const [, worker, index] = target.id.split(":");
      const identity = parsed.values.openorange_worker_info;
      const startTime = parsed.values.openorange_worker_start_time_seconds?.[0]?.[1];
      if (identity?.length !== 1 || identity[0]?.[0].worker !== worker || identity[0]?.[0].index !== index || typeof startTime !== "string") throw new Error("identity_mismatch");
      sample.process.startTime = startTime;
    }
    sample.values = parsed.values;
    sample.dropped = parsed.dropped;
  } catch (error) {
    const code = error instanceof Error ? error.message : "refused";
    if (["http_status", "too_large", "parse_error", "identity_mismatch"].includes(code)) sample.outcome = code;
    else if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) sample.outcome = "timeout";
    else sample.outcome = "refused";
    log(sample.outcome);
  }
  sample.durationUs = Math.floor((performance.now() - start) * 1000);
  return sample;
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function retryAfter(header: string | null): number {
  if (header === null) return 0;
  const seconds = Number(header);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(duration) ? Math.min(60000, Math.max(0, duration)) : 0;
}
function deliver(): Promise<void> {
  if (sending !== undefined) return sending;
  sending = send().finally(() => { sending = undefined; });
  return sending;
}
async function send(): Promise<void> {
  while (queue.length) {
    const batch = queue[0]!;
    let status = 0;
    let responseBody = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await request(config.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": INFRA_METRICS_MEDIA_TYPE },
          body: encodeBatch(batch),
          timeoutMs: 5000
        });
        status = response.statusCode ?? 0;
        responseBody = await responseText(response, 65536);
        if ((status === 401 || status === 403) && config.tokenFile) token = readFileSync(config.tokenFile, "utf8").trim();
        if (status !== 200) log(`http_${status}`);
        if (status === 200 || [404, 405, 410, 415, 422].includes(status)) break;
        const wait = retryAfter(response.headers["retry-after"] ?? null);
        if (wait) await delay(wait);
      } catch { status = 0; log("delivery"); }

    }
    if (status === 200) {
      let acknowledgement: unknown;
      try { acknowledgement = JSON.parse(responseBody); } catch { log("invalid_ack"); break; }
      const outcomes = reconcileAck(batch.scrapes, acknowledgement);
      if (!outcomes) { log("invalid_ack"); break; }
      for (const item of outcomes) {
        const counters = targets[item.target]!;
        if (item.status === "accepted") counters.accepted++;
        else if (item.status === "duplicate") counters.duplicates++;
        else counters.rejected++;
        if (item.status !== "rejected" && batch.scrapes.find(scrape => scrape.target === item.target && scrape.sequence === item.sequence)!.outcome !== "ok") counters.failed++;
      }
      const index = queue.indexOf(batch);
      if (index >= 0) queue.splice(index, 1);
      continue;
    }
    if ([404, 405, 410, 415, 422].includes(status)) {
      const index = queue.indexOf(batch);
      if (index >= 0) queue.splice(index, 1);
      for (const scrape of batch.scrapes) targets[scrape.target]!.rejected++;
      log("rejected");
      if (!stopping) await delay(60000);
      continue;
    }
    break;
  }
}
async function round(): Promise<void> {
  const delivery = snapshot();
  const scrapes: Scrape[] = [];
  for (let offset = 0; offset < config.targets.length; offset += 4) {
    scrapes.push(...await Promise.all(config.targets.slice(offset, offset + 4).map(scrape)));
  }
  if (queue.length === MAX_METRIC_QUEUE) {
    const removed = queue.splice(sending ? 1 : 0, 1)[0]!;
    for (const scrape of removed.scrapes) targets[scrape.target]!.dropped++;
  }
  const batch: Batch = { schema: INFRA_METRICS_SCHEMA, catalog: CATALOG_VERSION, collector, expected, delivery, scrapes };
  boundBatch(batch);
  queue.push(batch);
  queueHigh = Math.max(queueHigh, queue.length);
  void deliver();
}
async function run(): Promise<void> {
  while (!stopping) {
    const next = performance.now() + 15000 + Math.floor(Math.random() * 1001);
    await round();
    if (!stopping) await delay(Math.max(0, next - performance.now()));
  }
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void Promise.race([deliver(), delay(5000)]).finally(() => process.exit());
});
void run();
