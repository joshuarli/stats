import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const usage = "usage: restore-registrations.mjs DATA_DIR REGISTRATIONS.json REASON";
const [dataDir, input, reason] = process.argv.slice(2);
if (!dataDir || !input || !reason) { console.error(usage); process.exit(2); }
const HOST_ID = /^h_[0-9a-f]{32}$/u;
const NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const verifier = token => createHash("sha256").update(token).digest("hex");
const unusable = () => verifier(randomBytes(32).toString("hex"));
const registrations = JSON.parse(readFileSync(input, "utf8"));

const db = new DatabaseSync(join(dataDir, "stats.sqlite"));
try {
  db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE");
} catch (error) {
  console.error("restore-registrations: the database is in use; stop the server first");
  process.exit(2);
}
const now = Date.now();
const restored = { hosts: [], services: [], unusableTokens: [] };
try {
  for (const table of ["hosts", "services"]) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) === undefined) throw new Error(`table ${table} is missing; start the server once to create the schema`);
  if (db.prepare("SELECT count(*) AS n FROM hosts").get().n !== 0 || db.prepare("SELECT count(*) AS n FROM services").get().n !== 0) throw new Error("the installation already has registrations");
  for (const host of registrations.hosts) {
    if (!HOST_ID.test(host.hostId) || !NAME.test(host.name) || typeof host.token !== "string" || host.token.length < 16) throw new Error(`invalid host registration ${host.name}`);
    db.prepare("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES (?, ?, ?, ?)").run(host.hostId, host.name, verifier(host.token), host.createdAtMs ?? now);
    restored.hosts.push({ hostId: host.hostId, name: host.name });
  }
  for (const service of registrations.services) {
    if (!NAME.test(service.name) || !Array.isArray(service.hostIds) || service.hostIds.some(id => !HOST_ID.test(id))) throw new Error(`invalid service registration ${service.name}`);
    const deploy = typeof service.deployToken === "string" && service.deployToken.length >= 16 ? verifier(service.deployToken) : null;
    const ingest = typeof service.ingestToken === "string" && service.ingestToken.length >= 16 ? verifier(service.ingestToken) : null;
    if (deploy === null) restored.unusableTokens.push(`${service.name}:deploy`);
    if (ingest === null) restored.unusableTokens.push(`${service.name}:ingest`);
    db.prepare("INSERT INTO services (name, token_hash, ingest_token_hash, host_ids, health_url, unit, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run(service.name, deploy ?? unusable(), ingest, JSON.stringify(service.hostIds), service.healthUrl ?? null, service.unit ?? null, service.createdAtMs ?? now);
    restored.services.push(service.name);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  console.error(`restore-registrations: ${error.message}`);
  process.exit(1);
} finally {
  db.close();
}
const marker = { schemaVersion: 1, kind: "installation-reset", at: new Date(now).toISOString(), reason, hosts: restored.hosts, services: restored.services, unusableTokens: restored.unusableTokens };
const path = join(dataDir, "RESET.json");
writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
const fd = openSync(path, "r");
try { fsyncSync(fd); } finally { closeSync(fd); }
console.log(JSON.stringify(marker));
