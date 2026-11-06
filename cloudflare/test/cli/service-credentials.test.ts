import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LOGIN, startNode } from "./node-server.ts";

const SCRATCH_ROOT = resolve(import.meta.dirname, "../../../.work/tmp");
const TOKEN = /^nft_[A-Za-z0-9_-]{43}$/u;

mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = mkdtempSync(join(SCRATCH_ROOT, "service-credentials-"));

interface CreatedService {
  readonly name: string;
  readonly deployToken: string;
  readonly ingestToken: string;
}

await test("service credentials are distinct, rotate independently, and are refused after deletion", async () => {
  const dataDir = mkdtempSync(join(scratch, "node-"));
  const node = await startNode(dataDir);
  const origin = `http://127.0.0.1:${node.port}`;
  const admin = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${origin}${path}`, {
    ...init,
    headers: { "tailscale-user-login": LOGIN, ...(init.headers as Record<string, string> | undefined) }
  });
  const marker = (markerId: string, credential: string, hostId: string): Promise<Response> => fetch(`${origin}/ingest/services/web/deployments`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ markerId, version: "1.0.0", hostIds: [hostId] })
  });
  try {
    const host = await admin("/api/v1/admin/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "web-1" }) });
    assert.equal(host.status, 201);
    const { hostId } = await host.json() as { hostId: string };

    const created = await admin("/api/v1/admin/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "web", hostIds: [hostId] }) });
    assert.equal(created.status, 201);
    const credentials = await created.json() as CreatedService;
    assert.match(credentials.deployToken, TOKEN);
    assert.match(credentials.ingestToken, TOKEN);
    assert.notEqual(credentials.deployToken, credentials.ingestToken);

    for (const path of ["/api/v1/services", "/api/v1/services/web"]) {
      const text = await (await admin(path)).text();
      assert.equal(text.includes(credentials.deployToken), false, path);
      assert.equal(text.includes(credentials.ingestToken), false, path);
    }

    assert.equal((await marker("first", credentials.deployToken, hostId)).status, 201);
    assert.equal((await marker("ingest-cannot-mark", credentials.ingestToken, hostId)).status, 401);

    const deployRotated = await admin("/api/v1/admin/services/web/rotate", { method: "POST" });
    assert.equal(deployRotated.status, 200);
    const deployBody = await deployRotated.json() as { name: string; deployToken: string };
    assert.equal(deployBody.name, "web");
    assert.match(deployBody.deployToken, TOKEN);
    assert.notEqual(deployBody.deployToken, credentials.deployToken);
    assert.equal(JSON.stringify(deployBody).includes(credentials.ingestToken), false);
    assert.equal((await marker("old-deploy", credentials.deployToken, hostId)).status, 401);
    assert.equal((await marker("new-deploy", deployBody.deployToken, hostId)).status, 201);

    const ingestRotated = await admin("/api/v1/admin/services/web/token/rotate", { method: "POST" });
    assert.equal(ingestRotated.status, 200);
    const ingestBody = await ingestRotated.json() as { name: string; ingestToken: string };
    assert.equal(ingestBody.name, "web");
    assert.match(ingestBody.ingestToken, TOKEN);
    assert.notEqual(ingestBody.ingestToken, credentials.ingestToken);
    assert.equal(JSON.stringify(ingestBody).includes(deployBody.deployToken), false);
    assert.equal((await marker("after-ingest-rotation", deployBody.deployToken, hostId)).status, 201);

    for (const path of ["/api/v1/admin/services/web/rotate", "/api/v1/admin/services/web/token/rotate"]) {
      const anonymous = await fetch(`${origin}${path}`, { method: "POST" });
      assert.equal(anonymous.status, 401, path);
    }

    assert.equal((await admin("/api/v1/admin/services/web", { method: "DELETE" })).status, 204);
    assert.equal((await marker("after-delete", deployBody.deployToken, hostId)).status, 401);
    assert.equal((await admin("/api/v1/services/web")).status, 404);
    assert.equal((await admin("/api/v1/admin/services/web", { method: "DELETE" })).status, 404);
    assert.equal((await admin("/api/v1/admin/services/web/rotate", { method: "POST" })).status, 404);
    assert.equal((await admin("/api/v1/admin/services/web/token/rotate", { method: "POST" })).status, 404);
  } finally {
    node.child.kill("SIGTERM");
    await new Promise(resolveExit => node.child.once("exit", resolveExit));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

rmSync(scratch, { recursive: true, force: true });
