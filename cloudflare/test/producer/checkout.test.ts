import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, startStack } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../../local/topology.ts";

const PRODUCER_EXPORT = join(CLOUDFLARE_ROOT, "../fixtures/producers/nanoshop-storied");
const STRIPE_SIMULATOR = "src/simulator/stripe/main.ts";
const MAILBOX = "src/simulator/mailbox/main.ts";
const SUCCESS_CARD = "4242424242424242";
const RECORDER = "producer-tail-recorder";
const DEADLINE_MS = 90_000;

function nanoshopCheckout(): string {
  const dir = process.env["NANOSHOP_DIR"];
  const prepare = "prepare with: export NANOSHOP_DIR=/path/to/nanoshop (a Nanoshop checkout at or after 3ea3073; nothing is installed or built there, the test runs its Stripe simulator and mailbox with node)";
  if (dir === undefined || dir === "") throw new Error(`NANOSHOP_DIR is not set; ${prepare}`);
  for (const entry of [STRIPE_SIMULATOR, MAILBOX]) if (!existsSync(join(dir, entry))) throw new Error(`NANOSHOP_DIR=${dir} has no ${entry}; ${prepare}`);
  return dir;
}

interface Manifest {
  readonly shopPort: number;
  readonly origins: { readonly mailboxApi: string };
  readonly tenants: readonly { readonly serviceName: string; readonly host: string; readonly stripeOrigin: string; readonly textBindings: Readonly<Record<string, string>>; readonly worker: { readonly compatibilityDate: string } }[];
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function send(port: number, host: string, path: string, init: { readonly form?: Readonly<Record<string, string>>; readonly cookie?: string; readonly headers?: IncomingHttpHeaders; readonly body?: Uint8Array; readonly method?: string } = {}): Promise<Reply> {
  const body = init.body ?? (init.form === undefined ? undefined : new TextEncoder().encode(new URLSearchParams(init.form).toString()));
  const headers: IncomingHttpHeaders = { ...init.headers, host };
  if (init.cookie !== undefined) headers["cookie"] = init.cookie;
  if (init.form !== undefined) Object.assign(headers, { origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" });
  if (body !== undefined) headers["content-length"] = String(body.byteLength);
  return new Promise((resolve, reject) => {
    const sent = request({ host: "127.0.0.1", port, path, method: init.method ?? (body === undefined ? "GET" : "POST"), headers, setHost: false }, response => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: new TextDecoder().decode(joined(chunks)) }));
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

function started(child: ChildProcess, ready: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (ready.test(output)) resolve();
    });
    child.once("exit", code => reject(new Error(`${child.spawnargs.join(" ")} exited ${code} before it was ready: ${output}`)));
  });
}

function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

const RECORDER_SCRIPT = `const counts = {};
const summaries = {};
export default {
  tail(events) {
    for (const item of events) {
      const event = item.event ?? {};
      const what = event.rpcMethod !== undefined ? "rpc " + event.rpcMethod
        : event.request !== undefined ? event.request.method + " " + new URL(event.request.url).pathname
        : event.cron !== undefined ? "scheduled " + event.cron
        : event.scheduledTime !== undefined ? "alarm" : "other";
      const key = item.executionModel + " " + what;
      counts[key] = (counts[key] ?? 0) + 1;
      for (const published of item.diagnosticsChannelEvents ?? []) {
        const message = published.message ?? {};
        if (published.channel !== "stats.observe" || message.kind !== "operation") continue;
        const total = summaries[message.operation] ?? { summaries: 0, rows: null };
        total.summaries += 1;
        if (message.rows !== null) {
          const rows = total.rows ?? { accounted: 0, read: 0, written: 0, statements: 0 };
          rows.accounted += 1;
          rows.read += message.rows.read;
          rows.written += message.rows.written;
          rows.statements += message.rows.statements;
          total.rows = rows;
        }
        summaries[message.operation] = total;
      }
    }
  },
  fetch(request) { return Response.json(new URL(request.url).pathname === "/summaries" ? summaries : counts); }
};`;

interface CountedRows {
  readonly accounted: number;
  readonly read: number;
  readonly written: number;
  readonly statements: number;
}

interface CountedRow {
  readonly operation: string | null;
  readonly count: number;
  readonly failed: number;
  readonly rows: CountedRows | null;
}

function addRows(a: CountedRows | null, b: CountedRows | null): CountedRows | null {
  if (a === null) return b;
  if (b === null) return a;
  return { accounted: a.accounted + b.accounted, read: a.read + b.read, written: a.written + b.written, statements: a.statements + b.statements };
}

function statsctl(env: Readonly<Record<string, string>>, service: string): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(CLOUDFLARE_ROOT, "src/cli/statsctl.ts"), "observe", "operations", "--project", service, "--window", "1h", "--json"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise(resolve => child.on("close", status => resolve({ status, stdout, stderr })));
}

await test("a checkout with simulated payment through a producer export reaches statsctl as exact counts by operation name, with the rows each invocation published", async t => {
  const nanoshop = nanoshopCheckout();
  const manifest = JSON.parse(readFileSync(join(PRODUCER_EXPORT, "producer-export.json"), "utf8")) as Manifest;
  const [tenant] = manifest.tenants as [Manifest["tenants"][number]];
  const stripe = new URL(tenant.stripeOrigin);
  const mailbox = new URL(manifest.origins.mailboxApi);

  const webhooks: { readonly type: string; readonly status: number }[] = [];
  const relay = createServer((incoming, outgoing) => {
    const chunks: Uint8Array[] = [];
    incoming.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = joined(chunks);
      void send(manifest.shopPort, tenant.host, incoming.url ?? "/", { method: incoming.method ?? "POST", headers: incoming.headers, body }).then(reply => {
        webhooks.push({ type: (JSON.parse(new TextDecoder().decode(body)) as { type: string }).type, status: reply.status });
        outgoing.writeHead(reply.status).end(reply.body);
      }, (error: unknown) => outgoing.writeHead(502).end(String(error)));
    });
  });
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", () => resolve()));
  const relayPort = (relay.address() as { port: number }).port;
  const simulator = spawn(process.execPath, [join(nanoshop, STRIPE_SIMULATOR), "--port", stripe.port, "--webhook-url", `http://127.0.0.1:${relayPort}/webhooks/stripe`, "--webhook-secret", tenant.textBindings["STRIPE_WEBHOOK_SECRET"]!], { stdio: ["ignore", "pipe", "inherit"] });
  const mail = spawn(process.execPath, [join(nanoshop, MAILBOX), "--port", mailbox.port], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await Promise.all([started(simulator, /stripe simulator api base/u), started(mail, /mailbox api base/u)]);
    const stack = await startStack({ nowMs: null, producers: [PRODUCER_EXPORT], producerTail: { name: RECORDER, modules: true, script: RECORDER_SCRIPT, compatibilityDate: tenant.worker.compatibilityDate } });
    let disposed = false;
    try {
      const recorded = async (): Promise<Readonly<Record<string, number>>> => await (await (await stack.mf.getWorker(RECORDER)).fetch("http://recorder/")).json() as Record<string, number>;
      const published = async (): Promise<Readonly<Record<string, { readonly summaries: number; readonly rows: CountedRows | null }>>> => await (await (await stack.mf.getWorker(RECORDER)).fetch("http://recorder/summaries")).json() as Record<string, { summaries: number; rows: CountedRows | null }>;

      const added = await send(manifest.shopPort, tenant.host, "/cart/items", { form: { variant_id: "1", quantity: "1" } });
      assert.equal(added.status, 303);
      const cookie = String(added.headers["set-cookie"]?.[0]).split(";")[0]!;
      const review = await send(manifest.shopPort, tenant.host, "/checkout/review", { cookie, form: { email: "shopper@storied.example", fulfillment: "ship", recipient: "Shopper", line1: "1 Main St", line2: "", city: "Seattle", region: "WA", postal_code: "98101" } });
      assert.equal(review.status, 303, review.body.slice(0, 300));
      const accepted = await send(manifest.shopPort, tenant.host, `${new URL(String(review.headers.location), `http://${tenant.host}`).pathname}/accept`, { cookie, form: {} });
      const pay = new URL(String(accepted.headers.location));
      assert.equal(accepted.status, 303);
      assert.equal(pay.origin, stripe.origin, "the session was created by the simulator through the passthrough");
      const paid = await send(Number(stripe.port), stripe.host, pay.pathname, { form: { card: SUCCESS_CARD } });
      assert.equal(paid.status, 303);

      const env = cliEnv(stack.origin);
      const sent = { "request.cart-add": 1, "request.checkout-review": 1, "request.checkout-accept": 1 };
      const reviewCommands = 1;
      const acceptCommandsWithSessionRecord = 2;
      const deadline = Date.now() + DEADLINE_MS;
      let last = "";
      for (;;) {
        const before = await recorded();
        const run = await statsctl(env, tenant.serviceName);
        const after = await recorded();
        assert.equal(run.status, 0, run.stderr);
        const envelope = JSON.parse(run.stdout) as { schema: string; project: string; payload: { source: string; operations: CountedRow[] } };
        assert.equal(envelope.schema, "statsctl/1");
        assert.equal(envelope.project, tenant.serviceName);
        assert.equal(envelope.payload.source, "counts");
        const byName = new Map<string, CountedRow>();
        for (const row of envelope.payload.operations) {
          if (row.operation === null) continue;
          const total = byName.get(row.operation) ?? { operation: row.operation, count: 0, failed: 0, rows: null };
          byName.set(row.operation, { operation: row.operation, count: total.count + row.count, failed: total.failed + row.failed, rows: addRows(total.rows, row.rows) });
        }
        const stored = webhooks.filter(webhook => webhook.status === 200).length;
        const expected: Record<string, number> = {
          ...sent,
          "request.webhook": stored,
          "store.rpc.commerceCommand": reviewCommands + acceptCommandsWithSessionRecord + stored,
          "store.alarm": after["durableObject alarm"] ?? 0
        };
        const actual = Object.fromEntries(Object.keys(expected).map(name => [name, byName.get(name)?.count ?? 0]));
        const failed = [...byName.values()].filter(row => row.failed > 0).map(row => row.operation);
        const settled = webhooks.some(webhook => webhook.type === "payment_intent.succeeded") && (await send(Number(mailbox.port), mailbox.host, "/")).body.includes("Order #1 confirmed");
        const stable = JSON.stringify(before) === JSON.stringify(after);
        last = JSON.stringify({ expected, actual, failed, settled, stable, recorded: after, webhooks });
        if (settled && stable && JSON.stringify(actual) === JSON.stringify(expected)) {
          assert.deepEqual(failed, []);
          assert.ok(expected["store.alarm"]! >= 1, last);
          assert.equal(after["durableObject rpc commerceCommand"], expected["store.rpc.commerceCommand"], last);
          assert.equal(after["stateless POST /webhooks/stripe"], stored, last);
          const producer = await published();
          for (const name of ["request.checkout-accept", "store.rpc.commerceCommand"]) {
            assert.equal(producer[name]?.summaries, expected[name], `${name}: one published summary per invocation; ${JSON.stringify(producer)}`);
            assert.deepEqual(byName.get(name)?.rows, producer[name]?.rows, `${name}: statsctl rows equal the producer's published summaries; ${JSON.stringify(producer)}`);
          }
          assert.equal(producer["request.checkout-accept"]?.rows, null, "a Worker invocation has no SQLite account of its own");
          assert.ok((producer["store.rpc.commerceCommand"]?.rows?.statements ?? 0) > 0);
          t.diagnostic(`statsctl rows by operation: ${JSON.stringify(Object.fromEntries([...byName].map(([name, row]) => [name, row.rows])))}`);
          break;
        }
        assert.ok(Date.now() < deadline, `statsctl did not converge on the checkout's counts within ${DEADLINE_MS / 1000} s: ${last}`);
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      assert.deepEqual(stack.outbound.unexpected(), []);
      disposed = true;
      await stack.dispose();
    } finally {
      if (!disposed) await stack.dispose().catch(() => undefined);
    }
  } finally {
    await Promise.all([stopped(simulator), stopped(mail)]);
    await new Promise<void>(resolve => relay.close(() => resolve()));
  }
});
