import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const usage = "usage: restore-registrations.mjs DATA_DIR REGISTRATIONS.json REASON";
const HOST_ID = /^h_[0-9a-f]{32}$/u;
const NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const VERIFIER = /^[0-9a-f]{64}$/u;
const unusable = () => createHash("sha256").update(randomBytes(32).toString("hex")).digest("hex");

function fsyncPath(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function restore(db, registrations, now) {
  const restored = { hosts: [], services: [], unusableTokens: [] };
  for (const table of ["hosts", "services"]) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) === undefined) throw new Error(`table ${table} is missing; start the server once to create the schema`);
  if (db.prepare("SELECT count(*) AS n FROM hosts").get().n !== 0 || db.prepare("SELECT count(*) AS n FROM services").get().n !== 0) throw new Error("the installation already has registrations");
  for (const host of registrations.hosts) {
    if (!HOST_ID.test(host.hostId) || !NAME.test(host.name) || !VERIFIER.test(host.tokenSha256 ?? "")) throw new Error(`invalid host registration ${host.name}`);
    db.prepare("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES (?, ?, ?, ?)").run(host.hostId, host.name, host.tokenSha256, host.createdAtMs ?? now);
    restored.hosts.push({ hostId: host.hostId, name: host.name });
  }
  for (const service of registrations.services) {
    if (!NAME.test(service.name) || !Array.isArray(service.hostIds) || service.hostIds.some(id => !HOST_ID.test(id))) throw new Error(`invalid service registration ${service.name}`);
    for (const key of ["deployTokenSha256", "ingestTokenSha256"]) if (service[key] !== undefined && !VERIFIER.test(service[key])) throw new Error(`invalid ${key} for ${service.name}`);
    const deploy = service.deployTokenSha256 ?? null;
    const ingest = service.ingestTokenSha256 ?? null;
    if (deploy === null) restored.unusableTokens.push(`${service.name}:deploy`);
    if (ingest === null) restored.unusableTokens.push(`${service.name}:ingest`);
    db.prepare("INSERT INTO services (name, token_hash, ingest_token_hash, host_ids, health_url, unit, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run(service.name, deploy ?? unusable(), ingest, JSON.stringify(service.hostIds), service.healthUrl ?? null, service.unit ?? null, service.createdAtMs ?? now);
    restored.services.push(service.name);
  }
  return restored;
}

function main() {
  const [dataDir, input, reason] = process.argv.slice(2);
  if (!dataDir || !input || !reason) { console.error(usage); return 2; }
  const registrations = JSON.parse(readFileSync(input, "utf8"));
  const db = new DatabaseSync(join(dataDir, "stats.sqlite"));
  const now = Date.now();
  let restored;
  try {
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE");
    } catch {
      console.error("restore-registrations: the database is in use; stop the server first");
      return 2;
    }
    try {
      restored = restore(db, registrations, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      console.error(`restore-registrations: ${error.message}`);
      return 1;
    }
  } finally {
    db.close();
  }
  const marker = { schemaVersion: 1, kind: "installation-reset", at: new Date(now).toISOString(), reason, ...restored };
  const path = join(dataDir, "RESET.json");
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fsyncPath(path);
  fsyncPath(dataDir);
  console.log(JSON.stringify(marker));
  return 0;
}

process.exitCode = main();
