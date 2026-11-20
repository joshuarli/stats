import { isPresent } from "../../../cloudflare/src/binary/columns.ts";
import { openHistory } from "../../../cloudflare/src/binary/history.ts";

export type Sample = { seq: string; atMs: string; monoMs: string; cpuCount: number; uptimeMs: string; cpu: { user: string; system: string; idle: string; total: string } };
export type Point = Record<string, number>;

export function acknowledgedSamples(samples: readonly Sample[], rejected: readonly { seq: bigint }[]): Sample[] {
  const rejectedSequences = new Set(rejected.map(item => item.seq.toString()));
  return samples.filter(sample => !rejectedSequences.has(sample.seq));
}

export function expectedHistory(samples: readonly Sample[]): Point[] {
  return samples.map((sample, index) => {
    const previous = samples[index - 1];
    const elapsed = previous === undefined ? 0 : Number(BigInt(sample.monoMs) - BigInt(previous.monoMs));
    const point: Point = { atMs: Number(sample.atMs), coverageMs: elapsed, partial: 0, cpuCount: sample.cpuCount, uptimeMs: Number(sample.uptimeMs) };
    if (previous !== undefined && elapsed > 0) {
      const fields = ["user", "system", "idle", "total"] as const;
      const delta = Object.fromEntries(fields.map(field => [field, BigInt(sample.cpu[field]) - BigInt(previous.cpu[field])]));
      if (Object.values(delta).every(value => value >= 0n) && delta.total! > 0n) {
        point.cpu = 1;
        for (const field of ["user", "system", "idle"] as const) point[`cpu.${field}`] = Number((delta[field]! * 100_000n + delta.total! / 2n) / delta.total!) / 1000;
      }
    }
    return point;
  });
}

export function compareHistory(bytes: Uint8Array, host: string, expected: readonly Point[], phase: string) {
  const root = openHistory(bytes).root;
  if (root.form !== "points" || root.metadata.hostId !== host || root.metadata.resolution !== "raw" || root.metadata.stepMs !== 15_000) throw new Error("history is not an undownsampled raw host response");
  const table = root.series[0]!.table;
  const actual = Array.from({ length: table.rows }, (_, row) => Object.fromEntries(table.columns.filter(column => isPresent(column, row)).map(column => [column.name, Number(column.values[row])])));
  const byTime = new Map(actual.map(point => [point.atMs, point]));
  let verified = 0, missing = 0, mismatched = 0;
  for (const point of expected) {
    const found = byTime.get(point.atMs);
    if (!found) { missing++; continue; }
    byTime.delete(point.atMs);
    const keys = Object.keys(point).sort();
    if (JSON.stringify(keys) === JSON.stringify(Object.keys(found).sort()) && keys.every(key => found[key] === point[key])) verified++; else mismatched++;
  }
  mismatched += byTime.size + actual.length - new Set(actual.map(point => point.atMs)).size;
  return { phase, expected: expected.length, verified, missing, mismatched };
}
