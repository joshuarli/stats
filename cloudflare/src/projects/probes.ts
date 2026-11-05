import type { ProbeConfig } from "./config.ts";
import type { MetricPoint } from "./metrics.ts";
import { BUCKET_MS } from "./queries.ts";

const PROBE_TIMEOUT_MS = 10_000;

export type ProbeFetch = (url: string, init: { readonly method: "GET"; readonly redirect: "manual"; readonly signal: AbortSignal }) => Promise<{
  readonly status: number;
  readonly body: { cancel(): Promise<void> } | null;
}>;

interface ProbeInput {
  readonly fetch: ProbeFetch;
  readonly probes: readonly ProbeConfig[];
  readonly now: number;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
}

export function isUp(status: number): boolean {
  return status >= 200 && status <= 399;
}

export async function runProbes(input: ProbeInput): Promise<MetricPoint[]> {
  const bucketMs = Math.floor(input.now / BUCKET_MS) * BUCKET_MS;
  const clock = input.clock ?? Date.now;
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const results = await Promise.all(
    input.probes.map(async (probe) => {
      const startedAt = clock();
      let up = false;
      try {
        const response = await input.fetch(probe.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        up = isUp(response.status);
        await response.body?.cancel();
      } catch {
        up = false;
      }
      const elapsedMs = Math.max(0, clock() - startedAt);
      return [
        { metric: `probe.${probe.name}.up`, bucketMs, value: up ? 1 : 0 },
        { metric: `probe.${probe.name}.ms`, bucketMs, value: elapsedMs },
      ];
    }),
  );
  return results.flat();
}
