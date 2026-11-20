import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { filterScrape } from "../../../packages/infra-collector/src/filter.ts";
import { MAX_SCRAPE_BYTES, parseExposition } from "../../src/metrics/exposition.ts";

async function* chunks(bytes: Uint8Array, step: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += step) yield bytes.subarray(offset, offset + step);
}

void test("stream filtering retains the real allowlisted scrape and counts omitted series across chunk boundaries", async () => {
  const body = readFileSync(new URL("../../../fixtures/metrics/v1/scrapes/standby-engine.prom", import.meta.url));
  const expected = parseExposition(body.toString("utf8"));
  let received = 0;
  const filtered = await filterScrape(chunks(body, 7), bytes => { received = bytes; });
  const actual = parseExposition(filtered.text);
  actual.dropped.unlisted_family += filtered.unlisted;
  assert.equal(received, body.length);
  assert.deepEqual(actual, expected);
});

void test("stream filtering rejects malformed input and bodies over the scrape cap", async () => {
  await assert.rejects(filterScrape(chunks(new TextEncoder().encode("not a sample\n"), 2), () => {}), /parse_error/);
  const line = "unlisted 1\n";
  const repetitions = Math.floor(MAX_SCRAPE_BYTES / line.length);
  const padding = "\n".repeat(MAX_SCRAPE_BYTES - repetitions * line.length);
  const atLimit = new TextEncoder().encode(line.repeat(repetitions) + padding);
  let received = 0;
  const filtered = await filterScrape(chunks(atLimit, 65536), bytes => { received = bytes; });
  assert.equal(received, MAX_SCRAPE_BYTES);
  assert.equal(filtered.unlisted, repetitions);
  const singleChunk = await filterScrape(chunks(atLimit, atLimit.length), () => {});
  assert.equal(singleChunk.unlisted, repetitions);
  const overLimit = new Uint8Array(MAX_SCRAPE_BYTES + 1);
  overLimit.set(atLimit);
  overLimit[MAX_SCRAPE_BYTES] = 10;
  await assert.rejects(filterScrape(chunks(overLimit, 65536), () => {}), /too_large/);
});

void test("acknowledgements must account for each scrape exactly once", async () => {
  const { reconcileAck } = await import("../../../packages/infra-collector/src/ack.ts");
  const scrapes = [{ target: "engine:a", sequence: 1 }, { target: "engine:b", sequence: 1 }] as Parameters<typeof reconcileAck>[0];
  const outcomes = [{ target: "engine:a", sequence: 1, status: "accepted" }, { target: "engine:b", sequence: 1, status: "rejected" }];
  const ack = { accepted: 1, duplicates: 0, rejected: [{ target: "engine:b", sequence: 1, code: "conflict" }], outcomes };
  assert.deepEqual(reconcileAck(scrapes, ack), outcomes);
  assert.equal(reconcileAck(scrapes, { ...ack, outcomes: outcomes.slice(0, 1) }), null);
  assert.equal(reconcileAck(scrapes, { ...ack, accepted: 2 }), null);
  assert.equal(reconcileAck(scrapes, { ...ack, rejected: [{ target: "engine:a", sequence: 1 }] }), null);
  assert.equal(reconcileAck(scrapes, { ...ack, outcomes: [outcomes[0], outcomes[0]] }), null);
  const duplicates = [{ target: "engine:a", sequence: 1, status: "duplicate" }, { target: "engine:b", sequence: 1, status: "accepted" }];
  assert.deepEqual(reconcileAck(scrapes, { accepted: 1, duplicates: 1, rejected: [], outcomes: duplicates }), duplicates);
});
