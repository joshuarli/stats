import { RELEASE } from "../observe/ingest/model.ts";

type Check = { readonly status: "ok" | "degraded" | "down"; readonly ms?: number; readonly detail?: string };
type HealthBody = { readonly status: "ok" | "degraded" | "down"; readonly service: "stats"; readonly release?: string; readonly checks: Record<string, Check> };

export function createStatsHealth(options: { readonly installation: (request: Request) => Promise<Response>; readonly metrics?: (request: Request) => Promise<Response>; readonly metricsAvailable: boolean; readonly release?: string | undefined; readonly now?: () => number }): () => Promise<Response> {
  if (options.release !== undefined && !RELEASE.test(options.release)) throw new Error("invalid health release");
  const now = options.now ?? Date.now;
  let started = -Infinity;
  let current: Promise<HealthBody> | undefined;
  let settled = false;
  const check = async (run: () => Promise<Check>): Promise<Check> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([run(), new Promise<Check>(resolve => { timer = setTimeout(() => resolve({ status: "down", detail: "timeout" }), 500); })]);
      return result;
    } catch { return { status: "down", detail: "unavailable" }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const compute = async (): Promise<HealthBody> => {
    let lastRound: number | null = null;
    const [installation, metrics] = await Promise.all([
      check(async () => {
        const response = await options.installation(new Request("https://installation/health"));
        if (!response.ok) return { status: "down", detail: "unavailable" };
        const value = await response.json() as { lastRoundAtMs?: unknown };
        if (value.lastRoundAtMs !== null && (typeof value.lastRoundAtMs !== "number" || !Number.isSafeInteger(value.lastRoundAtMs))) return { status: "down", detail: "invalid response" };
        lastRound = value.lastRoundAtMs as number | null;
        return { status: "ok" };
      }),
      check(async () => {
        if (!options.metricsAvailable) return { status: "ok" };
        if (options.metrics === undefined) return { status: "down", detail: "unavailable" };
        const response = await options.metrics(new Request("https://metrics/health"));
        return response.ok ? { status: "ok" } : { status: "down", detail: "unavailable" };
      })
    ]);
    const probes: Check = lastRound === null || now() - lastRound > 180_000 ? { status: "degraded", detail: "probe round stale" } : { status: "ok" };
    const checks = { installation, metrics, probes };
    const overall = Object.values(checks).some(value => value.status === "down") ? "down" : probes.status === "degraded" ? "degraded" : "ok";
    return { status: overall, service: "stats", ...(options.release === undefined ? {} : { release: options.release }), checks };
  };
  return async () => {
    if (current === undefined || now() - started >= 1000 && settled) {
      started = now();
      settled = false;
      current = compute().finally(() => { settled = true; });
    }
    const body = await current;
    return Response.json(body, { status: body.status === "down" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  };
}
