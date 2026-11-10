import { DurableObject } from "cloudflare:workers";
import diagnostics from "node:diagnostics_channel";

const OBSERVE_CHANNEL = "stats.observe";
const channel = diagnostics.channel(OBSERVE_CHANNEL);

interface Rows {
  readonly read: number;
  readonly written: number;
  readonly statements: number;
}

interface R2Ops {
  readonly classA: number;
  readonly classB: number;
}

interface Env {
  readonly LEDGER: DurableObjectNamespace<Ledger>;
  readonly MEDIA: R2Bucket;
  readonly GREETING: string;
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function publish(operation: string, rows: Rows | null, r2?: R2Ops): void {
  channel.publish({ kind: "operation", traceId: hex(16), spanId: hex(8), operation, synthetic: false, rows, ...(r2 === undefined ? {} : { r2 }) });
}

function count(value: string | null, fallback: number): number {
  if (value === null || !/^\d{1,6}$/u.test(value)) return fallback;
  return Number(value);
}

export class Ledger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ledger_rows (id INTEGER PRIMARY KEY, value TEXT)").toArray();
  }

  insert(rows: number): Rows {
    let read = 0;
    let written = 0;
    let statements = 0;
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < rows; index += 1) {
        const cursor = this.ctx.storage.sql.exec("INSERT INTO ledger_rows (value) VALUES (?)", `value-${index}`);
        cursor.toArray();
        read += cursor.rowsRead;
        written += cursor.rowsWritten;
        statements += 1;
      }
    });
    const account = { read, written, statements };
    publish("store.insert", account);
    return account;
  }

  scan(limit: number): Rows {
    const cursor = this.ctx.storage.sql.exec("SELECT id, value FROM ledger_rows ORDER BY id LIMIT ?", limit);
    const values = cursor.toArray();
    const account = { read: cursor.rowsRead, written: cursor.rowsWritten, statements: 1 };
    publish("store.scan", { ...account, read: values.length === 0 ? 0 : account.read });
    return account;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/insert") {
      publish("http.insert", null);
      const account = await env.LEDGER.get(env.LEDGER.idFromName("ledger")).insert(count(url.searchParams.get("count"), 1));
      return Response.json(account);
    }
    if (url.pathname === "/scan") {
      publish("http.scan", null);
      const account = await env.LEDGER.get(env.LEDGER.idFromName("ledger")).scan(count(url.searchParams.get("limit"), 1));
      return Response.json(account);
    }
    if (url.pathname === "/media") {
      await env.MEDIA.put("fixture", "value");
      const object = await env.MEDIA.get("fixture");
      const text = object === null ? null : await object.text();
      publish("http.media", null, { classA: 1, classB: 1 });
      return Response.json({ stored: text });
    }
    publish("http.root", null);
    return new Response(env.GREETING);
  }
} satisfies ExportedHandler<Env>;
