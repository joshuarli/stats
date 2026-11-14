import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fakeOrigin, runCli, sendJson, type Handler } from "./support.ts";

const SCRATCH_ROOT = resolve(import.meta.dirname, "../../../.work/tmp");
const HOST_A = `h_${"a".repeat(32)}`;
const HOST_B = `h_${"b".repeat(32)}`;
const OLD_DEPLOY = `nft_${"D".repeat(43)}`;
const OLD_INGEST = `nft_${"I".repeat(43)}`;
const NEW_DEPLOY = `nft_${"E".repeat(43)}`;
const NEW_INGEST = `nft_${"J".repeat(43)}`;
const SECRETS = [OLD_DEPLOY, OLD_INGEST, NEW_DEPLOY, NEW_INGEST];

mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = mkdtempSync(join(SCRATCH_ROOT, "service-admin-"));

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

function captured(handle: (request: IncomingMessage, response: ServerResponse, body: string, seen: Seen[]) => void): { readonly handler: Handler; readonly seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    handler: (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
        handle(request, response, body, seen);
      });
    }
  };
}

function credential(path: string, fields: object): string {
  writeFileSync(path, JSON.stringify(fields));
  chmodSync(path, 0o600);
  return path;
}

function leaked(run: { stdout: string; stderr: string }): boolean {
  return SECRETS.some(secret => run.stdout.includes(secret) || run.stderr.includes(secret));
}

const service = {
  name: "web",
  hostIds: [HOST_A, HOST_B],
  healthUrl: "https://web.example.com/health",
  unit: "web.service",
  createdAtMs: 1_700_000_000_000
};

const deployment = {
  id: "11111111-1111-4111-8111-111111111111",
  atMs: 1_700_000_100_000,
  source: "marker",
  message: "release",
  versions: [{ id: "1.2.3", percentage: 100 }],
  deferred: false
};

const history = {
  projectId: "web",
  worker: "web",
  enabled: true,
  sync: null,
  versions: [],
  deployments: [deployment],
  markers: [{ deploymentId: deployment.id, markerId: "v-1.2.3", hostIds: [HOST_A] }]
};

await test("service create writes both credentials to a new owner-only file and prints neither", async () => {
  const { handler, seen } = captured((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/v1/admin/services") {
      sendJson(response, { error: { code: "not_found", message: "unexpected" } }, 404);
      return;
    }
    assert.equal(request.headers["cf-access-token"], undefined);
    sendJson(response, { ...service, hostIds: [HOST_A, HOST_B], deployToken: OLD_DEPLOY, ingestToken: OLD_INGEST }, 201);
  });
  const origin = await fakeOrigin(handler);
  try {
    const jsonFile = join(scratch, "create-json.json");
    const run = await runCli(["service", "create", "--name", "web", "--host", `${HOST_B},${HOST_A}`, "--health-url", service.healthUrl, "--unit", service.unit, "--credential-file", jsonFile, "--origin", origin.origin, "--json"], {});
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.ok(!leaked(run), "a token reached stdout or stderr");
    const request = seen.find(item => item.method === "POST");
    assert.ok(request !== undefined);
    assert.equal(request.url, "/api/v1/admin/services");
    assert.equal(request.headers["cf-access-token"], undefined);
    assert.deepEqual(JSON.parse(request.body), { name: "web", hostIds: [HOST_A, HOST_B], healthUrl: service.healthUrl, unit: service.unit });

    const fields = JSON.parse(readFileSync(jsonFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(fields, { ...service, hostIds: [HOST_A, HOST_B], deployToken: OLD_DEPLOY, ingestToken: OLD_INGEST });
    assert.equal(statSync(jsonFile).mode & 0o777, 0o600);
    const document = JSON.parse(run.stdout) as { payload: Record<string, unknown> };
    assert.equal(document.payload["credentialFile"], jsonFile);
    assert.equal(JSON.stringify(document).includes(OLD_DEPLOY), false);
    assert.equal(JSON.stringify(document).includes(OLD_INGEST), false);

    const textFile = join(scratch, "create-text.json");
    const text = await runCli(["service", "create", "--name", "web", "--host", HOST_A, "--credential-file", textFile, "--origin", origin.origin], {});
    assert.equal(text.code, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /credentials written/u);
    assert.ok(!leaked(text), "a token reached text output");
    assert.equal(statSync(textFile).mode & 0o777, 0o600);
  } finally {
    await origin.close();
  }
});

await test("service create refuses an existing file and a symbolic link before any request", async () => {
  let requests = 0;
  const origin = await fakeOrigin((request, response) => {
    requests += 1;
    sendJson(response, { error: { code: "conflict", message: "a service with this name exists" } }, 409);
  });
  try {
    const existing = credential(join(scratch, "existing.json"), { name: "web", deployToken: OLD_DEPLOY });
    const refused = await runCli(["service", "create", "--name", "web", "--host", HOST_A, "--credential-file", existing, "--origin", origin.origin, "--json"], {});
    assert.equal(refused.code, 3, refused.stdout + refused.stderr);
    assert.equal((JSON.parse(refused.stdout) as { error: { code: string } }).error.code, "credential_file_exists");

    const target = credential(join(scratch, "symlink-target.json"), { name: "web" });
    const link = join(scratch, "symlink.json");
    symlinkSync(target, link);
    const linked = await runCli(["service", "create", "--name", "web", "--host", HOST_A, "--credential-file", link, "--origin", origin.origin, "--json"], {});
    assert.equal(linked.code, 3, linked.stdout + linked.stderr);
    assert.equal((JSON.parse(linked.stdout) as { error: { code: string } }).error.code, "credential_file_invalid");
    assert.equal(requests, 0);

    const conflict = await runCli(["service", "create", "--name", "web", "--host", HOST_A, "--credential-file", join(scratch, "conflict.json"), "--origin", origin.origin, "--json"], {});
    assert.equal(conflict.code, 2, conflict.stdout + conflict.stderr);
    assert.equal((JSON.parse(conflict.stdout) as { error: { code: string } }).error.code, "conflict");
    assert.equal(requests, 1);
  } finally {
    await origin.close();
  }
});

await test("service inspect reads the service and its newest marker", async () => {
  const { handler, seen } = captured((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/services/web") return sendJson(response, service);
    if (request.method === "GET" && request.url === "/api/v1/services/web/deployments") return sendJson(response, history);
    sendJson(response, { error: { code: "not_found", message: "missing" } }, 404);
  });
  const origin = await fakeOrigin(handler);
  try {
    const run = await runCli(["service", "inspect", "--service", "web", "--origin", origin.origin, "--json"], {});
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const payload = (JSON.parse(run.stdout) as { payload: { service: unknown; latest: Record<string, unknown>; markers: number } }).payload;
    assert.deepEqual(payload.service, service);
    assert.deepEqual(payload.latest, { markerId: "v-1.2.3", deploymentId: deployment.id, version: "1.2.3", atMs: deployment.atMs, message: "release", hostIds: [HOST_A] });
    assert.equal(payload.markers, 1);
    assert.deepEqual(seen.map(item => item.url).sort(), ["/api/v1/services/web", "/api/v1/services/web/deployments"]);
    assert.ok(seen.every(item => item.headers["cf-access-token"] === undefined));

    const text = await runCli(["service", "inspect", "--service", "web", "--origin", origin.origin], {});
    assert.equal(text.code, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /latest marker: 1\.2\.3 \(v-1\.2\.3\)/u);

    const invalid = await runCli(["service", "inspect", "--service", "Bad", "--origin", origin.origin], {});
    assert.equal(invalid.code, 2, invalid.stdout + invalid.stderr);
  } finally {
    await origin.close();
  }
});

await test("service token rotate replaces one token in the file and preserves the other", async () => {
  const { handler, seen } = captured((request, response, body) => {
    assert.deepEqual(JSON.parse(body), {});
    if (request.method === "POST" && request.url === "/api/v1/admin/services/web/rotate") return sendJson(response, { name: "web", deployToken: NEW_DEPLOY });
    if (request.method === "POST" && request.url === "/api/v1/admin/services/web/token/rotate") return sendJson(response, { name: "web", ingestToken: NEW_INGEST });
    sendJson(response, { error: { code: "not_found", message: "missing" } }, 404);
  });
  const origin = await fakeOrigin(handler);
  try {
    const file = credential(join(scratch, "rotate.json"), { ...service, deployToken: OLD_DEPLOY, ingestToken: OLD_INGEST });
    const deploy = await runCli(["service", "token", "rotate", "--service", "web", "--kind", "deploy", "--credential-file", file, "--origin", origin.origin, "--json"], {});
    assert.equal(deploy.code, 0, deploy.stdout + deploy.stderr);
    assert.ok(!leaked(deploy));
    let fields = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(fields["deployToken"], NEW_DEPLOY);
    assert.equal(fields["ingestToken"], OLD_INGEST);
    assert.equal(fields["name"], "web");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(JSON.parse(deploy.stdout)).includes(NEW_DEPLOY), false);

    const ingest = await runCli(["service", "token", "rotate", "--service", "web", "--kind", "ingest", "--credential-file", file, "--origin", origin.origin, "--json"], {});
    assert.equal(ingest.code, 0, ingest.stdout + ingest.stderr);
    assert.ok(!leaked(ingest));
    fields = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(fields["deployToken"], NEW_DEPLOY);
    assert.equal(fields["ingestToken"], NEW_INGEST);
    assert.deepEqual(seen.map(item => item.url), ["/api/v1/admin/services/web/rotate", "/api/v1/admin/services/web/token/rotate"]);
    assert.ok(seen.every(item => item.headers["cf-access-token"] === undefined));

    const badKind = await runCli(["service", "token", "rotate", "--service", "web", "--kind", "both", "--credential-file", file, "--origin", origin.origin], {});
    assert.equal(badKind.code, 2, badKind.stdout + badKind.stderr);
    const wrongService = await runCli(["service", "token", "rotate", "--service", "api", "--credential-file", file, "--origin", origin.origin], {});
    assert.equal(wrongService.code, 3, wrongService.stdout + wrongService.stderr);
    assert.equal(seen.length, 2);
    assert.ok(!leaked(badKind) && !leaked(wrongService));
  } finally {
    await origin.close();
  }
});

await test("service token rotate creates a missing file from the service configuration", async () => {
  const { handler, seen } = captured((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/services/web") return sendJson(response, service);
    if (request.method === "POST" && request.url === "/api/v1/admin/services/web/rotate") return sendJson(response, { name: "web", deployToken: NEW_DEPLOY });
    sendJson(response, { error: { code: "not_found", message: "missing" } }, 404);
  });
  const origin = await fakeOrigin(handler);
  try {
    const file = join(scratch, "recovered.json");
    const run = await runCli(["service", "token", "rotate", "--service", "web", "--kind", "deploy", "--credential-file", file, "--origin", origin.origin, "--json"], {});
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.ok(!leaked(run));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...service, deployToken: NEW_DEPLOY });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(seen.map(item => item.url), ["/api/v1/services/web", "/api/v1/admin/services/web/rotate"]);
  } finally {
    await origin.close();
  }
});

await test("service token revoke deletes the service and never prints a credential", async () => {
  const { handler, seen } = captured((request, response) => {
    if (request.method === "DELETE" && request.url === "/api/v1/admin/services/web") {
      response.writeHead(204);
      response.end();
      return;
    }
    sendJson(response, { error: { code: "not_found", message: "service not found" } }, 404);
  });
  const origin = await fakeOrigin(handler);
  try {
    const file = credential(join(scratch, "revoke.json"), { ...service, deployToken: OLD_DEPLOY, ingestToken: OLD_INGEST });
    const run = await runCli(["service", "token", "revoke", "--service", "web", "--credential-file", file, "--origin", origin.origin, "--json"], {});
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.ok(!leaked(run));
    assert.equal(seen[0]?.method, "DELETE");
    assert.equal(seen[0]?.headers["cf-access-token"], undefined);
    assert.equal((JSON.parse(run.stdout) as { warnings: { code: string }[] }).warnings[0]?.code, "credential_file_stale");

    const text = await runCli(["service", "token", "revoke", "--service", "web", "--origin", origin.origin], {});
    assert.equal(text.code, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /revoked web/u);

    const wrong = await runCli(["service", "token", "revoke", "--service", "api", "--credential-file", file, "--origin", origin.origin, "--json"], {});
    assert.equal(wrong.code, 3, wrong.stdout + wrong.stderr);
    assert.equal((JSON.parse(wrong.stdout) as { error: { code: string } }).error.code, "credential_file_service");
    assert.equal(seen.length, 2);

    const missing = await runCli(["service", "token", "revoke", "--service", "absent", "--origin", origin.origin, "--json"], {});
    assert.equal(missing.code, 4, missing.stdout + missing.stderr);
    assert.equal((JSON.parse(missing.stdout) as { error: { code: string } }).error.code, "not_found");
  } finally {
    await origin.close();
  }
});

rmSync(scratch, { recursive: true, force: true });
