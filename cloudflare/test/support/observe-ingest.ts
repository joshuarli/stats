import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeBatch, encodeBatch } from "../../src/observe/ingest/codec.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures/observe-ingest");
const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as { readonly service: string; readonly nowMs: number; readonly golden: string };
const golden = readFileSync(join(FIXTURES, manifest.golden), "utf8").trim();

export const OBSERVE_SERVICE = manifest.service;

export interface RebasedBatch {
  readonly text: string;
  readonly events: readonly ExternalEvent[];
}

export function rebasedBatch(nowMs: number): RebasedBatch {
  const decoded = decodeBatch(golden, { service: manifest.service, nowMs: manifest.nowMs });
  if (!decoded.ok) throw new Error(`golden batch did not decode: ${decoded.code}`);
  const events = decoded.batch.events.map((event, index) => ({ ...event, atMs: nowMs - 120_000 + index * 60_000 }));
  const text = encodeBatch({ events });
  const check = decodeBatch(text, { service: manifest.service, nowMs: nowMs + 1_000 });
  if (!check.ok) throw new Error(`rebased batch did not decode: ${check.code}`);
  return { text, events: check.batch.events };
}
