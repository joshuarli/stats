import { DurableObject } from "cloudflare:workers";
import { bearerToken, constantTimeEqual, generateHostId, generateToken, tokenHash } from "./auth";
import { canonicalJson, parseBatch, type Sample } from "./protocol";
import { computeDelta, parseDelta } from "./delta";
import { combineRollups, downsample, historyQuery, HOUR_MS, kindValue, MINUTE_MS, rawPoints, rollupPoints, rollupFromRaw, RANGE_MS, type HistoryKind, type HistoryPoints, type HistoryQuery, type RawRow, type RangeKey, type RollupPayload } from "./aggregate";

export const ONLINE_WINDOW_MS = 45_000;
export const RAW_RETENTION_MS = 48 * 60 * 60 * 1000;
export const WINDOW_MS = 60_000;
export const MAX_REQUESTS_PER_WINDOW = 6;

type HostRow = {
  readonly host_id: string;
  readonly name: string;
  readonly token_hash: string;
  readonly created_at_ms: number;
  readonly revoked_at_ms: number | null;
  readonly last_received_at_ms: number | null;
  readonly window_start_ms: number;
  readonly window_count: number;
};

type SampleRow = {
  readonly mono_ms: number;
  readonly at_ms: number;
  readonly payload: string;
  readonly seq: string;
};

export interface HostSummary {
  readonly hostId: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly revoked: boolean;
  readonly lastReceivedAtMs: number | null;
  readonly online: boolean;
}

export interface LatestSample {
  readonly hostId: string;
  readonly receivedAtMs: number;
  readonly sample: Sample;
}

export interface History {
  readonly hostId: string;
  readonly range?: RangeKey;
  readonly kind: HistoryKind;
  readonly fromMs: number;
  readonly toMs: number;
  readonly resolution: "raw" | "1m" | "1h";
  readonly stepMs: number;
  readonly points?: readonly unknown[];
  readonly series?: readonly unknown[];
}

const HOSTS = `CREATE TABLE IF NOT EXISTS hosts (
  host_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  last_received_at_ms INTEGER,
  window_start_ms INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0
) STRICT`;
const SAMPLES = `CREATE TABLE IF NOT EXISTS samples (
  host_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  seq TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  mono_ms INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  delta TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL,
  PRIMARY KEY (host_id, boot_id, seq)
) STRICT`;
const SAMPLE_TIME = "CREATE INDEX IF NOT EXISTS samples_by_time ON samples (host_id, at_ms)";
const SAMPLE_MONO = "CREATE INDEX IF NOT EXISTS samples_by_mono ON samples (host_id, boot_id, mono_ms)";
const ROLLUPS = `CREATE TABLE IF NOT EXISTS rollups (
  host_id TEXT NOT NULL,
  resolution TEXT NOT NULL,
  bucket_ms INTEGER NOT NULL,
  coverage_ms INTEGER NOT NULL,
  partial INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (host_id, resolution, bucket_ms)
) STRICT`;
const ROLLUP_TIME = "CREATE INDEX IF NOT EXISTS rollups_by_time ON rollups (host_id, resolution, bucket_ms)";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function failure(code: string, message: string, status: number, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, headers);
}

async function readLimitedText(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (request.body === null) return "";
  // SAFETY: Workers' Request.body getReader() erases the chunk type; HTTP body chunks are Uint8Array.
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = result.value;
    total += chunk.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function validName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 0x7f) return false;
  }
  return true;
}

export class Installation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      for (const statement of [HOSTS, SAMPLES, SAMPLE_TIME, SAMPLE_MONO, ROLLUPS, ROLLUP_TIME]) this.ctx.storage.sql.exec(statement);
    });
  }

  private now(): number {
    if (this.env.ENVIRONMENT === "test" && this.env.TEST_NOW_MS !== undefined) {
      const value = Number(this.env.TEST_NOW_MS);
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    return Date.now();
  }

  private host(hostId: string): HostRow | undefined {
    return this.ctx.storage.sql.exec<HostRow>("SELECT * FROM hosts WHERE host_id = ?", hostId).toArray()[0];
  }

  async createHost(name: string): Promise<{ hostId: string; name: string; token: string }> {
    const trimmed = name.trim();
    if (!validName(trimmed)) throw new Error("host name must be 1-64 printable characters");
    const hostId = generateHostId();
    const token = generateToken();
    const hash = await tokenHash(token);
    this.ctx.storage.sql.exec("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES (?, ?, ?, ?)", hostId, trimmed, hash, this.now());
    return { hostId, name: trimmed, token };
  }

  async rotateHost(hostId: string): Promise<{ hostId: string; token: string }> {
    const host = this.host(hostId);
    if (host === undefined) throw new Error("host not found");
    const token = generateToken();
    const hash = await tokenHash(token);
    this.ctx.storage.sql.exec("UPDATE hosts SET token_hash = ?, revoked_at_ms = NULL WHERE host_id = ?", hash, hostId);
    return { hostId, token };
  }

  async revokeHost(hostId: string): Promise<boolean> {
    const host = this.host(hostId);
    if (host === undefined) return false;
    this.ctx.storage.sql.exec("UPDATE hosts SET revoked_at_ms = ? WHERE host_id = ?", this.now(), hostId);
    return true;
  }

  async purgeHost(hostId: string): Promise<boolean> {
    if (this.host(hostId) === undefined) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM samples WHERE host_id = ?", hostId);
      this.ctx.storage.sql.exec("DELETE FROM rollups WHERE host_id = ?", hostId);
      this.ctx.storage.sql.exec("DELETE FROM hosts WHERE host_id = ?", hostId);
    });
    return true;
  }

  async listHosts(): Promise<HostSummary[]> {
    const now = this.now();
    return this.ctx.storage.sql.exec<HostRow>("SELECT * FROM hosts ORDER BY host_id").toArray().map(host => ({
      hostId: host.host_id,
      name: host.name,
      createdAtMs: host.created_at_ms,
      revoked: host.revoked_at_ms !== null,
      lastReceivedAtMs: host.last_received_at_ms,
      online: host.revoked_at_ms === null && host.last_received_at_ms !== null && now - host.last_received_at_ms <= ONLINE_WINDOW_MS
    }));
  }

  async latest(hostId: string): Promise<LatestSample | null> {
    const row = this.ctx.storage.sql.exec<{ payload: string; received_at_ms: number }>("SELECT payload, received_at_ms FROM samples WHERE host_id = ? ORDER BY at_ms DESC, received_at_ms DESC LIMIT 1", hostId).toArray()[0];
    if (row === undefined) return null;
    return { hostId, receivedAtMs: row.received_at_ms, sample: JSON.parse(row.payload) as Sample };
  }

  private rebuildMinute(hostId: string, bucketMs: number): void {
    const rows = this.ctx.storage.sql.exec<{ payload: string; delta: string }>("SELECT payload, delta FROM samples WHERE host_id = ? AND at_ms >= ? AND at_ms < ? ORDER BY mono_ms", hostId, bucketMs, bucketMs + MINUTE_MS).toArray();
    if (rows.length === 0) {
      this.ctx.storage.sql.exec("DELETE FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms = ?", hostId, bucketMs);
      return;
    }
    const raw: RawRow[] = rows.map(row => ({ sample: JSON.parse(row.payload) as Sample, delta: parseDelta(row.delta) }));
    const payload = rollupFromRaw(raw, bucketMs, MINUTE_MS);
    if (payload === null) {
      this.ctx.storage.sql.exec("DELETE FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms = ?", hostId, bucketMs);
      return;
    }
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, '1m', ?, ?, ?, ?)", hostId, bucketMs, payload.coverageMs, payload.partial ? 1 : 0, JSON.stringify(payload));
  }

  private rebuildHour(hostId: string, hourMs: number): void {
    const rows = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms >= ? AND bucket_ms < ?", hostId, hourMs, hourMs + HOUR_MS).toArray();
    const payloads = rows.map(row => JSON.parse(row.payload) as RollupPayload);
    const payload = combineRollups(payloads, hourMs, HOUR_MS);
    if (payload === null) {
      this.ctx.storage.sql.exec("DELETE FROM rollups WHERE host_id = ? AND resolution = '1h' AND bucket_ms = ?", hostId, hourMs);
      return;
    }
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, '1h', ?, ?, ?, ?)", hostId, hourMs, payload.coverageMs, payload.partial ? 1 : 0, JSON.stringify(payload));
  }

  private rebuildRollups(hostId: string, minutes: readonly number[]): void {
    const unique = [...new Set(minutes)].sort((left, right) => left - right);
    for (const minute of unique) this.rebuildMinute(hostId, minute);
    for (const hour of new Set(unique.map(minute => Math.floor(minute / HOUR_MS) * HOUR_MS))) this.rebuildHour(hostId, hour);
  }

  async history(hostId: string, query: HistoryQuery, kind: HistoryKind): Promise<History | null> {
    if (this.host(hostId) === undefined) return null;
    const now = this.now();
    const toMs = "range" in query ? now : query.toMs;
    const fromMs = "range" in query ? now - RANGE_MS[query.range] : query.fromMs;
    const range = "range" in query ? { range: query.range } : {};
    const rawRange = fromMs >= now - RAW_RETENTION_MS;
    const resolution: "raw" | "1m" | "1h" = rawRange ? "raw" : fromMs >= now - 7 * 24 * 60 * 60 * 1000 ? "1m" : "1h";
    let points: HistoryPoints;
    let bucketMs = rawRange ? 15_000 : resolution === "1m" ? MINUTE_MS : HOUR_MS;
    if (rawRange) {
      const rows = this.ctx.storage.sql.exec<{ payload: string; delta: string; at_ms: number }>("SELECT payload, delta, at_ms FROM samples WHERE host_id = ? AND at_ms >= ? AND at_ms <= ? ORDER BY at_ms ASC, mono_ms ASC", hostId, fromMs, toMs).toArray();
      const raw: RawRow[] = rows.map(row => ({ sample: JSON.parse(row.payload) as Sample, delta: parseDelta(row.delta) }));
      if (raw.length > 1) bucketMs = Math.max(1, Number(raw[1]!.sample.atMs) - Number(raw[0]!.sample.atMs));
      points = rawPoints(raw, kind);
    } else {
      const rows = this.ctx.storage.sql.exec<{ payload: string; bucket_ms: number }>("SELECT payload, bucket_ms FROM rollups WHERE host_id = ? AND resolution = ? AND bucket_ms >= ? AND bucket_ms <= ? ORDER BY bucket_ms ASC", hostId, resolution, fromMs, toMs).toArray();
      if (rows.length > 1) bucketMs = Math.max(1, rows[1]!.bucket_ms - rows[0]!.bucket_ms);
      points = rollupPoints(rows.map(row => JSON.parse(row.payload) as RollupPayload), kind);
    }
    if (kind === "summary") {
      const sampled = downsample(points as Parameters<typeof downsample>[0]);
      return { hostId, ...range, kind, fromMs, toMs, resolution, stepMs: bucketMs * sampled.stride, points: sampled.items };
    }
    const series = points as { id: string; name?: string; points: unknown[] }[];
    const longest = series.reduce((maximum, entry) => Math.max(maximum, entry.points.length), 0);
    const stride = Math.max(1, Math.ceil(longest / 900));
    return {
      hostId, ...range, kind, fromMs, toMs, resolution, stepMs: bucketMs * stride,
      series: series.map(entry => ({ ...entry, points: entry.points.filter((_, index) => index % stride === 0) }))
    };
  }

  override async alarm(): Promise<void> {
    const now = this.now();
    const raw = this.ctx.storage.sql.exec("DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE received_at_ms < ? LIMIT 1000)", now - RAW_RETENTION_MS).rowsWritten;
    const minute = this.ctx.storage.sql.exec("DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE resolution = '1m' AND bucket_ms < ? LIMIT 1000)", now - 7 * 24 * 60 * 60 * 1000).rowsWritten;
    const hour = this.ctx.storage.sql.exec("DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE resolution = '1h' AND bucket_ms < ? LIMIT 1000)", now - 90 * 24 * 60 * 60 * 1000).rowsWritten;
    const more = raw + minute + hour >= 3000;
    await this.ctx.storage.setAlarm(now + (more ? 60_000 : 600_000));
  }

  private authorize(hostId: string, hash: string): { host: HostRow } | { code: "unauthorized" | "forbidden"; status: number } {
    const host = this.host(hostId);
    if (host === undefined || host.revoked_at_ms !== null || !constantTimeEqual(host.token_hash, hash)) return { code: "unauthorized", status: 401 };
    return { host };
  }

  async ingest(request: Request): Promise<Response> {
    if (request.method !== "POST") return failure("invalid_request", "POST required", 405);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) return failure("invalid_request", "application/json required", 415);
    const text = await readLimitedText(request, 65_536);
    if (text === null) return failure("too_large", "batch exceeds the body cap", 413);
    const parsed = parseBatch(text);
    if (!parsed.ok) return failure(parsed.code, parsed.message, parsed.code === "too_large" ? 413 : 400);
    const token = bearerToken(request.headers.get("authorization"));
    if (token === null) return failure("unauthorized", "a host bearer token is required", 401);
    const hash = await tokenHash(token);
    const authorized = this.authorize(parsed.hostId, hash);
    if ("code" in authorized) return failure(authorized.code, "host credential rejected", authorized.status);

    const now = this.now();
    const window = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    let limited = false;
    let rejectedCredential = false;
    this.ctx.storage.transactionSync(() => {
      const current = this.host(parsed.hostId);
      if (current === undefined || current.revoked_at_ms !== null || !constantTimeEqual(current.token_hash, hash)) {
        rejectedCredential = true;
        return;
      }
      if (current.window_start_ms === window && current.window_count >= MAX_REQUESTS_PER_WINDOW) {
        limited = true;
        return;
      }
      const count = current.window_start_ms === window ? current.window_count + 1 : 1;
      this.ctx.storage.sql.exec("UPDATE hosts SET window_start_ms = ?, window_count = ? WHERE host_id = ?", window, count, parsed.hostId);
    });
    if (rejectedCredential) return failure("unauthorized", "host credential rejected", 401);
    if (limited) return failure("rate_limited", "host request rate exceeded", 429, { "Retry-After": "60" });

    const rejected: { seq: string; code: string }[] = [];
    const affectedMinutes: number[] = [];
    let accepted = 0;
    let duplicates = 0;
    this.ctx.storage.transactionSync(() => {
      const valid: { sample: Sample; seq: string; at: number; mono: number }[] = [];
      for (const result of parsed.samples) {
        if (!result.ok) {
          if (result.seq !== undefined) rejected.push({ seq: result.seq, code: "invalid_sample" });
          continue;
        }
        const at = Number(result.sample.atMs);
        const mono = Number(result.sample.monoMs);
        if (at > now + 300_000) {
          rejected.push({ seq: result.sample.seq, code: "invalid_sample" });
          continue;
        }
        if (at < now - RAW_RETENTION_MS) {
          rejected.push({ seq: result.sample.seq, code: "too_old" });
          continue;
        }
        valid.push({ sample: result.sample, seq: result.sample.seq, at, mono });
      }
      valid.sort((left, right) => left.mono - right.mono);
      for (const entry of valid) {
        const existing = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM samples WHERE host_id = ? AND boot_id = ? AND seq = ?", parsed.hostId, parsed.bootId, entry.seq).toArray()[0];
        if (existing !== undefined) {
          if (existing.payload === canonicalJson(entry.sample)) duplicates += 1;
          else rejected.push({ seq: entry.seq, code: "conflict" });
          continue;
        }
        const same = this.ctx.storage.sql.exec<{ seq: string }>("SELECT seq FROM samples WHERE host_id = ? AND boot_id = ? AND mono_ms = ? LIMIT 1", parsed.hostId, parsed.bootId, entry.mono).toArray()[0];
        if (same !== undefined) {
          rejected.push({ seq: entry.seq, code: "invalid_sample" });
          continue;
        }
        const previous = this.ctx.storage.sql.exec<SampleRow>("SELECT mono_ms, at_ms, payload, seq FROM samples WHERE host_id = ? AND boot_id = ? AND mono_ms < ? ORDER BY mono_ms DESC LIMIT 1", parsed.hostId, parsed.bootId, entry.mono).toArray()[0];
        const next = this.ctx.storage.sql.exec<SampleRow>("SELECT mono_ms, at_ms, payload, seq FROM samples WHERE host_id = ? AND boot_id = ? AND mono_ms > ? ORDER BY mono_ms ASC LIMIT 1", parsed.hostId, parsed.bootId, entry.mono).toArray()[0];
        const elapsed = previous === undefined ? 0 : entry.mono - previous.mono_ms;
        const delta = computeDelta(previous === undefined ? undefined : JSON.parse(previous.payload) as Sample, entry.sample, elapsed);
        this.ctx.storage.sql.exec("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, delta, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", parsed.hostId, parsed.bootId, entry.seq, entry.at, now, entry.mono, elapsed, JSON.stringify(delta), canonicalJson(entry.sample));
        affectedMinutes.push(Math.floor(entry.at / MINUTE_MS) * MINUTE_MS);
        if (next !== undefined) {
          const nextDelta = computeDelta(entry.sample, JSON.parse(next.payload) as Sample, next.mono_ms - entry.mono);
          this.ctx.storage.sql.exec("UPDATE samples SET elapsed_ms = ?, delta = ? WHERE host_id = ? AND boot_id = ? AND seq = ?", next.mono_ms - entry.mono, JSON.stringify(nextDelta), parsed.hostId, parsed.bootId, next.seq);
          affectedMinutes.push(Math.floor(next.at_ms / MINUTE_MS) * MINUTE_MS);
        }
        accepted += 1;
      }
      if (accepted + duplicates > 0) this.ctx.storage.sql.exec("UPDATE hosts SET last_received_at_ms = ? WHERE host_id = ?", now, parsed.hostId);
    });

    if (accepted === 0 && duplicates === 0) return json({ error: { code: rejected[0]?.code ?? "invalid_sample", message: "no samples were accepted" }, rejected }, 400);
    if (affectedMinutes.length > 0) this.rebuildRollups(parsed.hostId, affectedMinutes);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(now + 10 * 60 * 1000);
    return json({ v: 1, accepted, duplicates, rejected });
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/ingest") return await this.ingest(request);
      if (path === "/hosts" && request.method === "GET") return json({ hosts: await this.listHosts() });
      const latest = /^\/hosts\/(h_[0-9a-f]{32})\/latest$/u.exec(path);
      if (latest !== null && request.method === "GET") {
        const sample = await this.latest(latest[1]!);
        return sample === null ? failure("not_found", "no samples for host", 404) : json(sample);
      }
      const history = /^\/hosts\/(h_[0-9a-f]{32})\/history$/u.exec(path);
      if (history !== null && request.method === "GET") {
        const url = new URL(request.url);
        const query = historyQuery(url.searchParams);
        const kind = url.searchParams.get("kind") === null ? "summary" : kindValue(url.searchParams.get("kind"));
        if (query === null || kind === null) return failure("invalid_request", "range, from and to, or kind is not supported", 400);
        const result = await this.history(history[1]!, query, kind);
        return result === null ? failure("not_found", "host not found", 404) : json(result);
      }
      if (path === "/admin/hosts" && request.method === "POST") {
        const body = await request.json<{ name?: unknown }>();
        if (typeof body.name !== "string") return failure("invalid_request", "name is required", 400);
        return json(await this.createHost(body.name), 201);
      }
      if (path === "/admin/hosts" && request.method === "GET") return json({ hosts: await this.listHosts() });
      const rotate = /^\/admin\/hosts\/(h_[0-9a-f]{32})\/rotate$/u.exec(path);
      if (rotate !== null && request.method === "POST") return json(await this.rotateHost(rotate[1]!));
      const revoke = /^\/admin\/hosts\/(h_[0-9a-f]{32})$/u.exec(path);
      if (revoke !== null && request.method === "DELETE") return (await this.revokeHost(revoke[1]!)) ? new Response(null, { status: 204 }) : failure("not_found", "host not found", 404);
      const purge = /^\/admin\/hosts\/(h_[0-9a-f]{32})\/purge$/u.exec(path);
      if (purge !== null && request.method === "DELETE") return (await this.purgeHost(purge[1]!)) ? new Response(null, { status: 204 }) : failure("not_found", "host not found", 404);
      return failure("not_found", "unknown object route", 404);
    } catch (error) {
      return failure("internal", error instanceof Error ? error.message : "internal error", 500);
    }
  }
}
