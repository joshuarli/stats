import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { encodeAck, type SampleRejection } from "../../src/ingest/ack.ts";
import { fixtureRoot, readBytes, readJson } from "./corpus.ts";

interface AckCase { readonly name: string; readonly frame?: string; readonly ack?: { readonly accepted: number; readonly duplicates: number; readonly rejected: readonly { readonly seq: string; readonly code: SampleRejection }[] } }

await test("the Worker's acknowledgment encoder reproduces every golden acknowledgment", () => {
  const cases = readJson<{ cases: AckCase[] }>("acks.json").cases.filter(entry => entry.ack !== undefined && entry.frame !== undefined);
  assert.ok(cases.length >= 6);
  for (const entry of cases) {
    const ack = entry.ack!;
    const bytes = encodeAck({ accepted: ack.accepted, duplicates: ack.duplicates, rejected: ack.rejected.map(rejection => ({ seq: BigInt(rejection.seq), code: rejection.code })) });
    if (process.env.STATS_WRITE_FIXTURES !== undefined) {
      mkdirSync(dirname(join(fixtureRoot, entry.frame!)), { recursive: true });
      writeFileSync(join(fixtureRoot, entry.frame!), bytes);
      continue;
    }
    assert.deepEqual(bytes, readBytes(entry.frame!), entry.name);
  }
});

await test("a hand-audited acknowledgment has the documented layout", () => {
  assert.deepEqual([...encodeAck({ accepted: 1, duplicates: 2, rejected: [{ seq: 300n, code: "conflict" }, { seq: 1n, code: "too_old" }] })], [0x53, 0x54, 0x41, 0x32, 0x02, 0x01, 0x02, 0x02, 0xac, 0x02, 0x03, 0x01, 0x02]);
});
