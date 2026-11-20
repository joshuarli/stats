import type { SqlDatabase, SqlValue } from "../core/sql.ts";
import { catalog } from "./catalog.ts";
import { encodeBatch, type Batch, type Scrape } from "./codec.ts";
import { seriesPoints } from "./series.ts";

const retention = 86400000;
type Row = {
  collector: string; instance: string; target: string; sequence: number;
  at_ms: number; mono_ms: number; outcome: string; runtime_release: string;
  app_release: string | null; incarnation: string | null; payload: string;
};
type Delivery = { collector: string; instance: string; received_at: number; started_at: number; expected: string; queued: number; queue_high: number; dropped: number; retries: number; rejected: number };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function payload(s: Scrape): string {
  return canonical({ values: s.values, dropped: s.dropped, durationUs: s.durationUs, bytes: s.bytes });
}
export class MetricStoreCore {
  readonly db: SqlDatabase;
  constructor(db: SqlDatabase) {
    this.db = db;
    for (const statement of `CREATE TABLE IF NOT EXISTS metric_scrapes (
      collector TEXT NOT NULL, instance TEXT NOT NULL, target TEXT NOT NULL, sequence INTEGER NOT NULL,
      at_ms INTEGER NOT NULL, mono_ms INTEGER NOT NULL, received_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, outcome TEXT NOT NULL, runtime_release TEXT NOT NULL,
      app_release TEXT, incarnation TEXT, catalog INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (collector, instance, target, sequence)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS metric_scrapes_time ON metric_scrapes (target, at_ms);
      CREATE TABLE IF NOT EXISTS metric_deliveries (collector TEXT NOT NULL, instance TEXT NOT NULL,
      received_at INTEGER NOT NULL, started_at INTEGER NOT NULL, expected TEXT NOT NULL,
      queued INTEGER NOT NULL, queue_high INTEGER NOT NULL, dropped INTEGER NOT NULL,
      retries INTEGER NOT NULL, rejected INTEGER NOT NULL, PRIMARY KEY (collector, instance, received_at)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS metric_rejections (bucket_at INTEGER NOT NULL, collector TEXT NOT NULL,
      reason TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (bucket_at, collector, reason)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS metric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;`.split(";")) {
      if (statement.trim()) this.db.run(statement);
    }
  }
  private prepare(query: string) {
    return {
      all: (...params: SqlValue[]): unknown[] => this.db.rows(query, ...params),
      get: (...params: SqlValue[]): unknown => this.db.rows(query, ...params)[0],
      run: (...params: SqlValue[]): void => this.db.run(query, ...params)
    };
  }
  ingest(batch: Batch, now: number): { accepted: number; duplicates: number; rejected: { target: string; sequence: number; code: string }[] } {
    encodeBatch(batch);
    const result = { accepted: 0, duplicates: 0, rejected: [] as { target: string; sequence: number; code: string }[] };
    return this.db.transaction(() => {
      const existingNames = this.prepare("SELECT DISTINCT collector FROM metric_deliveries WHERE received_at > ?").all(now - retention) as { collector: string }[];
      if (!existingNames.some((r) => r.collector === batch.collector.name) && existingNames.length >= 8) throw new Error("capacity");
      const rate = this.prepare("SELECT count(*) AS n FROM metric_deliveries WHERE collector = ? AND received_at > ?").get(batch.collector.name, now - 60000) as { n: number };
      if (rate.n >= 12) throw new Error("rate_limit");
      const pairs = this.prepare("SELECT DISTINCT runtime_release, app_release FROM metric_scrapes WHERE expires_at > ?").all(now) as { runtime_release: string; app_release: string | null }[];
      const releases = new Set(pairs.map((p) => `${p.runtime_release}:${p.app_release}`));
      for (const s of batch.scrapes) releases.add(`${s.release.runtime}:${s.release.app}`);
      if (releases.size > 32) throw new Error("capacity");
      for (const s of batch.scrapes) {
        let code: string | undefined;
        if (s.atMs <= now - retention) code = "too_old";
        else if (s.atMs > now + 300000) code = "future";
        const previous = this.prepare(
          "SELECT * FROM metric_scrapes WHERE collector=? AND instance=? AND target=? AND sequence=?"
        ).get(batch.collector.name, batch.collector.instance, s.target, s.sequence) as Row | undefined;
        if (!code && previous) {
          const identical = previous.at_ms === s.atMs && previous.mono_ms === s.monoMs &&
            previous.outcome === s.outcome && previous.runtime_release === s.release.runtime &&
            previous.app_release === s.release.app && previous.incarnation === s.process.startTime &&
            previous.payload === payload(s);
          if (identical) { result.duplicates++; continue; }
          code = "conflict";
        }
        if (code) {
          result.rejected.push({ target: s.target, sequence: s.sequence, code });
          this.prepare(`INSERT INTO metric_rejections VALUES (?, ?, ?, 1)
            ON CONFLICT(bucket_at, collector, reason) DO UPDATE SET count = count + 1`)
            .run(Math.floor(now / 60000) * 60000, batch.collector.name, code);
          continue;
        }
        this.prepare("INSERT INTO metric_scrapes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          batch.collector.name, batch.collector.instance, s.target, s.sequence, s.atMs, s.monoMs,
          now, s.atMs + retention, s.outcome, s.release.runtime, s.release.app, s.process.startTime, 1, payload(s)
        );
        result.accepted++;
      }
      const lastDelivery = this.prepare("SELECT max(received_at) AS latest FROM metric_deliveries WHERE collector = ? AND instance = ?").get(batch.collector.name, batch.collector.instance) as { latest: number | null };
      const receivedAt = Math.max(now, (lastDelivery.latest ?? now - 1) + 1);
      this.prepare("INSERT INTO metric_deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        batch.collector.name, batch.collector.instance, receivedAt, batch.collector.startedAtMs,
        canonical(batch.expected), batch.delivery.queued, batch.delivery.queueHigh,
        batch.delivery.dropped, batch.delivery.retries, batch.delivery.rejected
      );
      this.prepare(`DELETE FROM metric_scrapes WHERE (collector, instance, target, sequence) IN
        (SELECT collector, instance, target, sequence FROM metric_scrapes WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`)
        .run(now, Math.max(64, result.accepted * 2));
      const total = this.prepare("SELECT count(*) AS n FROM metric_scrapes").get() as { n: number };
      const evicted = Math.max(0, total.n - 20000);
      if (evicted) {
        this.prepare("DELETE FROM metric_scrapes WHERE (collector, instance, target, sequence) IN (SELECT collector, instance, target, sequence FROM metric_scrapes ORDER BY at_ms LIMIT ?)").run(evicted);
        this.prepare("INSERT INTO metric_meta VALUES ('evicted', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?").run(String(evicted), evicted);
      }
      this.prepare("DELETE FROM metric_deliveries WHERE received_at <= ?").run(now - retention);
      this.prepare("DELETE FROM metric_rejections WHERE bucket_at <= ?").run(now - retention);
      return result;
    });
  }
  series(target: string, family: string, from: number, to: number, now: number) {
    const rows = this.prepare(`SELECT * FROM metric_scrapes
      WHERE target = ? AND at_ms >= ? AND at_ms <= ? AND expires_at > ?
      ORDER BY at_ms, sequence LIMIT 901`).all(target, from, to, now) as unknown as Row[];
    const points = seriesPoints(rows.slice(0, 900).map((row) => ({
      instance: `${row.collector}:${row.instance}`,
      incarnation: row.incarnation,
      monoMs: row.mono_ms,
      atMs: row.at_ms,
      outcome: row.outcome,
      values: (JSON.parse(row.payload) as { values: Scrape["values"] }).values
    })), family, target.startsWith("engine:"));
    return { points, truncated: rows.length > 900 };
  }
  sources(from: number, to: number, release: "runtime" | "app", now: number): unknown[] {
    const rows = this.prepare("SELECT * FROM metric_scrapes WHERE at_ms >= ? AND at_ms <= ? AND expires_at > ? ORDER BY at_ms, sequence").all(from, to, now) as unknown as Row[];
    const deliveries = this.prepare("SELECT * FROM metric_deliveries WHERE received_at >= ? AND received_at <= ? ORDER BY received_at").all(from, to) as unknown as Delivery[];
    const keys = new Set(rows.map((r) => `${r.collector}\0${r.target}`));
    for (const d of deliveries) for (const target of JSON.parse(d.expected) as string[]) keys.add(`${d.collector}\0${target}`);
    return [...keys].sort().map((key) => {
      const [collector, target] = key.split("\0") as [string, string];
      const samples = rows.filter((r) => r.collector === collector && r.target === target);
      const ds = deliveries.filter((d) => d.collector === collector && (JSON.parse(d.expected) as string[]).includes(target));
      const instances = new Set(samples.map((s) => s.instance));
      const releases = new Set(samples.map((s) => release === "runtime" ? s.runtime_release : s.app_release).filter((v): v is string => v !== null));
      const failures: Record<string, number> = {};
      const droppedSeries: Record<string, number> = {};
      let resets = 0, counterRegressions = 0;
      const incarnations = new Set<string>();
      let previousOk: Row | undefined;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!;
        if (s.incarnation) incarnations.add(s.incarnation);
        if (s.outcome !== "ok") failures[s.outcome] = (failures[s.outcome] ?? 0) + 1;
        const parsed = JSON.parse(s.payload) as { values: Scrape["values"]; dropped: Record<string, number> };
        for (const [name, value] of Object.entries(parsed.dropped)) droppedSeries[name] = (droppedSeries[name] ?? 0) + value;
        if (s.outcome !== "ok") continue;
        const prev = previousOk;
        previousOk = s;
        if (!prev || prev.instance !== s.instance || prev.mono_ms >= s.mono_ms) continue;
        if (s.incarnation !== prev.incarnation) { resets++; continue; }
        const prior = (JSON.parse(prev.payload) as { values: Scrape["values"] }).values;
        let engineReset = false;
        for (const [name, entries] of Object.entries(parsed.values)) {
          if (catalog[name]?.type !== "counter") continue;
          for (const [labels, value] of entries) {
            const old = prior[name]?.find(([l]) => canonical(l) === canonical(labels))?.[1];
            if (typeof old === "string" && typeof value === "string" && BigInt(value) < BigInt(old)) {
              if (target.startsWith("engine:")) engineReset = true; else counterRegressions++;
            }
          }
        }
        if (engineReset) resets++;
      }
      const first = samples[0], last = samples.at(-1), firstDelivery = ds[0], lastDelivery = ds.at(-1);
      const failuresCount = Object.values(failures).reduce((a, b) => a + b, 0);
      const checkpoint = (atMs: number, accepted: number, dropped: number, queued: number) => ({ startedAtMs: firstDelivery?.started_at ?? 0, atMs, accepted, dropped, queued });
      const evidence = first && last && firstDelivery && lastDelivery && releases.size ? {
        source: target, producer: collector, releaseId: releases.size === 1 ? [...releases][0] : "mixed", lastSeenMs: last.at_ms,
        sequenceStart: checkpoint(first.at_ms, first.sequence - 1, firstDelivery.dropped + firstDelivery.rejected, firstDelivery.queued),
        sequenceEnd: checkpoint(last.at_ms, last.sequence, lastDelivery.dropped + lastDelivery.rejected + failuresCount + (instances.size > 1 ? 1 : 0), Math.max(lastDelivery.queued, lastDelivery.queue_high)),
        received: samples.length
      } : null;
      return {
        evidence,
        detail: {
          source: target, producer: collector, scrapeFailures: failures, incarnations: incarnations.size,
          resets, counterRegressions, lastOkAtMs: samples.filter((s) => s.outcome === "ok").at(-1)?.at_ms ?? null,
          droppedSeries
        }
      };
    });
  }
}
