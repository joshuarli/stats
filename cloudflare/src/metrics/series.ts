import { catalog } from "./catalog.ts";
import type { Histogram, Labels, Values } from "./exposition.ts";

export type Sample = {
  instance: string;
  incarnation: string | null;
  monoMs: number;
  atMs: number;
  outcome: string;
  values: Values;
};
export type Point = {
  instance: string;
  incarnation: string | null;
  atMs: number;
  intervalMs: number | null;
  series: Array<{ labels: Labels; value: string | Histogram | null }>;
};

function labelsKey(labels: Labels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}
function counterDecreased(before: Values, after: Values): boolean {
  for (const [name, entries] of Object.entries(after)) {
    if (catalog[name]?.type !== "counter") continue;
    for (const [labels, value] of entries) {
      const previous = before[name]?.find(([other]) => labelsKey(other) === labelsKey(labels))?.[1];
      if (typeof value === "string" && typeof previous === "string" && BigInt(value) < BigInt(previous)) return true;
    }
  }
  return false;
}

// Exact decimal subtraction without binary floating-point rounding. The result is a
// decimal expression when the exponents are too far apart to expand within bounds.
function decimalDelta(a: string, b: string): string {
  const parse = (value: string): { coefficient: bigint; exponent: number } => {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value)!;
    const fraction = match[3] ?? "";
    return {
      coefficient: BigInt(`${match[1] === "-" ? "-" : ""}${match[2] || "0"}${fraction}`),
      exponent: Number(match[4] ?? 0) - fraction.length
    };
  };
  const x = parse(a), y = parse(b);
  const exponent = Math.min(x.exponent, y.exponent);
  if (Math.abs(x.exponent - y.exponent) > 1024 || !Number.isSafeInteger(exponent)) return `${a}-(${b})`;
  const difference = x.coefficient * 10n ** BigInt(x.exponent - exponent) - y.coefficient * 10n ** BigInt(y.exponent - exponent);
  return `${difference}e${exponent}`;
}

export function seriesPoints(samples: Sample[], family: string, engine: boolean): Point[] {
  const spec = catalog[family];
  if (!spec) throw new Error("unknown family");
  const points: Point[] = [];
  let previous: Sample | undefined;
  for (const current of samples) {
    if (current.outcome !== "ok") continue;
    const previousValues = previous?.values[family];
    const sameProcess = previous !== undefined && previous.instance === current.instance &&
      previous.incarnation === current.incarnation && previous.monoMs < current.monoMs &&
      !(engine && counterDecreased(previous.values, current.values));
    const intervalMs = sameProcess ? current.monoMs - previous!.monoMs : null;
    const entries = (current.values[family] ?? []).map(([labels, value]) => {
      const old = sameProcess ? previousValues?.find(([other]) => labelsKey(other) === labelsKey(labels))?.[1] : undefined;
      if (spec.type === "gauge") return { labels, value };
      if (typeof value === "string") {
        if (typeof old !== "string" || BigInt(value) < BigInt(old)) return { labels, value: null };
        return { labels, value: (BigInt(value) - BigInt(old)).toString() };
      }
      if (!old || typeof old === "string" || value.buckets.some((v, i) => BigInt(v) < BigInt(old.buckets[i]!)) || BigInt(value.count) < BigInt(old.count)) {
        return { labels, value: null };
      }
      const histogram: Histogram = {
        buckets: value.buckets.map((v, i) => (BigInt(v) - BigInt(old.buckets[i]!)).toString()),
        count: (BigInt(value.count) - BigInt(old.count)).toString(),
        sum: decimalDelta(value.sum, old.sum)
      };
      return { labels, value: histogram };
    });
    points.push({ instance: current.instance, incarnation: current.incarnation, atMs: current.atMs, intervalMs, series: entries });
    previous = current;
  }
  return points;
}
