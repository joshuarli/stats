import { DurableObject } from "cloudflare:workers";
import { bearerToken, constantTimeEqual, generateHostId, generateToken, tokenHash } from "./auth";
import { canonicalJson, parseBatch, type Sample } from "./protocol";

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
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
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
  return name.length >= 1 && name.length <= 64 && ![...name].some(character => character.codePointAt(0)! < 32 || character === "\u007f");
}

export class Installation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
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
        const previous = this.ctx.storage.sql.exec<SampleRow>("SELECT mono_ms, payload, seq FROM samples WHERE host_id = ? AND boot_id = ? AND mono_ms < ? ORDER BY mono_ms DESC LIMIT 1", parsed.hostId, parsed.bootId, entry.mono).toArray()[0];
        const next = this.ctx.storage.sql.exec<SampleRow>("SELECT mono_ms, payload, seq FROM samples WHERE host_id = ? AND boot_id = ? AND mono_ms > ? ORDER BY mono_ms ASC LIMIT 1", parsed.hostId, parsed.bootId, entry.mono).toArray()[0];
        const elapsed = previous === undefined ? 0 : entry.mono - previous.mono_ms;
        this.ctx.storage.sql.exec("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", parsed.hostId, parsed.bootId, entry.seq, entry.at, now, entry.mono, elapsed, canonicalJson(entry.sample));
        if (next !== undefined) this.ctx.storage.sql.exec("UPDATE samples SET elapsed_ms = ? WHERE host_id = ? AND boot_id = ? AND seq = ?", next.mono_ms - entry.mono, parsed.hostId, parsed.bootId, next.seq);
        accepted += 1;
      }
      if (accepted + duplicates > 0) this.ctx.storage.sql.exec("UPDATE hosts SET last_received_at_ms = ? WHERE host_id = ?", now, parsed.hostId);
    });

    if (accepted + duplicates === 0) return json({ error: { code: rejected[0]?.code ?? "invalid_sample", message: "no samples were accepted" }, rejected }, 400);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(now + 10 * 60 * 1000);
    return json({ v: 1, accepted, duplicates, rejected });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/ingest") return await this.ingest(request);
      if (path === "/hosts" && request.method === "GET") return json({ hosts: await this.listHosts() });
      const latest = /^\/hosts\/(h_[0-9a-f]{32})\/latest$/u.exec(path);
      if (latest !== null && request.method === "GET") {
        const sample = await this.latest(latest[1]!);
        return sample === null ? failure("not_found", "no samples for host", 404) : json(sample);
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
      return failure("not_found", "unknown object route", 404);
    } catch (error) {
      return failure("internal", error instanceof Error ? error.message : "internal error", 500);
    }
  }
}
