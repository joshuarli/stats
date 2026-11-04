import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "v2");

export type SampleOutcome = "accept" | "invalid_sample";
export interface BatchCase { readonly name: string; readonly label: string; readonly source: string; readonly frame: string; readonly samples: readonly SampleOutcome[]; readonly budget?: number; readonly workload?: string }
export interface SourceBatch { readonly hostId: string; readonly bootId: string; readonly system?: unknown; readonly samples: readonly Record<string, unknown>[] }
export interface MalformedCase { readonly name: string; readonly code: string; readonly why: string; readonly hex?: string; readonly base?: string; readonly truncate?: number; readonly append?: string; readonly patch?: readonly { readonly offset: number; readonly hex: string }[] }

export function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, relative), "utf8")) as T;
}

export function readBytes(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtureRoot, relative)));
}

export function fromHex(text: string): Uint8Array {
  const digits = text.replace(/\s+/gu, "");
  if (digits.length % 2 !== 0 || /[^0-9a-f]/iu.test(digits)) throw new Error(`invalid hex: ${text}`);
  return Uint8Array.from({ length: digits.length / 2 }, (_, index) => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16));
}

export function batches(): readonly BatchCase[] {
  return readJson<{ batches: BatchCase[] }>("manifest.json").batches;
}

export function malformedFrame(entry: MalformedCase): Uint8Array {
  if (entry.hex !== undefined) return fromHex(entry.hex);
  if (entry.base === undefined) throw new Error(`${entry.name}: needs hex or base`);
  let bytes: Uint8Array = readBytes(`frames/${entry.base}.stb2`).slice();
  for (const patch of entry.patch ?? []) bytes.set(fromHex(patch.hex), patch.offset < 0 ? bytes.length + patch.offset : patch.offset);
  if (entry.truncate !== undefined) bytes = bytes.slice(0, entry.truncate < 0 ? bytes.length + entry.truncate : entry.truncate);
  if (entry.append !== undefined) bytes = Uint8Array.from([...bytes, ...fromHex(entry.append)]);
  return bytes;
}
