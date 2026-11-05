import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandError, EXIT } from "../../src/cli/exit.ts";
import { encodeSnapshot, parseSnapshot, serializeSnapshot, SNAPSHOT_MAX_BYTES, SNAPSHOT_SCHEMA, type CostInputs } from "../../src/cli/snapshot-format.ts";
import { pruneDirectory, writeSnapshotFile } from "../../src/cli/snapshot-store.ts";
import { PRICING_REVISION } from "../../src/cost/pricing.ts";
import { projectEntry, TOKEN } from "./support.ts";
import { CLOUDFLARE_DIR } from "./support.ts";
import { documentOf, NOW_MS, payloadOf, serve, STATS, statsctl } from "./cost-support.ts";

const scratchRoot = join(CLOUDFLARE_DIR, "..", ".work", "tmp");
mkdirSync(scratchRoot, { recursive: true });

function scratch(): string {
  return mkdtempSync(join(scratchRoot, "snapshot-"));
}

async function capture(directory: string, extra: readonly string[] = []) {
  const origin = await serve({ projects: [STATS] });
  const file = join(directory, "stats-1h.json");
  try {
    const live = await statsctl(["cost", "--project", "stats", "--json"], { origin: origin.origin });
    const before = origin.seen.length;
    const saved = await statsctl(["snapshot", "--project", "stats", "--out", file, "--json", ...extra], { origin: origin.origin });
    return { live, saved, file, requests: origin.seen.length - before };
  } finally {
    await origin.close();
  }
}

async function replay(file: string, extra: readonly string[] = []) {
  const marker = join(scratch(), "auth-ran");
  const ran = await statsctl(["cost", "--input", file, "--json", ...extra], { origin: "http://127.0.0.1:9", env: { STATSCTL_AUTH_COMMAND: `touch ${marker}` } });
  return { ran, authRan: existsSync(marker) };
}

function rewrite(file: string, edit: (snapshot: Record<string, unknown>) => void): string {
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(snapshot);
  const edited = `${file}.edited.json`;
  writeFileSync(edited, JSON.stringify(snapshot));
  return edited;
}

function refusal(ran: { code: number; stdout: string }): string {
  assert.equal(ran.code, EXIT.transport);
  return (documentOf(ran as never)["error"] as { code: string }).code;
}

await test("a snapshot replays offline to exactly the live payload", async () => {
  const directory = scratch();
  try {
    const { live, saved, file, requests } = await capture(directory);
    assert.equal(saved.code, EXIT.ok, saved.stderr);
    assert.equal(requests, 6);
    const replayed = await replay(file);
    assert.equal(replayed.ran.code, EXIT.ok, replayed.ran.stderr);
    assert.equal(replayed.authRan, false);
    assert.equal(JSON.stringify(payloadOf(replayed.ran)), JSON.stringify(payloadOf(live)));
    const liveDocument = documentOf(live);
    const replayDocument = documentOf(replayed.ran);
    for (const key of ["windows", "pricingRevision", "measurementRevision", "coverage", "units", "priced", "excluded", "warnings", "project"]) {
      assert.deepEqual(replayDocument[key], liveDocument[key], key);
    }
    const again = await replay(file, ["--series"]);
    assert.ok(again.ran.stdout.includes('"trend"'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("a snapshot holds frames, hashes, and revisions but no credential and no stack frames", async () => {
  const directory = scratch();
  try {
    const { saved, file } = await capture(directory);
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(TOKEN));
    assert.ok(!/stack|frames"/u.test(text.replace(/"history\.[a-z]+","sha256":"[0-9a-f]{64}","encoding":"base64","data":"[A-Za-z0-9+/=]*"/gu, "")));
    const snapshot = JSON.parse(text) as { schema: string; pricingRevision: string; measurementRevision: string; cliRevision: string; identities: { worker: string }; inputs: { name: string; sha256: string; encoding: string }[] };
    assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);
    assert.equal(snapshot.pricingRevision, PRICING_REVISION);
    assert.match(snapshot.measurementRevision, /\S/u);
    assert.match(snapshot.cliRevision, /^([0-9a-f]{40}|unknown)$/u);
    assert.equal(snapshot.identities.worker, "stats");
    assert.deepEqual(snapshot.inputs.map(input => input.name), ["resolution", "project", "history.current", "history.previous", "observe.methods"]);
    assert.ok(snapshot.inputs.every(input => /^[0-9a-f]{64}$/u.test(input.sha256)));
    const payload = documentOf(saved)["payload"] as { file: string; inputs: { name: string }[] };
    assert.equal(payload.file, file);
    assert.equal(payload.inputs.length, 5);
    assert.ok(statSync(file).size < SNAPSHOT_MAX_BYTES);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("a corrupt input, a tampered clock, or a different revision is refused with exit 4 and a reason", async () => {
  const directory = scratch();
  try {
    const { file } = await capture(directory);
    const corrupt = rewrite(file, snapshot => {
      const inputs = snapshot["inputs"] as { name: string; data: string }[];
      const frame = inputs.find(input => input.name === "history.current")!;
      frame.data = `${frame.data[0] === "A" ? "B" : "A"}${frame.data.slice(1)}`;
    });
    assert.equal(refusal((await replay(corrupt)).ran), "snapshot_hash_mismatch");
    const clock = rewrite(file, snapshot => {
      const resolution = (snapshot["inputs"] as { name: string; data: { capturedAtMs: number } }[]).find(input => input.name === "resolution")!;
      resolution.data.capturedAtMs += 1;
    });
    assert.equal(refusal((await replay(clock)).ran), "snapshot_hash_mismatch");
    const pricing = rewrite(file, snapshot => { snapshot["pricingRevision"] = "2000-01-01"; });
    assert.equal(refusal((await replay(pricing)).ran), "snapshot_pricing_revision");
    const measurement = rewrite(file, snapshot => { snapshot["measurementRevision"] = "0"; });
    assert.equal(refusal((await replay(measurement)).ran), "snapshot_measurement_revision");
    const schema = rewrite(file, snapshot => { snapshot["schema"] = "statsctl-snapshot/0"; });
    assert.equal(refusal((await replay(schema)).ran), "snapshot_schema");
    const missing = rewrite(file, snapshot => { snapshot["inputs"] = (snapshot["inputs"] as { name: string }[]).filter(input => input.name !== "history.current"); });
    assert.equal(refusal((await replay(missing)).ran), "snapshot_malformed");
    writeFileSync(join(directory, "cut.json"), readFileSync(file, "utf8").slice(0, 400));
    assert.equal(refusal((await replay(join(directory, "cut.json"))).ran), "snapshot_malformed");
    assert.equal(refusal((await replay(join(directory, "absent.json"))).ran), "snapshot_unreadable");
    for (const refused of [corrupt, clock, pricing, measurement, schema, missing]) assert.equal((await replay(refused)).authRan, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("a snapshot for another project is a usage error and an oversize file is refused unread", async () => {
  const directory = scratch();
  try {
    const { file } = await capture(directory);
    const other = await replay(file, ["--project", "plain"]);
    assert.equal(other.ran.code, EXIT.usage);
    const big = join(directory, "big.json");
    writeFileSync(big, " ".repeat(SNAPSHOT_MAX_BYTES + 1));
    assert.equal(refusal((await replay(big)).ran), "snapshot_too_large");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("a snapshot above the cap is refused before anything is written", () => {
  const directory = scratch();
  try {
    const file = join(directory, "large.json");
    assert.throws(() => writeSnapshotFile(file, "x".repeat(101), { snapshotBytes: 100, directoryBytes: 1000 }), (error: unknown) => error instanceof CommandError && error.exit === EXIT.transport && error.code === "snapshot_too_large");
    assert.equal(existsSync(file), false);
    assert.deepEqual(readdirSync(directory), []);
    assert.equal(writeSnapshotFile(file, "x".repeat(100), { snapshotBytes: 100, directoryBytes: 1000 }).bytes, 100);
    assert.equal(SNAPSHOT_MAX_BYTES, 4 * 1024 * 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("the directory is pruned oldest first and never loses the file just written", () => {
  const directory = scratch();
  try {
    for (const [index, name] of ["a.json", "b.json", "c.json", "d.json"].entries()) {
      writeFileSync(join(directory, name), "x".repeat(10));
      utimesSync(join(directory, name), 1000 + index, 1000 + index);
    }
    writeFileSync(join(directory, "note.txt"), "x".repeat(500));
    assert.equal(pruneDirectory(directory, join(directory, "a.json"), 25), 2);
    assert.deepEqual(readdirSync(directory).sort(), ["a.json", "d.json", "note.txt"]);
    assert.equal(pruneDirectory(directory, join(directory, "d.json"), 0), 1);
    assert.deepEqual(readdirSync(directory).sort(), ["d.json", "note.txt"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("the format round trips decoded inputs and rejects a duplicated input name", () => {
  const origin = projectEntry("stats");
  const inputs: CostInputs = {
    capturedAtMs: NOW_MS,
    project: { ...origin, probes: [], collector: origin.collector },
    windows: { current: { fromMs: 1, toMs: 2 }, previous: { fromMs: 0, toMs: 1 }, monthToDate: false },
    notes: [{ code: "baseline_unavailable", message: "m" }],
    requests: { shared: 2, project: 3 },
    current: new Uint8Array([1, 2, 3]),
    previous: null,
    methods: null
  };
  const text = serializeSnapshot(encodeSnapshot(inputs, "unknown"));
  const parsed = JSON.parse(text) as { inputs: unknown[] };
  assert.ok(text.endsWith("\n"));
  parsed.inputs.push(parsed.inputs[0]);
  assert.throws(() => parseSnapshot(JSON.stringify(parsed)), (error: unknown) => error instanceof CommandError && error.code === "snapshot_malformed");
  assert.deepEqual(parseSnapshot(text).current, inputs.current);
});

await test("snapshot needs --out and a known project and writes nothing on failure", async () => {
  const origin = await serve({ projects: [STATS] });
  const directory = scratch();
  try {
    assert.equal((await statsctl(["snapshot", "--project", "stats", "--json"], { origin: origin.origin })).code, EXIT.usage);
    assert.equal((await statsctl(["snapshot", "--project", "nope", "--out", join(directory, "x.json"), "--json"], { origin: origin.origin })).code, EXIT.usage);
    assert.equal((await statsctl(["snapshot", "--project", "stats", "--window", "3h", "--out", join(directory, "x.json"), "--json"], { origin: origin.origin })).code, EXIT.usage);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    await origin.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
