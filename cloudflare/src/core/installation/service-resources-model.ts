export type ResourceResolution = "1m" | "1h";

export interface ResourceWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly resolution: ResourceResolution;
}

export interface ResourcePoint {
  readonly atMs: number;
  readonly cpuCores: number | null;
  readonly memoryBytes: number | null;
  readonly ioBytesPerSec: number | null;
}

export interface ServiceResources {
  readonly name: string;
  readonly points: readonly ResourcePoint[];
}

export interface HostServiceResources extends ResourceWindow {
  readonly hostId: string;
  readonly services: readonly ServiceResources[];
}

function finiteOrNull(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid resource level");
  return value;
}

function safeTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid resource time");
  return value;
}

export function decodeHostServiceResources(value: unknown): HostServiceResources {
  if (typeof value !== "object" || value === null) throw new Error("invalid service resources");
  const item = value as Record<string, unknown>;
  if (typeof item["hostId"] !== "string" || (item["resolution"] !== "1m" && item["resolution"] !== "1h") || !Array.isArray(item["services"])) throw new Error("invalid service resources");
  const services = item["services"].map((raw: unknown): ServiceResources => {
    const service = raw as Record<string, unknown>;
    if (typeof service["name"] !== "string" || !Array.isArray(service["points"])) throw new Error("invalid service resource series");
    return {
      name: service["name"],
      points: service["points"].map((point: Record<string, unknown>) => ({ atMs: safeTime(point["atMs"]), cpuCores: finiteOrNull(point["cpuCores"]), memoryBytes: finiteOrNull(point["memoryBytes"]), ioBytesPerSec: finiteOrNull(point["ioBytesPerSec"]) }))
    };
  });
  return { hostId: item["hostId"], fromMs: safeTime(item["fromMs"]), toMs: safeTime(item["toMs"]), stepMs: safeTime(item["stepMs"]), resolution: item["resolution"], services };
}
