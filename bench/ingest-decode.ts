import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../cloudflare/src/protocol.ts";
import { decodeFrame } from "../cloudflare/src/ingest/frame.ts";
import { normalizeSystem, validateSample } from "../cloudflare/src/ingest/sample.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v2");
const workloads = ["linux-normal", "macos-normal", "linux-single", "macos-single", "system", "linux-backlog-16", "macos-backlog-16", "high-cardinality-16", "u64-boundaries"];
const rounds = 15;

function binaryStore(frame: Uint8Array): number {
  const decoded = decodeFrame(frame);
  if (!decoded.ok) throw new Error(decoded.message);
  let bytes = decoded.batch.system === undefined ? 0 : canonicalJson(normalizeSystem(decoded.batch.system)).length;
  for (const sample of decoded.batch.samples) {
    const result = validateSample(sample);
    if (result.ok) bytes += canonicalJson(result.sample).length;
  }
  return bytes;
}

function calibrate(work: () => number): number {
  let iterations = 16;
  for (;;) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) work();
    if (performance.now() - started > 50) return iterations;
    iterations *= 2;
  }
}

console.log(`node ${process.version}, ${process.platform}/${process.arch}; ${rounds} interleaved rounds after warmup; microseconds per request, median [min-max]`);
console.log("workload | samples | STB2 decode+validate+normalize+canonicalize | STB2 absolute | stored bytes equal");
for (const name of workloads) {
  const source = JSON.parse(readFileSync(join(root, "sources", `${name}.json`), "utf8")) as { samples: unknown[] };
  const frame = new Uint8Array(readFileSync(join(root, "frames", `${name}.stb2`)));
  const absolute = new Uint8Array(readFileSync(join(root, "frames", `${name}.absolute.stb2`)));
  const candidates: [string, () => number][] = [["stb2", () => binaryStore(frame)], ["absolute", () => binaryStore(absolute)]];
  const equal = binaryStore(frame) === binaryStore(absolute);
  const iterations = candidates.map(([, work]) => calibrate(work));
  const samples: number[][] = candidates.map(() => []);
  for (let round = 0; round < rounds; round += 1) {
    candidates.forEach(([, work], index) => {
      const started = performance.now();
      for (let iteration = 0; iteration < iterations[index]!; iteration += 1) work();
      samples[index]!.push(((performance.now() - started) * 1000) / iterations[index]!);
    });
  }
  const cell = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return `${sorted[Math.floor(rounds / 2)]!.toFixed(1)} [${sorted[0]!.toFixed(1)}-${sorted[rounds - 1]!.toFixed(1)}]`;
  };
  console.log(`${name} | ${source.samples.length} | ${cell(samples[0]!)} | ${cell(samples[1]!)} | ${equal}`);
}
