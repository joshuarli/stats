export interface HealthBar {
  readonly atMs: number;
  readonly probes: number;
  readonly up: number;
  readonly meanMs: number | null;
}

export interface ServiceHealthHistory {
  readonly service: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly bars: readonly HealthBar[];
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid health count");
  return value;
}

export function decodeServiceHealthHistory(value: unknown, service: string): ServiceHealthHistory {
  if (typeof value !== "object" || value === null) throw new Error("invalid service health");
  const item = value as Record<string, unknown>;
  if (item["service"] !== service || !Array.isArray(item["bars"])) throw new Error("service health mismatch");
  const bars = item["bars"].map((raw: unknown): HealthBar => {
    const bar = raw as Record<string, unknown>;
    const probes = count(bar["probes"]);
    const up = count(bar["up"]);
    if (up > probes) throw new Error("invalid health bar");
    const meanMs = bar["meanMs"];
    if (meanMs !== null && (typeof meanMs !== "number" || !Number.isFinite(meanMs) || meanMs < 0)) throw new Error("invalid health latency");
    return { atMs: count(bar["atMs"]), probes, up, meanMs };
  });
  return { service, fromMs: count(item["fromMs"]), toMs: count(item["toMs"]), stepMs: count(item["stepMs"]), bars };
}
