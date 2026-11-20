import { catalog } from "./catalog.ts";

export const MAX_SCRAPE_BYTES = 4 * 1024 * 1024;

export type Labels = Record<string, string>;
export type Histogram = { buckets: string[]; count: string; sum: string };
export type Values = Record<string, [Labels, string | Histogram][]>;
export type Drops = { unlisted_family: number; unlisted_label: number; non_finite: number; series_cap: number };

export function isU64(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 18446744073709551615n;
}
export function isDecimal(value: string): boolean {
  return value.length <= 32 && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(value) && Number.isFinite(Number(value));
}

function parseLabels(text: string): Labels {
  const labels: Labels = {};
  let rest = text;
  while (rest.length) {
    const match = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\[\\"n])*)"\s*(,|$)/u.exec(rest);
    if (!match || Object.hasOwn(labels, match[1]!)) throw new Error("invalid labels");
    labels[match[1]!] = match[2]!.replace(/\\([\\"n])/gu, (_, c: string) => c === "n" ? "\n" : c);
    rest = rest.slice(match[0].length);
    if (match[3] === "," && !rest.trim()) throw new Error("invalid labels");
  }
  return labels;
}

function addDecimal(a: string, b: string): string {
  const parse = (value: string) => {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value)!;
    const fraction = match[3] ?? "";
    return { coefficient: BigInt(`${match[1] === "-" ? "-" : ""}${match[2] || "0"}${fraction}`), exponent: Number(match[4] ?? 0) - fraction.length };
  };
  const x = parse(a), y = parse(b), exponent = Math.min(x.exponent, y.exponent);
  if (!Number.isSafeInteger(exponent) || Math.abs(x.exponent - y.exponent) > 100) throw new Error("aggregate overflow");
  const result = `${x.coefficient * 10n ** BigInt(x.exponent - exponent) + y.coefficient * 10n ** BigInt(y.exponent - exponent)}e${exponent}`;
  if (!isDecimal(result)) throw new Error("aggregate overflow");
  return result;
}

export function parseExposition(body: string): { values: Values; dropped: Drops } {
  if (new TextEncoder().encode(body).length > MAX_SCRAPE_BYTES) throw new Error("body too large");
  const types = new Map<string, string>();
  const seen = new Set<string>();
  const raw = new Map<string, { labels: Labels; samples: Map<string, string> }>();
  const bad = new Set<string>();
  const dropped: Drops = { unlisted_family: 0, unlisted_label: 0, non_finite: 0, series_cap: 0 };
  for (const line of body.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (line.startsWith("#")) {
      const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram|summary|untyped)$/u.exec(line);
      if (type) {
        if (types.has(type[1]!)) throw new Error("duplicate type");
        types.set(type[1]!, type[2]!);
      } else if (!/^#(?:\s|$)/u.test(line)) throw new Error("invalid comment");
      continue;
    }
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)(?:\s+\d+)?\s*$/u.exec(line);
    if (!sample) throw new Error("invalid sample");
    const name = sample[1]!;
    const labels = parseLabels(sample[2] ?? "");
    const value = sample[3]!;
    const family = Object.hasOwn(catalog, name) ? name : name.replace(/_(?:bucket|sum|count)$/u, "");
    const key = `${name}:${JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))}`;
    if (seen.has(key)) throw new Error("duplicate series");
    seen.add(key);
    if (!catalog[family]) { dropped.unlisted_family++; continue; }
    const spec = catalog[family]!;
    if (types.get(family) !== spec.type) throw new Error("type mismatch");
    const part = name === family ? "value" : name.slice(family.length + 1);
    const le = labels.le;
    delete labels.le;
    if (Object.keys(labels).length !== Object.keys(spec.labels).length || Object.entries(labels).some(([k, v]) => (k !== "actor_name" && !spec.labels[k]?.includes(v)))) {
      bad.add(family);
      dropped.unlisted_label++;
      continue;
    }
    if (spec.type !== "histogram" && (part !== "value" || le !== undefined)) throw new Error("invalid sample type");
    if (spec.type === "histogram" && !(["bucket", "sum", "count"].includes(part)) || part === "bucket" && le === undefined || part !== "bucket" && le !== undefined) throw new Error("invalid histogram");
    if (!(part === "sum" || spec.form === "decimal" ? isDecimal(value) : isU64(value))) throw new Error("invalid value");
    const seriesKey = `${family}:${JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))}`;
    let series = raw.get(seriesKey);
    if (!series) { series = { labels, samples: new Map() }; raw.set(seriesKey, series); }
    series.samples.set(part === "bucket" ? `bucket:${le}` : part, value);
  }
  const values: Values = {};
  for (const [key, series] of raw) {
    const family = key.slice(0, key.indexOf(":"));
    if (bad.has(family)) continue;
    const spec = catalog[family]!;
    let value: string | Histogram;
    if (spec.type === "histogram") {
      const buckets = spec.buckets!.map((le) => series.samples.get(`bucket:${le}`));
      const count = series.samples.get("count"), sum = series.samples.get("sum");
      if (buckets.some((v) => v === undefined) || !count || !sum || series.samples.size !== buckets.length + 2) throw new Error("histogram layout");
      const counts = buckets as string[];
      if (counts.some((v, i) => i > 0 && BigInt(v) < BigInt(counts[i - 1]!)) || counts.at(-1) !== count) throw new Error("histogram cumulative");
      value = { buckets: counts, count, sum };
    } else {
      const scalar = series.samples.get("value");
      if (scalar === undefined || series.samples.size !== 1) throw new Error("invalid scalar");
      value = scalar;
    }
    if (series.labels.actor_name !== undefined) {
      const name = series.labels.actor_name;
      series.labels.actor_name = /^(?:Installation|installation-[0-9a-f]{8})$/u.test(name) ? "installation" : /^(?:ObservationStore|observation-store-[0-9a-f]{8})$/u.test(name) ? "observation-store" : /^(?:MetricStore|metric-store-[0-9a-f]{8})$/u.test(name) ? "metric-store" : name.startsWith("openorange:cron@") ? "cron" : "other";
    }
    const entries = values[family] ??= [];
    const existing = entries.find(([labels]) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(series.labels).sort(([a], [b]) => a.localeCompare(b))));
    if (!existing) entries.push([series.labels, value]);
    else if (typeof value === "string" && typeof existing[1] === "string") {
      if (spec.form !== "u64") throw new Error("unsupported aggregate");
      const a = BigInt(existing[1]), b = BigInt(value);
      existing[1] = (spec.type === "gauge" ? (a > b ? a : b) : a + b).toString();
      if (!isU64(existing[1])) throw new Error("aggregate overflow");
    } else if (typeof value !== "string" && typeof existing[1] !== "string") {
      const old = existing[1];
      const buckets = value.buckets.map((count, index) => (BigInt(count) + BigInt(old.buckets[index]!)).toString());
      const count = (BigInt(value.count) + BigInt(old.count)).toString();
      if (!buckets.every(isU64) || !isU64(count)) throw new Error("aggregate overflow");
      existing[1] = { buckets, count, sum: addDecimal(old.sum, value.sum) };
    } else throw new Error("invalid aggregate");
  }
  return { values, dropped };
}
