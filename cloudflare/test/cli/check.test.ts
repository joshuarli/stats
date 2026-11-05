import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { accessToken } from "../access-token.ts";
import { runCli } from "./support.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const BUNDLE = join(ROOT, ".cloudflare/output/v0/workers/default/bundle/index.js");
const VARS = (JSON.parse(readFileSync(join(ROOT, "wrangler.test.jsonc"), "utf8")) as { vars: Record<string, string> }).vars;
const SCRATCH_ROOT = resolve(ROOT, "../.work/tmp");

interface CheckDocument {
  readonly payload: { readonly ok: boolean; readonly steps: readonly { readonly name: string; readonly ok: boolean; readonly code: string | null }[] };
  readonly error?: { readonly code: string };
}

let mf: Miniflare;
let origin: string;
let scratch: string;
let jwt: string;
let host: { hostId: string; token: string };

async function start(): Promise<void> {
  if (!existsSync(BUNDLE)) throw new Error(`the Worker bundle is missing at ${BUNDLE}; run \`pnpm build\` in cloudflare/ first`);
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [{
        name: "stats",
        modules: true,
        scriptPath: BUNDLE,
        compatibilityDate: "2026-10-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { ...VARS, TEST_NOW_MS: String(Date.now()) },
        durableObjects: { INSTALLATION: { className: "Installation", useSQLite: true } }
      }]
    }),
    host: "127.0.0.1",
    port: 0
  });
  origin = (await mf.ready).origin;
  jwt = await accessToken();
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "check-ingest-"));
  const created = await mf.dispatchFetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { "cf-access-jwt-assertion": jwt, "Content-Type": "application/json" }, body: JSON.stringify({ name: "check-ingest" }) });
  assert.equal(created.status, 201);
  host = await created.json() as { hostId: string; token: string };
}

async function stop(): Promise<void> {
  await mf?.dispose();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
}

function credentialFile(name: string, contents: object, mode: number): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(contents));
  chmodSync(path, mode);
  return path;
}

const accessEnv = () => ({ STATSCTL_AUTH_COMMAND: `printf '%s' ${jwt}`, STATSCTL_AUTH_HEADER: "cf-access-jwt-assertion" });
const check = (file: string) => runCli(["check", "ingest", "--credential-file", file, "--origin", origin, "--json"], accessEnv());

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
      const text = await runCli(["check", "ingest", "--credential-file", file, "--origin", origin], accessEnv());
      assert.equal(text.code, 0, text.stdout + text.stderr);
      assert.match(text.stdout, /check ingest passed/u);
      assertNoToken(text, host.token);
    });

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

    await t.test("an unreadable Access session still fails the readback with exit 3 after a clean ingest", async () => {
      const run = await runCli(["check", "ingest", "--credential-file", credentialFile("noaccess.json", host, 0o600), "--origin", origin, "--json"], { STATSCTL_AUTH_COMMAND: "exit 1" });
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
    const run = await runCli(["check", "ingest", "--credential-file", "shared.json", "--origin", "http://127.0.0.1:9", "--json"], { ...accessEnv(), INIT_CWD: invoked });
    assert.equal((JSON.parse(run.stdout) as { error: { code: string } }).error.code, "credential_file_mode", run.stdout + run.stderr);
  } finally {
    rmSync(invoked, { recursive: true, force: true });
  }
});
