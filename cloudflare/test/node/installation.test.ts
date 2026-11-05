import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decodeAck } from "../../src/ingest/ack-decode.ts";
import { ACK_MEDIA_TYPE } from "../../src/ingest/ack.ts";
import { encodeFrame } from "../../src/ingest/encode.ts";
import { canonicalJson } from "../../src/protocol.ts";
import { DatabaseInUseError, openNodeInstallation } from "../../src/node/installation.ts";
import { HISTORY_CONTENT_TYPE } from "../../src/binary/history.ts";
import { readHistory } from "../support/history.ts";
import { DAY_MS, fixtureBytes, fixtureSource, historyRequest, ingestRequest, manifest, NOW_MS, openHarness, scratchDirectory, withHost, type Harness } from "./support.ts";

async function newHost(harness: Harness, name: string): Promise<{ hostId: string; token: string }> {
  const result = await harness.core.createHost(name);
  assert.ok(result.ok);
  return result.value;
}

function stored(harness: Harness, hostId: string): Record<string, string> {
  const rows = harness.db.prepare("SELECT seq, payload FROM samples WHERE host_id = ? ORDER BY mono_ms").all(hostId) as { seq: string; payload: string }[];
  return Object.fromEntries(rows.map(row => [row.seq, row.payload]));
}

await test("core ingest on node:sqlite stores every golden frame's accepted samples as their canonical source and acknowledges the rest per sample", async () => {
  const harness = openHarness();
  try {
    for (const entry of manifest.batches) {
      const host = await newHost(harness, entry.name);
      const source = fixtureSource(entry.source);
      const response = await harness.core.fetch(ingestRequest(host.token, withHost(fixtureBytes(entry.frame), host.hostId)));
      const outcomes = source.samples.map((sample, index) => {
        if (entry.samples[index] !== "accept") return "invalid_sample";
        const at = Number(sample.atMs);
        if (at > NOW_MS + 300_000) return "invalid_sample";
        if (at < NOW_MS - 2 * DAY_MS) return "too_old";
        return "accept";
      });
      const rows = stored(harness, host.hostId);
      if (!outcomes.includes("accept")) {
        assert.equal(response.status, 400, entry.name);
        assert.deepEqual(Object.keys(rows), [], entry.name);
        continue;
      }
      assert.equal(response.status, 200, entry.name);
      assert.equal(response.headers.get("content-type"), ACK_MEDIA_TYPE, entry.name);
      const ack = decodeAck(new Uint8Array(await response.arrayBuffer()), source.samples.map(sample => BigInt(String(sample.seq))));
      assert.equal(ack.accepted, outcomes.filter(outcome => outcome === "accept").length, entry.name);
      assert.equal(ack.duplicates, 0, entry.name);
      assert.deepEqual(ack.rejected, source.samples.flatMap((sample, index) => (outcomes[index] === "accept" ? [] : [{ seq: BigInt(String(sample.seq)), code: outcomes[index] }])), entry.name);
      for (const [index, sample] of source.samples.entries()) {
        if (outcomes[index] === "accept") assert.equal(rows[String(sample.seq)], canonicalJson(sample), `${entry.name}[${index}]`);
      }
    }
  } finally {
    harness.close();
  }
});

await test("core ingest on node:sqlite acknowledges a replay as duplicates and leaves the stored rows untouched", async () => {
  const harness = openHarness();
  try {
    const host = await newHost(harness, "replay");
    const source = fixtureSource("sources/linux-normal.json");
    const sent = source.samples.map(sample => BigInt(String(sample.seq)));
    const body = withHost(fixtureBytes("frames/linux-normal.stb2"), host.hostId);
    const first = decodeAck(new Uint8Array(await (await harness.core.fetch(ingestRequest(host.token, body))).arrayBuffer()), sent);
    const before = stored(harness, host.hostId);
    const replay = decodeAck(new Uint8Array(await (await harness.core.fetch(ingestRequest(host.token, body))).arrayBuffer()), sent);
    assert.deepEqual([first.accepted, first.duplicates], [2, 0]);
    assert.deepEqual([replay.accepted, replay.duplicates], [0, 2]);
    assert.deepEqual(stored(harness, host.hostId), before);
  } finally {
    harness.close();
  }
});

await test("core ingest on node:sqlite rejects a wrong credential and a malformed frame without writing", async () => {
  const harness = openHarness();
  try {
    const host = await newHost(harness, "refused");
    const body = withHost(fixtureBytes("frames/linux-normal.stb2"), host.hostId);
    assert.equal((await harness.core.fetch(ingestRequest("wrong-token", body))).status, 401);
    assert.equal((await harness.core.fetch(ingestRequest(host.token, new Uint8Array([1, 2, 3])))).status, 400);
    assert.deepEqual(stored(harness, host.hostId), {});
  } finally {
    harness.close();
  }
});

await test("core history on node:sqlite serves a decodable frame and answers a matching ETag with 304 until the next ingest", async () => {
  const harness = openHarness();
  try {
    const host = await newHost(harness, "history");
    assert.equal((await harness.core.fetch(ingestRequest(host.token, withHost(fixtureBytes("frames/linux-normal.stb2"), host.hostId)))).status, 200);
    const response = await harness.core.fetch(historyRequest(host.hostId, "range=1h&kind=summary"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), HISTORY_CONTENT_TYPE);
    const etag = response.headers.get("etag")!;
    const history = readHistory(new Uint8Array(await response.arrayBuffer())) as { hostId: string; kind: string; points: unknown[] };
    assert.equal(history.hostId, host.hostId);
    assert.equal(history.kind, "summary");
    assert.equal(history.points.length, 2);
    const unchanged = await harness.core.fetch(historyRequest(host.hostId, "range=1h&kind=summary", { "If-None-Match": etag }));
    assert.equal(unchanged.status, 304);
    const source = fixtureSource("sources/linux-normal.json");
    const later = source.samples.map(sample => ({ ...sample, seq: String(Number(sample.seq) + 30), monoMs: String(Number(sample.monoMs) + 30_000), atMs: String(Number(sample.atMs) + 30_000) }));
    assert.equal((await harness.core.fetch(ingestRequest(host.token, encodeFrame({ ...source, hostId: host.hostId, samples: later })))).status, 200);
    const changed = await harness.core.fetch(historyRequest(host.hostId, "range=1h&kind=summary", { "If-None-Match": etag }));
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
  } finally {
    harness.close();
  }
});

await test("core retention on node:sqlite deletes expired samples, bumps the history version, and re-arms the scheduler", async () => {
  const harness = openHarness();
  try {
    const host = await newHost(harness, "retained");
    assert.equal((await harness.core.fetch(ingestRequest(host.token, withHost(fixtureBytes("frames/linux-normal.stb2"), host.hostId)))).status, 200);
    const before = harness.db.prepare("SELECT version FROM host_history_versions WHERE host_id = ?").get(host.hostId) as { version: number };
    assert.ok(Object.keys(stored(harness, host.hostId)).length > 0);
    assert.equal(await harness.scheduler.pending(), NOW_MS + 600_000);
    harness.setNow(NOW_MS + 3 * DAY_MS);
    await harness.core.alarm();
    assert.deepEqual(stored(harness, host.hostId), {});
    const after = harness.db.prepare("SELECT version FROM host_history_versions WHERE host_id = ?").get(host.hostId) as { version: number };
    assert.equal(after.version, before.version + 1);
    assert.equal(await harness.scheduler.pending(), NOW_MS + 3 * DAY_MS + 600_000);
  } finally {
    harness.close();
  }
});

await test("a node:sqlite database file keeps its hosts and samples across a close and reopen", async () => {
  const directory = scratchDirectory("node-installation");
  const path = join(directory, "stats.sqlite");
  try {
    const first = openNodeInstallation({ path, projects: "[]", clock: { now: () => NOW_MS } });
    const created = await first.core.createHost("durable");
    assert.ok(created.ok);
    const body = withHost(fixtureBytes("frames/linux-normal.stb2"), created.value.hostId);
    assert.equal((await first.core.fetch(ingestRequest(created.value.token, body))).status, 200);
    first.close();

    const second = openNodeInstallation({ path, projects: "[]", clock: { now: () => NOW_MS } });
    try {
      assert.deepEqual((await second.core.listHosts()).map(host => host.hostId), [created.value.hostId]);
      const replay = decodeAck(new Uint8Array(await (await second.core.fetch(ingestRequest(created.value.token, body))).arrayBuffer()), fixtureSource("sources/linux-normal.json").samples.map(sample => BigInt(String(sample.seq))));
      assert.deepEqual([replay.accepted, replay.duplicates], [0, 2]);
    } finally {
      second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("a second server on the same database file fails to open while the first is running, and succeeds after it closes", async () => {
  const directory = scratchDirectory("node-lock");
  const path = join(directory, "stats.sqlite");
  try {
    const first = openNodeInstallation({ path, projects: "[]", clock: { now: () => NOW_MS } });
    assert.throws(() => openNodeInstallation({ path, projects: "[]", clock: { now: () => NOW_MS } }), DatabaseInUseError);
    first.close();
    openNodeInstallation({ path, projects: "[]", clock: { now: () => NOW_MS } }).close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
