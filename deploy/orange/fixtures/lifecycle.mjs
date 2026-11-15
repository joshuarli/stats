import { DurableObject } from "cloudflare:workers";

export class Installation extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.generation = crypto.randomUUID();
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS records (identity TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/write") {
      const { identity, value, delay = 0 } = await request.json();
      if (delay) {
        console.log(`LIFECYCLE_PENDING_${this.env.MARKER}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO records VALUES (?, ?)", identity, value);
      return Response.json({ rows: [...this.ctx.storage.sql.exec("SELECT identity, value FROM records ORDER BY identity")] });
    }
    if (url.pathname === "/alarm") {
      await this.ctx.storage.setAlarm(Number(url.searchParams.get("at")));
      return Response.json({ scheduled: true });
    }
    return Response.json({ generation: this.generation, rows: [...this.ctx.storage.sql.exec("SELECT identity, value FROM records ORDER BY identity")] });
  }
  async alarm() {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO records VALUES ('alarm', 'fired')");
    console.log(`LIFECYCLE_ALARM_${this.env.MARKER}`);
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get("Stats-Gateway-Secret") !== env.GATEWAY_SECRET || request.headers.get("Stats-Tailnet-Identity") !== "user:lifecycle@example.com") return new Response("unauthorized", { status: 401 });
    return env.INSTALLATION.get(env.INSTALLATION.idFromName("lifecycle")).fetch(request);
  }
};
