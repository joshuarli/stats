import { startGateway, type LocalGateway } from "../../local/gateway.ts";
import { TEST_GATEWAY_SECRET } from "../gateway-headers.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Miniflare } from "miniflare";
import { openStatsWorker, type StatsWorker } from "../../local/stack.ts";
import { fakeOrigin, runCli } from "./support.ts";
import { encodeHostHistory, hostHistoryColumns } from "../../src/history-frame.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRATCH_ROOT = resolve(ROOT, "../.work/tmp");

interface CheckDocument {
  readonly payload: { readonly ok: boolean; readonly steps: readonly { readonly name: string; readonly ok: boolean; readonly code: string | null }[] };
  readonly error?: { readonly code: string };
}

let worker: StatsWorker | undefined;
let mf: Miniflare;
let origin: string;
let scratch: string;
let gateway: LocalGateway | undefined;
let workerOrigin: string;
let host: { hostId: string; token: string };

async function start(): Promise<void> {
  worker = openStatsWorker({ testNowMs: String(Date.now()) });
  mf = worker.mf;
  workerOrigin = (await mf.ready).origin.replace(/\/$/u, "");
  gateway = await startGateway(workerOrigin, TEST_GATEWAY_SECRET);
  origin = gateway.origin;
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "check-ingest-"));
  const created = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "check-ingest" }) });
  assert.equal(created.status, 201);
  host = await created.json() as { hostId: string; token: string };
}

async function stop(): Promise<void> {
  await gateway?.close();
  await worker?.dispose();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
}

function credentialFile(name: string, contents: object, mode: number): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(contents));
  chmodSync(path, mode);
  return path;
}

const check = (file: string) => runCli(["check", "ingest", "--credential-file", file, "--origin", origin, "--json"]);

function assertNoToken(run: { stdout: string; stderr: string }, token: string): void {
  assert.ok(!run.stdout.includes(token), "token leaked to stdout");
  assert.ok(!run.stderr.includes(token), "token leaked to stderr");
}

await test("check ingest against the built Worker", async t => {
  await start();
  try {
    await t.test("an accepted sample is read back from latest and history, and a replay is a duplicate that stores nothing", async () => {
      const file = credentialFile("good.json", host, 0o600);
      const run = await check(file);
      assert.equal(run.code, 0, run.stdout + run.stderr);
      const document = JSON.parse(run.stdout) as CheckDocument;
      assert.deepEqual(document.payload.steps.map(step => [step.name, step.ok]), ["encode", "ingest", "ack", "latest", "history", "replay", "stored-count"].map(name => [name, true]));
      assertNoToken(run, host.token);
      const text = await runCli(["check", "ingest", "--credential-file", file, "--origin", origin]);
      assert.equal(text.code, 0, text.stdout + text.stderr);
      assert.match(text.stdout, /check ingest passed/u);
      assertNoToken(text, host.token);
    });

    for (const changed of ["latest", "history"] as const) {
      await t.test(`a changed ${changed} value fails the durable readback`, async () => {
        const created = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `fake-${changed}` }) });
        const fakeHost = await created.json() as { hostId: string; token: string };
        let atMs = 0;
        const fake = await fakeOrigin((request, response) => {
          void (async () => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of request) chunks.push(chunk as Uint8Array);
            const body = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
            let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
            const upstream = await fetch(`${origin}${request.url}`, {
              method: request.method ?? "GET", headers: { "content-type": request.headers["content-type"] ?? "", authorization: request.headers.authorization ?? "" },
              ...(chunks.length ? { body } : {})
            });
            const bytes = new Uint8Array(await upstream.arrayBuffer());
            if (request.url?.endsWith("/latest")) {
              const data = JSON.parse(new TextDecoder().decode(bytes)) as { sample: { atMs: string; cpuCount: number } };
              atMs = Number(data.sample.atMs);
              if (changed === "latest") data.sample.cpuCount = 5;
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify(data));
            } else if (request.url?.includes("/history?") && changed === "history") {
              const frame = encodeHostHistory(hostHistoryColumns({ hostId: fakeHost.hostId, kind: "summary", fromMs: atMs - 60000, toMs: atMs + 120000, resolution: "raw", stepMs: 15000, points: [{ atMs, coverageMs: 0, partial: false, cpuCount: 5, uptimeMs: 123456 }] }));
              response.writeHead(200, { "content-type": "application/vnd.stats.history.v1" });
              response.end(frame);
            } else {
              response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" });
              response.end(bytes);
            }
          })().catch(error => response.destroy(error as Error));
        });
        try {
          const run = await runCli(["check", "ingest", "--credential-file", credentialFile(`${changed}.json`, fakeHost, 0o600), "--origin", fake.origin, "--json"]);
          assert.equal(run.code, 7, run.stdout + run.stderr);
          const document = JSON.parse(run.stdout) as CheckDocument;
          assert.equal(document.payload.steps.find(step => !step.ok)?.code, "readback_mismatch");
        } finally { await fake.close(); }
      });
    }

    await t.test("a wrong host token exits 3 and the token is not printed", async () => {
      const wrong = `nft_${"A".repeat(43)}`;
      const run = await check(credentialFile("wrong.json", { hostId: host.hostId, token: wrong }, 0o600));
      assert.equal(run.code, 3, run.stdout + run.stderr);
      assert.equal((JSON.parse(run.stdout) as CheckDocument).error?.code, "ingest_unauthorized");
      assertNoToken(run, wrong);
      assertNoToken(run, host.token);
    });

    await t.test("a credential file readable by group or others exits 3 before any request", async () => {
      const run = await check(credentialFile("loose.json", host, 0o644));
      assert.equal(run.code, 3, run.stdout + run.stderr);
      assert.equal((JSON.parse(run.stdout) as CheckDocument).error?.code, "credential_file_mode");
      assertNoToken(run, host.token);
    });

    await t.test("a request that bypasses the gateway still fails the readback with exit 3 after a clean ingest", async () => {
      const run = await runCli(["check", "ingest", "--credential-file", credentialFile("nogateway.json", host, 0o600), "--origin", workerOrigin, "--json"]);
      assert.equal(run.code, 3, run.stdout + run.stderr);
      assertNoToken(run, host.token);
    });
  } finally {
    await stop();
  }
});

await test("a relative credential path resolves from the directory statsctl was invoked in, as verify's files do", async () => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const invoked = mkdtempSync(join(SCRATCH_ROOT, "check-relative-"));
  try {
    writeFileSync(join(invoked, "shared.json"), JSON.stringify({ hostId: "h_0", token: "t" }));
    chmodSync(join(invoked, "shared.json"), 0o644);
    const run = await runCli(["check", "ingest", "--credential-file", "shared.json", "--origin", "http://127.0.0.1:9", "--json"], { INIT_CWD: invoked });
    assert.equal((JSON.parse(run.stdout) as { error: { code: string } }).error.code, "credential_file_mode", run.stdout + run.stderr);
  } finally {
    rmSync(invoked, { recursive: true, force: true });
  }
});
