import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";

const script = join(import.meta.dirname, "restore-registrations.mjs");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const HOST = "h_0123456789abcdef0123456789abcdef";
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restore-registrations-"));
  const db = new DatabaseSync(join(dir, "stats.sqlite"));
  db.exec(`CREATE TABLE hosts (host_id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
    CREATE TABLE services (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL, ingest_token_hash TEXT, host_ids TEXT NOT NULL, health_url TEXT, unit TEXT, created_at_ms INTEGER NOT NULL)`);
  db.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(registrations: unknown) {
  const input = join(dir, "registrations.json");
  writeFileSync(input, JSON.stringify(registrations));
  return spawnSync(process.execPath, [script, dir, input, "test"], { encoding: "utf8" });
}

test("restores verifiers without ever receiving a token", () => {
  const result = run({
    hosts: [{ hostId: HOST, name: "alpha", tokenSha256: sha("host-token") }],
    services: [{ name: "svc", hostIds: [HOST], deployTokenSha256: sha("deploy-token"), healthUrl: "https://svc.example/healthz" }]
  });
  assert.equal(result.status, 0, result.stderr);
  const db = new DatabaseSync(join(dir, "stats.sqlite"), { readOnly: true });
  assert.equal((db.prepare("SELECT token_hash FROM hosts").get() as { token_hash: string }).token_hash, sha("host-token"));
  const service = db.prepare("SELECT token_hash, ingest_token_hash FROM services").get() as { token_hash: string; ingest_token_hash: string | null };
  db.close();
  assert.equal(service.token_hash, sha("deploy-token"));
  assert.equal(service.ingest_token_hash, null);
  const marker = JSON.parse(readFileSync(join(dir, "RESET.json"), "utf8"));
  assert.deepEqual(marker.unusableTokens, ["svc:ingest"]);
  assert.doesNotMatch(readFileSync(join(dir, "RESET.json"), "utf8"), /[0-9a-f]{64}/u);
});

test("rejects plaintext tokens and leaves the installation empty and closed", () => {
  const result = run({ hosts: [{ hostId: HOST, name: "alpha", token: "plaintext-token-value" }], services: [] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid host registration alpha/u);
  const db = new DatabaseSync(join(dir, "stats.sqlite"));
  db.exec("BEGIN IMMEDIATE; ROLLBACK");
  assert.equal((db.prepare("SELECT count(*) AS n FROM hosts").get() as { n: number }).n, 0);
  db.close();
  assert.throws(() => execFileSync("test", ["-e", join(dir, "RESET.json")]));
});
