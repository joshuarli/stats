import type { SqlDatabase } from "../sql.ts";
import { rowPoints, type RawRow, type RowPoints } from "../../aggregate.ts";
import { parseDelta } from "../../delta.ts";
import { RAW_RETENTION_MS } from "../../limits.ts";
import type { Sample } from "../../protocol.ts";

const CACHED_RAW_ROWS_KEPT = 16_000;

interface CachedRow {
  readonly atMs: number;
  readonly monoMs: number;
  readonly points: RowPoints;
}

interface HostRawRows {
  fromMs: number;
  readonly rows: CachedRow[];
}

type RawSampleRow = {
  readonly rowid: number;
  readonly host_id: string;
  readonly payload: string;
  readonly delta: string;
  readonly at_ms: number;
  readonly mono_ms: number;
};

function cachedRow(row: RawSampleRow): CachedRow {
  const raw: RawRow = { sample: JSON.parse(row.payload) as Sample, delta: parseDelta(row.delta) };
  return { atMs: row.at_ms, monoMs: row.mono_ms, points: rowPoints(raw) };
}

function rowOrder(left: CachedRow, right: CachedRow): number {
  return left.atMs - right.atMs || left.monoMs - right.monoMs;
}

function firstAtOrAfter(rows: readonly CachedRow[], atMs: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle]!.atMs < atMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export class RawRowCache {
  private readonly rows = new Map<string, HostRawRows>();
  private through = 0;

  clear(): void {
    this.rows.clear();
    this.through = 0;
  }

  forget(hostId: string): void {
    this.rows.delete(hostId);
  }

  between(sql: SqlDatabase, hostId: string, fromMs: number, toMs: number, now: number): readonly RowPoints[] {
    const latest = sql.rows<{ rowid: number | null }>("SELECT MAX(rowid) AS rowid FROM samples")[0]?.rowid ?? 0;
    if (latest > this.through && this.rows.size > 0) {
      for (const row of sql.rows<RawSampleRow>("SELECT rowid, host_id, payload, delta, at_ms, mono_ms FROM samples WHERE rowid > ? ORDER BY rowid", this.through)) {
        const cached = this.rows.get(row.host_id);
        if (cached === undefined || row.at_ms < cached.fromMs) continue;
        const entry = cachedRow(row);
        const last = cached.rows.at(-1);
        if (last === undefined || rowOrder(last, entry) <= 0) cached.rows.push(entry);
        else cached.rows.splice(cached.rows.findIndex(existing => rowOrder(existing, entry) > 0), 0, entry);
      }
    }
    this.through = latest;
    let cached = this.rows.get(hostId);
    if (cached === undefined || fromMs < cached.fromMs) {
      const rows = sql.rows<RawSampleRow>("SELECT rowid, host_id, payload, delta, at_ms, mono_ms FROM samples WHERE host_id = ? AND at_ms >= ? AND rowid <= ? ORDER BY at_ms ASC, mono_ms ASC", hostId, fromMs, this.through);
      cached = { fromMs, rows: rows.map(cachedRow) };
      this.rows.set(hostId, cached);
    }
    const expired = firstAtOrAfter(cached.rows, now - RAW_RETENTION_MS);
    if (expired > 0) {
      cached.rows.splice(0, expired);
      cached.fromMs = Math.max(cached.fromMs, now - RAW_RETENTION_MS);
    }
    this.rows.delete(hostId);
    this.rows.set(hostId, cached);
    let total = [...this.rows.values()].reduce((sum, entry) => sum + entry.rows.length, 0);
    for (const [otherId, other] of this.rows) {
      if (total <= CACHED_RAW_ROWS_KEPT || otherId === hostId) break;
      this.rows.delete(otherId);
      total -= other.rows.length;
    }
    return cached.rows.slice(firstAtOrAfter(cached.rows, fromMs), firstAtOrAfter(cached.rows, toMs + 1)).map(row => row.points);
  }
}
