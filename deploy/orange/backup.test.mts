import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { main } from "../../cloudflare/src/cli/run.ts";
import { decodeAck } from "../../cloudflare/src/ingest/ack-decode.ts";
import { INGEST_MEDIA_TYPE, INGEST_PATH } from "../../cloudflare/src/ingest/http.ts";
import { startGateway, type LocalGateway } from "../../cloudflare/local/gateway.ts";
import { fixtureBytes, fixtureSource, manifest, NOW_MS, withHost } from "../../cloudflare/test/node/support.ts";
import { generate } from "./generate.mts";
import { freePort, startSession, type Session } from "./session.mts";

const SCRATCH = resolve(import.meta.dirname, "../../.work/tmp");

interface Deployment {
  readonly session: Session;
  readonly gateway: LocalGateway;
  stop(): Promise<void>;
}

async function deploy(stateDir: string): Promise<Deployment> {
  const secret = randomBytes(32).toString("hex");
  generate(stateDir, { kind: "dev", release: "backup", gatewaySecret: secret, nowMs: String(NOW_MS) });
  const session = await startSession(stateDir, await freePort());
  const gateway = await startGateway(session.origin, secret);
  return { session, gateway, stop: async () => { await gateway.close(); await session.stop(); } };
}

async function statsctl(origin: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main([...args, "--origin", origin, "--json"], { env: { PATH: process.env["PATH"] ?? "" }, io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, isTty: false } });
  return { code, stdout, stderr };
}

async function json<T>(response: Response): Promise<T> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<T>;
}

await test("a fenced backup restores into a fresh OpenOrange namespace with identical state, and import resumes", async () => {
  const root = join(SCRATCH, `orange-backup-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const backup = join(root, "backup");
  const batch = manifest.batches.find(entry => entry.name === "linux-normal")!;
  const seqs = fixtureSource(batch.source).samples.map(sample => BigInt(String((sample as { seq: unknown }).seq)));
  let source: Deployment | undefined;
  let target: Deployment | undefined;
  try {
    source = await deploy(join(root, "source"));
    const origin = source.gateway.origin;
    const created = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "backup-host" }) });
    assert.equal(created.status, 201);
    const host = await created.json() as { hostId: string; token: string };
    const frame = withHost(fixtureBytes(batch.frame), host.hostId);
    const ingest = (base: string) => fetch(`${base}${INGEST_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frame });
    assert.equal(decodeAck(new Uint8Array(await (await ingest(origin)).arrayBuffer()), seqs).accepted, seqs.length);
    const service = await fetch(`${origin}/api/v1/admin/services`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "backup-svc", hostIds: [host.hostId] }) });
    assert.equal(service.status, 201);

    const unfenced = await statsctl(origin, ["backup", "export", "--out", backup]);
    assert.equal(unfenced.code, 4, "export refuses unfenced objects");
    assert.match(unfenced.stderr, /409/u);
    rmSync(`${backup}.partial`, { recursive: true, force: true });
    assert.equal((await statsctl(origin, ["backup", "fence", "--state", "fenced"])).code, 0);
    const fencedIngest = await ingest(origin);
    assert.equal(fencedIngest.status, 503);
    assert.equal(fencedIngest.headers.get("retry-after"), "60");
    const exported = await statsctl(origin, ["backup", "export", "--out", backup]);
    assert.equal(exported.code, 0, exported.stderr);
    const historyPath = `/api/v1/hosts/${host.hostId}/history?range=24h&kind=summary`;
    const sourceHistory = new Uint8Array(await (await fetch(`${origin}${historyPath}`, { headers: { "accept-encoding": "identity" } })).arrayBuffer());
    const sourceHosts = await json<unknown>(await fetch(`${origin}/api/v1/hosts`));
    const sourceServices = await json<{ services: { name: string }[] }>(await fetch(`${origin}/api/v1/services`));
    assert.equal((await statsctl(origin, ["backup", "fence", "--state", "open"])).code, 0);
    assert.equal((await ingest(origin)).status, 200);
    await source.stop();
    source = undefined;
    assert.ok(!readFileSync(join(backup, "installation", "hosts.ndjson"), "utf8").includes(host.token), "the backup holds the token itself");

    target = await deploy(join(root, "target"));
    const restored = target.gateway.origin;
    const installationManifest = JSON.parse(readFileSync(join(backup, "installation", "manifest.json"), "utf8")) as { tables: { name: string }[] };
    const begun = await fetch(`${restored}/api/v1/admin/objects/installation/import/begin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(installationManifest) });
    assert.equal(begun.status, 200);
    const firstLine = readFileSync(join(backup, "installation", "hosts.ndjson"), "utf8").split("\n")[0]!;
    assert.equal((await fetch(`${restored}/api/v1/admin/objects/installation/import/rows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ table: "hosts", offset: 0, rows: [JSON.parse(firstLine)] }) })).status, 200);
    assert.equal((await fetch(`${restored}/api/v1/hosts`)).status, 503, "an importing object refuses reads");

    const tampered = join(root, "tampered");
    rmSync(tampered, { recursive: true, force: true });
    mkdirSync(tampered);
    for (const entry of ["index.json"]) writeFileSync(join(tampered, entry), readFileSync(join(backup, entry)));
    assert.equal((await statsctl(restored, ["backup", "import", "--in", tampered])).code, 2, "an incomplete backup is refused before any write");

    const imported = await statsctl(restored, ["backup", "import", "--in", backup]);
    assert.equal(imported.code, 0, imported.stderr);
    assert.deepEqual(new Uint8Array(await (await fetch(`${restored}${historyPath}`, { headers: { "accept-encoding": "identity" } })).arrayBuffer()), sourceHistory);
    assert.deepEqual(await json<unknown>(await fetch(`${restored}/api/v1/hosts`)), sourceHosts);
    assert.deepEqual((await json<{ services: { name: string }[] }>(await fetch(`${restored}/api/v1/services`))).services.map(entry => entry.name), sourceServices.services.map(entry => entry.name));
    const replay = await ingest(restored);
    assert.equal(replay.status, 200, "the restored verifier still authenticates the host token");
    assert.equal(decodeAck(new Uint8Array(await replay.arrayBuffer()), seqs).duplicates, seqs.length);
    const again = await statsctl(restored, ["backup", "import", "--in", backup]);
    assert.notEqual(again.code, 0, "a second import into a populated object is refused");
    assert.match(again.stderr, /409/u);
  } finally {
    await source?.stop();
    await target?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
