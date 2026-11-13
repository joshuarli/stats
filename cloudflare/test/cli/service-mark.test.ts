import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { decodeServiceDeploymentHistory, decodeServiceMarker } from "../../src/deployments/service-decode.ts";
import { defaultMarkerId } from "../../src/cli/commands/services.ts";
import { identityProxy, startNode } from "./node-server.ts";
import { fakeOrigin, runCli, sendJson, type Handler } from "./support.ts";

const SCRATCH_ROOT = resolve(import.meta.dirname, "../../../.work/tmp");
const HOST_A = `h_${"a".repeat(32)}`;
const HOST_B = `h_${"b".repeat(32)}`;
const SECRET = "nst_service-token-4f9c2e7a";
const INGEST_SECRET = "nst_ingest-token-8d1b5c3e";

mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = mkdtempSync(join(SCRATCH_ROOT, "service-mark-"));

function tokenFile(name: string, contents: object, mode = 0o600): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(contents));
  chmodSync(path, mode);
  return path;
}

const good = () => tokenFile("good.json", { name: "web", hostIds: [HOST_A, HOST_B], healthUrl: null, unit: null, createdAtMs: 1, deployToken: SECRET, ingestToken: INGEST_SECRET });

const markerReply = (service: string, markerId: string, version: string, hostIds: string[]) => ({
  service, markerId, hostIds,
  deployment: { id: "11111111-1111-4111-8111-111111111111", atMs: 1_700_000_000_000, source: "marker", message: null, versions: [{ id: version, percentage: 100 }], deferred: false }
});

interface Document {
  readonly payload?: { readonly created: boolean; readonly marker: { readonly markerId: string; readonly hostIds: string[] } };
  readonly error?: { readonly code: string };
}

const SECRETS = [SECRET, INGEST_SECRET];

function leaked(run: { stdout: string; stderr: string }): boolean {
  return SECRETS.some(secret => run.stdout.includes(secret) || run.stderr.includes(secret));
}

await test("deploy mark against a fake origin", async t => {
  const credentialRan = join(scratch, "cf-ran");
  const env = { STATSCTL_AUTH_COMMAND: `touch ${credentialRan}; printf access-secret` };
  let status = 201;
  let bodies: unknown[] = [];
  const handler: Handler = (request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text) as { markerId: string; version: string; hostIds: string[] };
      bodies.push(body);
      if (status === 201 || status === 200) return sendJson(response, markerReply("web", body.markerId, body.version, body.hostIds), status);
      if (status === 302) { response.writeHead(302, { location: "https://team.cloudflareaccess.com/login" }); return response.end(); }
      return sendJson(response, { error: { code: "x", message: "refused by the service" } }, status);
    });
  };
  const origin = await fakeOrigin(handler);
  const mark = (args: string[], file = good()) => runCli(["deploy", "mark", "--service", "web", "--version", "9df651c", "--token-file", file, "--origin", origin.origin, "--json", ...args], env);
  try {
    await t.test("posts the service's hosts and a deterministic marker id, with only the bearer token", async () => {
      status = 201;
      const run = await mark([]);
      assert.equal(run.code, 0, run.stdout + run.stderr);
      const document = JSON.parse(run.stdout) as Document;
      assert.equal(document.payload?.created, true);
      assert.deepEqual(bodies[0], { markerId: "v-9df651c", version: "9df651c", hostIds: [HOST_A, HOST_B] });
      const seen = origin.seen[0]!;
      assert.equal(seen.method, "POST");
      assert.equal(seen.url, "/ingest/services/web/deployments");
      assert.equal(seen.headers["authorization"], `Bearer ${SECRET}`);
      assert.equal(seen.headers["cf-access-token"], undefined);
      assert.ok(!existsSync(credentialRan), "the Access credential command ran");
      assert.ok(!leaked(run));
    });

    await t.test("an explicit host list, marker id, and message replace the defaults", async () => {
      status = 200;
      bodies = [];
      const run = await mark(["--host", `${HOST_B},${HOST_A}`, "--marker-id", "build-7", "--message", "hotfix"]);
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.equal((JSON.parse(run.stdout) as Document).payload?.created, false);
      assert.deepEqual(bodies[0], { markerId: "build-7", version: "9df651c", message: "hotfix", hostIds: [HOST_A, HOST_B] });
      const text = await runCli(["deploy", "mark", "--service", "web", "--version", "9df651c", "--token-file", good(), "--origin", origin.origin], env);
      assert.equal(text.code, 0, text.stdout + text.stderr);
      assert.match(text.stdout, /already recorded web 9df651c/u);
    });

    await t.test("a conflicting repeat exits 2 with marker_conflict", async () => {
      status = 409;
      const run = await mark([]);
      assert.equal(run.code, 2, run.stdout + run.stderr);
      assert.equal((JSON.parse(run.stdout) as Document).error?.code, "marker_conflict");
    });

    await t.test("a refused token exits 3 and is not printed", async () => {
      status = 401;
      const run = await mark([]);
      assert.equal(run.code, 3, run.stdout + run.stderr);
      assert.equal((JSON.parse(run.stdout) as Document).error?.code, "marker_unauthorized");
      assert.ok(!leaked(run));
    });

    await t.test("an Access redirect exits 3 and says the path needs a bypass", async () => {
      status = 302;
      const run = await mark([]);
      assert.equal(run.code, 3, run.stdout + run.stderr);
      assert.equal((JSON.parse(run.stdout) as Document).error?.code, "access_challenge");
      assert.match(run.stderr, /Bypass/u);
    });

    await t.test("a server error exits 4", async () => {
      status = 500;
      const run = await mark([]);
      assert.equal(run.code, 4, run.stdout + run.stderr);
    });

    await t.test("a token file problem exits 3 before any request", async () => {
      const before = origin.seen.length;
      const loose = await mark([], tokenFile("loose.json", { name: "web", deployToken: SECRET }, 0o644));
      assert.equal(loose.code, 3);
      assert.equal((JSON.parse(loose.stdout) as Document).error?.code, "credential_file_mode");
      const other = await mark([], tokenFile("other.json", { name: "api", hostIds: [HOST_A], deployToken: SECRET }));
      assert.equal(other.code, 3);
      assert.equal((JSON.parse(other.stdout) as Document).error?.code, "credential_file_service");
      const missing = await mark([], join(scratch, "missing.json"));
      assert.equal(missing.code, 3);
      assert.equal((JSON.parse(missing.stdout) as Document).error?.code, "credential_file_unreadable");
      for (const run of [loose, other, missing]) assert.ok(!leaked(run));
      assert.equal(origin.seen.length, before);
    });

    await t.test("a token file carries only the deploy credential, never the ingest credential or the old field", async () => {
      const before = origin.seen.length;
      const ingestOnly = await mark([], tokenFile("ingest-only.json", { name: "web", hostIds: [HOST_A], ingestToken: INGEST_SECRET }));
      assert.equal(ingestOnly.code, 3);
      assert.equal((JSON.parse(ingestOnly.stdout) as Document).error?.code, "credential_file_invalid");
      const legacy = await mark([], tokenFile("legacy.json", { name: "web", hostIds: [HOST_A], token: SECRET }));
      assert.equal(legacy.code, 3);
      assert.equal((JSON.parse(legacy.stdout) as Document).error?.code, "credential_file_invalid");
      for (const run of [ingestOnly, legacy]) assert.ok(!leaked(run));
      assert.equal(origin.seen.length, before);
    });

    await t.test("a token file without hostIds needs --host", async () => {
      const run = await mark([], tokenFile("nohosts.json", { name: "web", deployToken: SECRET }));
      assert.equal(run.code, 2, run.stdout + run.stderr);
      assert.ok(!leaked(run));
    });
  } finally {
    await origin.close();
  }
});

await test("the default marker id keeps a retried deploy idempotent and refuses versions it cannot represent", () => {
  assert.equal(defaultMarkerId("v1.2.3"), "v-v1.2.3");
  assert.throws(() => defaultMarkerId("1.0.0+build"), /--marker-id/u);
  assert.throws(() => defaultMarkerId("a".repeat(127)), /--marker-id/u);
});

await test("the service history decoder accepts commit and tag versions and rejects bad ones", () => {
  const deployment = (version: string) => markerReply("web", "m1", version, [HOST_A]).deployment;
  const history = (versions: string[]) => ({
    projectId: "web", worker: "web", enabled: true, sync: null, versions: [],
    deployments: versions.map((version, index) => ({ ...deployment(version), id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}` })),
    markers: versions.map((_, index) => ({ deploymentId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, markerId: `m${index}`, hostIds: [HOST_A] }))
  });
  const decoded = decodeServiceDeploymentHistory(history(["9df651c1a2b3", "v1.2.3-rc.1+x"]), "web");
  assert.deepEqual(decoded.deployments.map(item => item.versions[0]?.id), ["9df651c1a2b3", "v1.2.3-rc.1+x"]);
  assert.throws(() => decodeServiceDeploymentHistory(history(["has space"]), "web"));
  assert.throws(() => decodeServiceDeploymentHistory(history(["-lead"]), "web"));
  assert.throws(() => decodeServiceDeploymentHistory(history(["ok"]), "other"));
  assert.throws(() => decodeServiceMarker({ ...markerReply("web", "m1", "ok", [HOST_A]), service: "other" }, "web"));
  const missingMarker = { ...history(["ok"]), markers: [] };
  assert.throws(() => decodeServiceDeploymentHistory(missingMarker, "web"));
});

await test("deploy mark records and repeats a marker on a real Node server, and service deployments lists it", async () => {
  const dataDir = mkdtempSync(join(scratch, "node-"));
  const node = await startNode(dataDir);
  const proxy = await identityProxy(node.port, []);
  try {
    const origin = `http://localhost:${(proxy.address() as AddressInfo).port}`;
    const host = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "web-1" }) });
    assert.equal(host.status, 201);
    const { hostId } = await host.json() as { hostId: string };
    const created = await fetch(`${origin}/api/v1/admin/services`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "web", hostIds: [hostId] }) });
    assert.equal(created.status, 201);
    const file = tokenFile("node-service.json", await created.json() as object);
    const marker = ["deploy", "mark", "--service", "web", "--version", "9df651c1a2b3", "--message", "first", "--token-file", file, "--origin", origin, "--json"];
    const env = { STATSCTL_AUTH_COMMAND: `touch ${join(dataDir, "cf-ran")}` };
    const first = await runCli(marker, env);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal((JSON.parse(first.stdout) as Document).payload?.created, true);
    const again = await runCli(marker, env);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.equal((JSON.parse(again.stdout) as Document).payload?.created, false);
    const conflict = await runCli(marker.map(word => word === "first" ? "second" : word), env);
    assert.equal(conflict.code, 2, conflict.stdout + conflict.stderr);
    assert.ok(!existsSync(join(dataDir, "cf-ran")));

    const activation = String(Date.now() - 60_000);
    const timed = [...marker, "--at-ms", activation, "--marker-id", "act-1"];
    const recorded = await runCli(timed, env);
    assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);
    assert.equal((JSON.parse(recorded.stdout) as Document).payload?.created, true);
    const retried = await runCli(timed, env);
    assert.equal(retried.code, 0, retried.stdout + retried.stderr);
    const retriedMarker = JSON.parse(retried.stdout) as { payload: { created: boolean; marker: { deployment: { atMs: number } } } };
    assert.equal(retriedMarker.payload?.created, false);
    assert.equal(retriedMarker.payload?.marker.deployment.atMs, Number(activation));
    const shifted = await runCli([...marker, "--at-ms", String(Number(activation) + 1_000), "--marker-id", "act-1"], env);
    assert.equal(shifted.code, 2, shifted.stdout + shifted.stderr);
    const future = await runCli([...marker, "--at-ms", String(Date.now() + 10 * 60_000), "--marker-id", "act-2"], env);
    assert.equal(future.code, 2, future.stdout + future.stderr);
    assert.equal((JSON.parse(future.stdout) as Document).error?.code, "usage");

    const listed = await runCli(["service", "deployments", "--service", "web", "--origin", origin, "--json"], env);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    const history = JSON.parse(listed.stdout) as { payload: { deployments: { deployment: { versions: { id: string }[]; message: string }; markerId: string; hostIds: string[] }[] } };
    assert.equal(history.payload.deployments.length, 2);
    assert.equal(history.payload.deployments[0]?.deployment.versions[0]?.id, "9df651c1a2b3");
    assert.equal(history.payload.deployments[0]?.deployment.message, "first");
    assert.equal(history.payload.deployments[0]?.markerId, "v-9df651c1a2b3");
    assert.deepEqual(history.payload.deployments[0]?.hostIds, [hostId]);

    const services = await runCli(["services", "--origin", origin, "--json"], env);
    assert.equal(services.code, 0, services.stdout + services.stderr);
    assert.deepEqual((JSON.parse(services.stdout) as { payload: { services: { name: string }[] } }).payload.services.map(item => item.name), ["web"]);
    const credentials = JSON.parse(readFileSync(file, "utf8")) as { deployToken: string; ingestToken: string };
    for (const run of [first, again, conflict, listed, services]) {
      for (const token of [credentials.deployToken, credentials.ingestToken]) assert.ok(!run.stdout.includes(token) && !run.stderr.includes(token));
    }
  } finally {
    proxy.close();
    node.child.kill("SIGTERM");
    await new Promise(resolveExit => node.child.once("exit", resolveExit));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

rmSync(scratch, { recursive: true, force: true });
