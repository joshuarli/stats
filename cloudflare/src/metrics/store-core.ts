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
type Snapshot = { collector: string; instance: string; at_ms: number; started_at: number; expected: string; queued: number; queue_high: number; targets: string };
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
      CREATE TABLE IF NOT EXISTS metric_snapshots (collector TEXT NOT NULL, instance TEXT NOT NULL,
      at_ms INTEGER NOT NULL, started_at INTEGER NOT NULL, expected TEXT NOT NULL,
      queued INTEGER NOT NULL, queue_high INTEGER NOT NULL, targets TEXT NOT NULL,
      PRIMARY KEY (collector, instance, at_ms)) WITHOUT ROWID;
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
  ingest(batch: Batch, now: number): { accepted: number; duplicates: number; rejected: { target: string; sequence: number; code: string }[]; outcomes: { target: string; sequence: number; status: string }[] } {
    encodeBatch(batch);
    const result = { accepted: 0, duplicates: 0, rejected: [] as { target: string; sequence: number; code: string }[], outcomes: [] as { target: string; sequence: number; status: string }[] };
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
          if (identical) { result.duplicates++; result.outcomes.push({ target: s.target, sequence: s.sequence, status: "duplicate" }); continue; }
          code = "conflict";
        }
        if (code) {
          result.rejected.push({ target: s.target, sequence: s.sequence, code });
          result.outcomes.push({ target: s.target, sequence: s.sequence, status: "rejected" });
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
        result.outcomes.push({ target: s.target, sequence: s.sequence, status: "accepted" });
      }
      const lastDelivery = this.prepare("SELECT max(received_at) AS latest FROM metric_deliveries WHERE collector = ? AND instance = ?").get(batch.collector.name, batch.collector.instance) as { latest: number | null };
      const receivedAt = Math.max(now, (lastDelivery.latest ?? now - 1) + 1);
      this.prepare("INSERT INTO metric_deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        batch.collector.name, batch.collector.instance, receivedAt, batch.collector.startedAtMs,
        canonical(batch.expected), batch.delivery.queued, batch.delivery.queueHigh, 0, 0, 0
      );
      this.prepare("INSERT OR IGNORE INTO metric_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        batch.collector.name, batch.collector.instance, batch.delivery.atMs, batch.collector.startedAtMs,
        canonical(batch.expected), batch.delivery.queued, batch.delivery.queueHigh, canonical(batch.delivery.targets)
      );
      this.prepare("DELETE FROM metric_snapshots WHERE at_ms <= ?").run(now - retention);
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
    const deliveries = this.prepare("SELECT * FROM metric_snapshots WHERE at_ms <= ? ORDER BY at_ms").all(now) as unknown as Snapshot[];
    const keys = new Set(rows.map((r) => `${r.collector}\0${r.target}`));
    for (const d of deliveries) for (const target of JSON.parse(d.expected) as string[]) keys.add(`${d.collector}\0${target}`);
    return [...keys].sort().map((key) => {
      const [collector, target] = key.split("\0") as [string, string];
      const samples = rows.filter((r) => r.collector === collector && r.target === target);
      const ds = deliveries.filter((d) => d.collector === collector && (JSON.parse(d.expected) as string[]).includes(target));
      const instances = new Set([...samples.map((s) => s.instance), ...ds.filter(d => d.at_ms >= from && d.at_ms <= to).map(d => d.instance)]);
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
      const firstDelivery = ds.filter(d => d.at_ms <= from).at(-1);
      const lastDelivery = ds.find(d => d.at_ms >= to);
      const last = this.prepare("SELECT * FROM metric_scrapes WHERE collector=? AND target=? AND at_ms<=? AND expires_at>? ORDER BY at_ms DESC LIMIT 1").get(collector, target, now, now) as Row | undefined;
      const lastOk = this.prepare("SELECT * FROM metric_scrapes WHERE collector=? AND target=? AND outcome='ok' AND at_ms<=? AND expires_at>? ORDER BY at_ms DESC LIMIT 1").get(collector, target, to, now) as Row | undefined;
      const families: Record<string, { okSamples: number; usable: boolean; reason: string | null }> = {};
      for (const [name, spec] of Object.entries(catalog)) {
        if ((target.startsWith("engine:") ? spec.source !== "engine" : spec.source === "engine")) continue;
        const counts = new Map<string, number>();
        for (const sample of samples) {
          if (sample.outcome !== "ok") continue;
          const values = (JSON.parse(sample.payload) as { values: Scrape["values"] }).values;
          if (!values[name]?.length) continue;
          const key = `${sample.instance}:${sample.incarnation}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const okSamples = Math.max(0, ...counts.values());
        families[name] = { okSamples, usable: okSamples >= 2, reason: okSamples === 0 ? "family-missing" : okSamples < 2 ? "insufficient-samples" : null };
      }
      const counters = (d: Snapshot) => (JSON.parse(d.targets) as Record<string, { scraped: number; accepted: number; duplicates: number; rejected: number; dropped: number; failed: number }>)[target]!;
      const checkpoint = (d: Snapshot) => { const c = counters(d); return { startedAtMs: d.started_at, atMs: d.at_ms, accepted: c.accepted + c.duplicates, dropped: c.dropped + c.rejected + c.failed, queued: d.queued }; };
      const restarted = instances.size > 1 || !!firstDelivery && !!lastDelivery && firstDelivery.instance !== lastDelivery.instance;
      const stale = !lastOk || to - lastOk.at_ms > 45000;
      const status = !firstDelivery || !lastDelivery ? "window-open" : restarted ? "collector-restart" : stale ? "stale" : "ok";
      const startCounters = firstDelivery && counters(firstDelivery), endCounters = lastDelivery && counters(lastDelivery);
      const received = firstDelivery && lastDelivery && startCounters && endCounters && !restarted
        ? this.prepare("SELECT count(*) AS n FROM metric_scrapes WHERE collector=? AND instance=? AND target=? AND sequence>? AND sequence<=? AND expires_at>?").get(collector, firstDelivery.instance, target, startCounters.scraped, endCounters.scraped, now) as { n: number } : null;
      const windowQueues = ds.filter(d => d.at_ms >= from && d.at_ms <= to).map(d => d.queued);
      const evidence = firstDelivery && lastDelivery && last && releases.size && received && status === "ok" ? {
        source: target, producer: collector, releaseId: releases.size === 1 ? [...releases][0] : "mixed", lastSeenMs: last.at_ms,
        sequenceStart: checkpoint(firstDelivery), sequenceEnd: checkpoint(lastDelivery), received: received.n
      } : null;
      return {
        evidence,
        detail: {
          source: target, producer: collector, scrapeFailures: failures, incarnations: incarnations.size,
          resets, counterRegressions, lastOkAtMs: lastOk?.at_ms ?? null,
          droppedSeries, families, status, values: lastOk ? (JSON.parse(lastOk.payload) as { values: Scrape["values"] }).values : {}, queueMax: windowQueues.length ? Math.max(...windowQueues) : null,
          queueHigh: Math.max(0, ...ds.map(d => d.queue_high))
        }
      };
    });
  }
}
