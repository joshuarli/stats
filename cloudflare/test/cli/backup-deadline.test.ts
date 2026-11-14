import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { main } from "../../src/cli/run.ts";
import { verifyBackup } from "../../src/cli/commands/backup.ts";

test("backup export permits a manifest that exceeds the normal read deadline", { timeout: 25_000 }, async () => {
  const scratch = resolve(import.meta.dirname, "../../../.work/tmp");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "backup-deadline-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/admin/objects") response.end(JSON.stringify({ objects: ["installation"] }));
    else if (request.url === "/api/v1/admin/objects/installation/export/manifest") {
      setTimeout(() => response.end(JSON.stringify({ format: "stats-export/1", object: "installation", schema: { sha256: "0".repeat(64) }, exportedAtMs: 0, alarmAtMs: null, tables: [] })), 16_000);
    } else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let errors = "";
    const destination = join(directory, "backup");
    const code = await main(["backup", "export", "--out", destination], {
      env: { STATS_URL: `http://127.0.0.1:${address.port}`, STATSCTL_TARGET: "orange" },
      io: { stdout: () => undefined, stderr: text => { errors += text; }, isTty: false },
    });
    assert.equal(code, 0, errors);
    assert.deepEqual(verifyBackup(destination), [{ object: "installation", rows: 0 }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()));
    rmSync(directory, { recursive: true, force: true });
  }
});
