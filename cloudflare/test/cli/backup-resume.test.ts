import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { verifyBackup } from "../../src/cli/commands/backup.ts";
import { main } from "../../src/cli/run.ts";
import { fakeOrigin, sendJson } from "./support.ts";

await test("backup export resumes a verified prefix and skips finished objects", async () => {
  const scratch = resolve(import.meta.dirname, "../../../.work/tmp");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "backup-resume-"));
  const complete = "[1]\n[2]\n";
  let failPage = true;
  let changed = false;
  let exportedAtMs = 0;
  const queried: string[] = [];
  const server = await fakeOrigin((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const object = url.pathname.split("/")[5] === "installation" ? "installation" : "observe:stats";
    if (url.pathname === "/api/v1/admin/objects") {
      sendJson(response, { objects: ["installation", "observe:stats"] });
    } else if (url.pathname.endsWith("/manifest")) {
      const bytes = changed && object === "observe:stats" ? "[1]\n[3]\n" : complete;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      sendJson(response, {
        format: "stats-export/1", object, schema: { sha256: "0".repeat(64) }, alarmAtMs: null, exportedAtMs: exportedAtMs++,
        tables: [{ name: "samples", columns: ["id"], key: ["id"], sql: "CREATE TABLE samples(id INTEGER PRIMARY KEY)", rows: 2, sha256 }]
      });
    } else if (url.pathname.endsWith("/rows")) {
      const after = url.searchParams.get("after");
      queried.push(`${object}:${after ?? "start"}`);
      if (object === "installation") sendJson(response, { rows: [[1], [2]], next: null });
      else if (after === null) sendJson(response, { rows: [[1]], next: [1] });
      else if (failPage) sendJson(response, { error: "fixture page failed" }, 400);
      else sendJson(response, { rows: [[2]], next: null });
    } else sendJson(response, {}, 404);
  });
  const failed = join(directory, "failed");
  const partial = `${failed}.partial`;
  const prefix = join(partial, "observe-stats", "samples.ndjson");
  const run = async (out: string, resume?: string, serial = false) => {
    let stderr = "";
    const exit = await main(["backup", "export", "--out", out, ...(resume === undefined ? [] : ["--resume-from", resume]), ...(serial ? ["--serial"] : [])], {
      env: { STATS_URL: server.origin, STATSCTL_TARGET: "orange" },
      io: { stdout: () => undefined, stderr: text => { stderr += text; }, isTty: false }
    });
    return { exit, stderr };
  };
  try {
    assert.equal((await run(failed, undefined, true)).exit, 4);
    assert.deepEqual(queried, ["installation:start", "observe:stats:start", "observe:stats:[1]"]);
    assert.equal(existsSync(join(partial, "index.json")), false);
    assert.equal(readFileSync(prefix, "utf8"), "[1]\n");
    failPage = false;
    changed = true;
    const changedSnapshot = await run(join(directory, "changed"), partial);
    assert.equal(changedSnapshot.exit, 2);
    assert.match(changedSnapshot.stderr, /changed since the interrupted export/u);

    queried.length = 0;
    changed = false;
    writeFileSync(prefix, "[9]\n");
    const corrupt = await run(join(directory, "corrupt"), partial);
    assert.equal(corrupt.exit, 2);
    assert.match(corrupt.stderr, /does not match its verified export checkpoint/u);

    writeFileSync(prefix, "[1]\n");
    appendFileSync(prefix, "interrupted append");
    queried.length = 0;
    const destination = join(directory, "resumed");
    const resumed = await run(destination, partial);
    assert.equal(resumed.exit, 0, resumed.stderr);
    assert.deepEqual(queried, ["observe:stats:[1]"]);
    assert.equal(readFileSync(prefix, "utf8"), "[1]\ninterrupted append");
    assert.equal(readFileSync(join(destination, "observe-stats", "samples.ndjson"), "utf8"), complete);
    assert.deepEqual(verifyBackup(destination), [{ object: "installation", rows: 2 }, { object: "observe:stats", rows: 2 }]);
    assert.equal(existsSync(join(destination, ".export-source.json")), false);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("reopening attempts later objects and reports replies that did not prove the new state", async () => {
  const objects = ["installation", "observe:stats", "observe:stuff"];
  const origin = await fakeOrigin((request, response) => {
    const object = (request.url ?? "").split("/")[5];
    if (request.url === "/api/v1/admin/objects") sendJson(response, { objects });
    else if (object === "installation") sendJson(response, {}, 503);
    else sendJson(response, { object, state: object === "observe:stats" ? "fenced" : "open" });
  });
  let stdout = "";
  try {
    const exit = await main(["backup", "fence", "--state", "open", "--json"], {
      env: { STATS_URL: origin.origin, STATSCTL_TARGET: "orange" },
      io: { stdout: text => { stdout += text; }, stderr: () => undefined, isTty: false }
    });
    assert.equal(exit, 4);
    const document = JSON.parse(stdout) as { payload: { objects: string[]; unconfirmed: { object: string; code: string }[] } };
    assert.deepEqual(document.payload.objects, ["observe:stuff"]);
    assert.deepEqual(document.payload.unconfirmed.map(({ object, code }) => [object, code]), [
      ["installation", "http_503"], ["observe:stats", "contract"]
    ]);
    assert.deepEqual(origin.seen.filter(request => request.method === "POST").map(request => request.url),
      objects.map(object => `/api/v1/admin/objects/${object}/maintenance`));
  } finally {
    await origin.close();
  }
});
