import * as vitest from "vitest";
import { HISTORY_CONTENT_TYPE, openHistory } from "../src/binary/history.ts";
import {
  ApiFailure,
  CONDITIONAL_CACHE_LIMIT,
  CONDITIONAL_CACHE_MAX_BYTES,
  ConditionalCache,
  getFleetHistories,
  getHistory,
  getHostHistories,
  getProjectHistories,
  getSummary,
  openHistoryFrame,
  resetHistoryCaches
} from "../src/client/api.ts";
import { alignTracks, sumTracks, windowTracks, worstTrack } from "../src/client/chart-data.ts";
import { decodeHostHistories, decodeSummary, type SummaryHistory } from "../src/client/history.ts";
import { encodeHistory } from "./support/history.ts";

function check(condition: boolean, message = "assertion failed"): void {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message = "values differ"): void {
  if (!same(actual, expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => same(item, right[index]));
  }
  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      same(leftKeys, rightKeys) &&
      leftKeys.every(key =>
        same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
      )
    );
  }
  return false;
}

async function rejectsApiFailure(
  action: () => Promise<unknown>,
  expectedStatus?: number,
  expectedSubstring?: string
): Promise<ApiFailure> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof ApiFailure)) {
    throw new Error(`expected ApiFailure, got ${String(caught)}`);
  }
  if (expectedStatus !== undefined && caught.status !== expectedStatus) {
    throw new Error(`expected status ${expectedStatus}, got ${caught.status}`);
  }
  if (expectedSubstring !== undefined && !caught.message.includes(expectedSubstring)) {
    throw new Error(`expected message containing "${expectedSubstring}", got "${caught.message}"`);
  }
  return caught;
}

interface SummarySpec {
  readonly hostId?: string;
  readonly range?: "1h" | "6h" | "24h" | "7d" | "30d";
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly resolution?: "raw" | "1m" | "1h";
  readonly stepMs?: number;
  readonly points: readonly Record<string, unknown>[];
}

function makeSummaryBytes(spec: SummarySpec): Uint8Array<ArrayBuffer> {
  return encodeHistory({
    hostId: spec.hostId ?? "h_0123456789abcdef0123456789abcdef",
    ...(spec.range === undefined ? { range: "1h" } : { range: spec.range }),
    fromMs: spec.fromMs ?? 0,
    toMs: spec.toMs ?? 60_000,
    resolution: spec.resolution ?? "raw",
    stepMs: spec.stepMs ?? 15_000,
    kind: "summary",
    points: spec.points
  });
}

function makeHostBundleBytes(hostId: string, cpuUser: number): Uint8Array<ArrayBuffer> {
  const base = {
    hostId,
    range: "1h",
    fromMs: 0,
    toMs: 30_000,
    resolution: "raw",
    stepMs: 15_000
  };
  return encodeHistory({
    hostId,
    histories: {
      summary: {
        ...base,
        kind: "summary",
        points: [
          { atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: cpuUser, system: 2, idle: 90 } },
          { atMs: 30_000, coverageMs: 15_000, partial: false, cpu: { user: cpuUser + 1, system: 3, idle: 88 } }
        ]
      },
      disks: {
        ...base,
        kind: "disks",
        series: [{
          id: "nvme0n1",
          points: [
            { atMs: 15_000, readBytesPerSec: 100, writeBytesPerSec: 200, readsPerSec: 1, writesPerSec: 2 },
            { atMs: 30_000, readBytesPerSec: 150, writeBytesPerSec: 250, readsPerSec: 2, writesPerSec: 3 }
          ]
        }]
      },
      nets: {
        ...base,
        kind: "nets",
        series: [{
          id: "eth0",
          points: [
            {
              atMs: 15_000,
              rxBytesPerSec: 50,
              txBytesPerSec: 60,
              rxPacketsPerSec: 5,
              txPacketsPerSec: 6,
              rxDropsPerSec: 0,
              rxErrorsPerSec: 0,
              txErrorsPerSec: 0
            }
          ]
        }]
      },
      filesystems: {
        ...base,
        kind: "filesystems",
        series: [{
          id: "/",
          points: [{ atMs: 15_000, total: 1_000, available: 400 }]
        }]
      },
      block: {
        ...base,
        kind: "block",
        series: [{
          id: "nvme0n1",
          points: [{ atMs: 15_000, count: 10, totalUs: 100, minUs: 5, maxUs: 25, p50Us: 10, p95Us: 20, p99Us: 25 }]
        }]
      }
    }
  });
}

function makeProjectBundleBytes(projectId: string, requestsValue: number): Uint8Array<ArrayBuffer> {
  const base = {
    projectId,
    range: "1h",
    fromMs: 0,
    toMs: 300_000,
    stepMs: 300_000
  };
  return encodeHistory({
    projectId,
    histories: {
      worker: { ...base, kind: "worker", series: [{ metric: "requests", values: [requestsValue] }] },
      routes: { ...base, kind: "routes", series: [{ metric: "GET /", values: [requestsValue] }] },
      r2: { ...base, kind: "r2", series: [{ metric: "a", values: [1] }] },
      collector: { ...base, kind: "collector", runs: [{ atMs: 300_000, ok: true, detail: "ok", rowsRead: 4, durationMs: 12 }] }
    }
  });
}

function historyResponse(bytes: Uint8Array<ArrayBuffer>, etag?: string, status = 200): Response {
  const headers = new Headers({ "content-type": HISTORY_CONTENT_TYPE });
  if (etag !== undefined) headers.set("etag", etag);
  return new Response(bytes, { status, headers });
}

interface RecordedRequest {
  readonly url: string;
  readonly ifNoneMatch: string | null;
  readonly signal: AbortSignal;
}

async function withStubbedFetch<T>(
  handler: (request: RecordedRequest) => Promise<Response> | Response,
  run: (requests: readonly RecordedRequest[]) => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const recorded: RecordedRequest[] = [];
  const originalConsoleError = console.error;
  console.error = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? new AbortController().signal;
    if (signal.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const entry: RecordedRequest = {
      url,
      ifNoneMatch: headers.get("If-None-Match"),
      signal
    };
    recorded.push(entry);
    return await handler(entry);
  }) as typeof fetch;
  try {
    resetHistoryCaches();
    return await run(recorded);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    resetHistoryCaches();
  }
}

const cases: readonly (readonly [string, () => Promise<void>])[] = [
  [
    "200 then 304 reuses the cached value and touches recency",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>(2, CONDITIONAL_CACHE_MAX_BYTES);
      const frameA = makeSummaryBytes({
        hostId: "host-a",
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 10, system: 2, idle: 88 } }]
      });
      const frameB = makeSummaryBytes({
        hostId: "host-b",
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 20, system: 3, idle: 77 } }]
      });
      const frameC = makeSummaryBytes({
        hostId: "host-c",
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 30, system: 4, idle: 66 } }]
      });

      await withStubbedFetch(
        req => {
          if (req.url === "/a") {
            return req.ifNoneMatch === "\"a-1\""
              ? new Response(null, { status: 304, headers: { etag: "\"a-1\"" } })
              : historyResponse(frameA, "\"a-1\"");
          }
          if (req.url === "/b") return historyResponse(frameB, "\"b-1\"");
          return historyResponse(frameC, "\"c-1\"");
        },
        async requests => {
          const signal = new AbortController().signal;
          const firstA = await getHistory("/a", decodeSummary, cache, signal);
          const firstB = await getHistory("/b", decodeSummary, cache, signal);
          check(firstB.hostId === "host-b", "expected host-b");
          const secondA = await getHistory("/a", decodeSummary, cache, signal);
          check(secondA === firstA, "expected 304 to return the exact cached instance");
          equal(requests[2]?.ifNoneMatch, "\"a-1\"", "expected If-None-Match header on second /a");

          await getHistory("/c", decodeSummary, cache, signal);
          check(cache.size === 2, "expected cache size to stay capped at 2");
          check(cache.peek("/a") !== undefined, "expected /a to survive eviction after 304 touched recency");
          check(cache.peek("/b") === undefined, "expected /b to be evicted as the oldest entry");
        }
      );
    }
  ],
  [
    "changed ETag replaces cached entry and 304 with mismatched ETag retries without If-None-Match",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>();
      const v1 = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 12, system: 3, idle: 85 } }]
      });
      const v2 = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 42, system: 8, idle: 50 } }]
      });
      const v3 = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 65, system: 5, idle: 30 } }]
      });
      let step = 0;

      await withStubbedFetch(
        req => {
          step += 1;
          if (step === 1) return historyResponse(v1, "\"v1\"");
          if (step === 2) {
            check(req.ifNoneMatch === "\"v1\"", "expected If-None-Match v1 on step 2");
            return historyResponse(v2, "\"v2\"");
          }
          if (step === 3) {
            check(req.ifNoneMatch === "\"v2\"", "expected If-None-Match v2 on step 3");
            return new Response(null, { status: 304, headers: { etag: "\"v3\"" } });
          }
          check(req.ifNoneMatch === null, "expected retry after mismatched 304 ETag to omit If-None-Match");
          return historyResponse(v3, "\"v3\"");
        },
        async requests => {
          const signal = new AbortController().signal;
          const first = await getHistory("/host", decodeSummary, cache, signal);
          equal(first.table.cells("cpu.user"), [12]);

          const second = await getHistory("/host", decodeSummary, cache, signal);
          equal(second.table.cells("cpu.user"), [42]);
          equal(cache.peek("/host")?.etag, "\"v2\"");

          const third = await getHistory("/host", decodeSummary, cache, signal);
          equal(third.table.cells("cpu.user"), [65]);
          equal(cache.peek("/host")?.etag, "\"v3\"");
          equal(requests.length, 4, "expected 4 requests including the mismatched-ETag retry");
        }
      );
    }
  ],
  [
    "missing ETag does not cache and malformed frame is a contract failure that installs nothing",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>();
      const valid = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 15, system: 5, idle: 80 } }]
      });
      const malformed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      let mode: "no-etag" | "malformed" | "valid" = "no-etag";

      await withStubbedFetch(
        () => {
          if (mode === "no-etag") return historyResponse(valid);
          if (mode === "malformed") return historyResponse(malformed, "\"bad\"");
          return historyResponse(valid, "\"good\"");
        },
        async requests => {
          const signal = new AbortController().signal;
          const uncached = await getHistory("/path", decodeSummary, cache, signal);
          equal(uncached.table.cells("cpu.user"), [15]);
          equal(cache.size, 0, "expected missing ETag response not to cache");

          mode = "malformed";
          await rejectsApiFailure(
            () => getHistory("/path", decodeSummary, cache, signal),
            0,
            "did not match the telemetry contract"
          );
          equal(cache.size, 0, "expected malformed frame not to install in cache");

          mode = "valid";
          const cached = await getHistory("/path", decodeSummary, cache, signal);
          equal(cached.table.cells("cpu.user"), [15]);
          equal(cache.size, 1, "expected valid response with ETag to cache");

          mode = "malformed";
          await rejectsApiFailure(
            () => getHistory("/path", decodeSummary, cache, signal),
            0,
            "did not match the telemetry contract"
          );
          equal(cache.peek("/path")?.etag, "\"good\"", "expected failed refresh decode to preserve prior cached entry");
          equal(requests.at(-1)?.ifNoneMatch, "\"good\"");
        }
      );
    }
  ],
  [
    "304 with no cached value fails with ApiFailure",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>();
      await withStubbedFetch(
        () => new Response(null, { status: 304, headers: { etag: "\"orphan\"" } }),
        async () => {
          await rejectsApiFailure(
            () => getHistory("/uncached", decodeSummary, cache, new AbortController().signal),
            0,
            "no cached copy exists"
          );
          equal(cache.size, 0);
        }
      );
    }
  ],
  [
    "concurrent requests install only the newest-started response and an older response cannot overwrite a newer entry",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>();
      const olderBytes = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 11, system: 2, idle: 87 } }]
      });
      const newerBytes = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 99, system: 1, idle: 0 } }]
      });
      const gates: (() => void)[] = [];

      await withStubbedFetch(
        req =>
          new Promise<Response>(resolve => {
            const index = gates.length;
            gates.push(() => {
              if (index === 0) resolve(historyResponse(olderBytes, "\"older\""));
              else if (index === 1) resolve(historyResponse(newerBytes, "\"newer\""));
              else {
                check(req.ifNoneMatch === "\"newer\"", "expected subsequent request to send newer ETag");
                resolve(new Response(null, { status: 304, headers: { etag: "\"newer\"" } }));
              }
            });
          }),
        async () => {
          const signal = new AbortController().signal;
          const firstPromise = getHistory("/race", decodeSummary, cache, signal);
          const secondPromise = getHistory("/race", decodeSummary, cache, signal);
          equal(gates.length, 2, "expected both concurrent requests in flight");

          gates[1]!();
          const secondResult = await secondPromise;
          equal(secondResult.table.cells("cpu.user"), [99]);
          equal(cache.peek("/race")?.etag, "\"newer\"");

          gates[0]!();
          const firstResult = await firstPromise;
          equal(firstResult.table.cells("cpu.user"), [11]);
          equal(cache.peek("/race")?.etag, "\"newer\"", "older response must not replace newer cached entry");

          const thirdPromise = getHistory("/race", decodeSummary, cache, signal);
          gates[2]!();
          const thirdResult = await thirdPromise;
          check(thirdResult === secondResult, "expected 304 to reuse the newer cached entry");
        }
      );
    }
  ],
  [
    "abort before body or while reading body installs nothing",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>();
      const bytes = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 25, system: 5, idle: 70 } }]
      });
      let controller2: AbortController | undefined;

      await withStubbedFetch(
        req => {
          if (req.url === "/abort-fetch") {
            return new Promise<Response>((_, reject) => {
              if (req.signal.aborted) {
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              req.signal.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            });
          }
          const response = historyResponse(bytes, "\"aborted-body\"");
          Object.defineProperty(response, "arrayBuffer", {
            value: () =>
              new Promise<ArrayBuffer>((_, reject) => {
                controller2?.abort();
                reject(new DOMException("Aborted", "AbortError"));
              })
          });
          return response;
        },
        async () => {
          const controller1 = new AbortController();
          const pending1 = getHistory("/abort-fetch", decodeSummary, cache, controller1.signal);
          controller1.abort();
          await rejectsApiFailure(() => pending1, 0, "cancelled");
          equal(cache.size, 0, "expected abort during fetch not to cache");

          controller2 = new AbortController();
          const pending2 = getHistory("/abort-body", decodeSummary, cache, controller2.signal);
          await rejectsApiFailure(() => pending2, 0);
          equal(cache.size, 0, "expected abort during body read not to cache");
        }
      );
    }
  ],
  [
    "settled, failed, and evicted requests leave no per-path request sequence behind",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>(4);
      const frame = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 5, system: 1, idle: 94 } }]
      });
      await withStubbedFetch(
        req => req.url.includes("fail") ? new Response("no", { status: 500 }) : historyResponse(frame, `"etag-${req.url}"`),
        async () => {
          const signal = new AbortController().signal;
          for (let index = 0; index < 40; index += 1) {
            await getHistory(`/window-${index}`, decodeSummary, cache, signal);
            await rejectsApiFailure(() => getHistory(`/fail-${index}`, decodeSummary, cache, signal), 500);
          }
          equal(cache.size, 4);
          equal(cache.pending, 0, "expected no request sequence to outlive its request");
        }
      );
    }
  ],
  [
    "entry limit evicts the 33rd oldest entry while keeping the 32 newest",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>();
      equal(cache.maxEntries, CONDITIONAL_CACHE_LIMIT);
      const frame = makeSummaryBytes({
        points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 5, system: 1, idle: 94 } }]
      });

      await withStubbedFetch(
        req => historyResponse(frame, `"etag-${req.url}"`),
        async () => {
          const signal = new AbortController().signal;
          for (let index = 0; index < CONDITIONAL_CACHE_LIMIT + 1; index += 1) {
            await getHistory(`/entry-${index}`, decodeSummary, cache, signal);
          }
          equal(cache.size, CONDITIONAL_CACHE_LIMIT, "expected cache size to cap at 32");
          check(cache.peek("/entry-0") === undefined, "expected oldest entry-0 to be evicted");
          for (let index = 1; index <= CONDITIONAL_CACHE_LIMIT; index += 1) {
            check(cache.peek(`/entry-${index}`) !== undefined, `expected /entry-${index} to remain cached`);
          }
        }
      );
    }
  ],
  [
    "byte-budget eviction bounds retained bytes and doubles unaligned zeroCopy:false frames",
    async () => {
      const points = Array.from({ length: 2_000 }, (_, row) => ({
        atMs: (row + 1) * 15_000,
        coverageMs: 15_000,
        partial: false,
        cpu: { user: (row % 50) + 0.25, system: 3.5, idle: 40.25, iowait: 0.5, steal: 0.1 },
        load: { one: 1.1, five: 1.2, fifteen: 1.3 },
        mem: { total: 64_000_000_000, available: 32_000_000_000 - row * 1000, swapUsed: 0 }
      }));
      const largeFrame = makeSummaryBytes({ points });
      check(largeFrame.byteLength > 100_000, `expected synthetic frame > 100 KB, got ${largeFrame.byteLength}`);

      const alignedOpened = openHistoryFrame(largeFrame, decodeSummary);
      equal(alignedOpened.retainedBytes, largeFrame.byteLength, "expected aligned frame to retain 1x byteLength");

      const unalignedBacking = new Uint8Array(largeFrame.byteLength + 1);
      unalignedBacking.set(largeFrame, 1);
      const unalignedView = unalignedBacking.subarray(1);
      const unalignedOpened = openHistoryFrame(unalignedView, decodeSummary);
      equal(
        unalignedOpened.retainedBytes,
        largeFrame.byteLength * 2,
        "expected unaligned zeroCopy:false frame to count 2x byteLength"
      );

      const budget = largeFrame.byteLength * 2 + 64;
      const boundedCache = new ConditionalCache<SummaryHistory>(CONDITIONAL_CACHE_LIMIT, budget);

      await withStubbedFetch(
        req => {
          if (req.url === "/unaligned") {
            const response = historyResponse(largeFrame, "\"u-1\"");
            Object.defineProperty(response, "arrayBuffer", {
              value: async () => unalignedView as unknown as ArrayBuffer
            });
            return response;
          }
          return historyResponse(largeFrame, `"etag-${req.url}"`);
        },
        async () => {
          const signal = new AbortController().signal;
          await getHistory("/large-1", decodeSummary, boundedCache, signal);
          await getHistory("/large-2", decodeSummary, boundedCache, signal);
          equal(boundedCache.size, 2);
          equal(boundedCache.bytes, largeFrame.byteLength * 2);

          await getHistory("/large-3", decodeSummary, boundedCache, signal);
          equal(boundedCache.size, 2, "expected 3rd large frame to evict oldest under byte budget");
          check(boundedCache.bytes <= budget, "expected cache bytes within budget");
          check(boundedCache.peek("/large-1") === undefined, "expected /large-1 to be evicted by byte budget");
          check(boundedCache.peek("/large-2") !== undefined, "expected /large-2 to remain");
          check(boundedCache.peek("/large-3") !== undefined, "expected /large-3 to remain");

          await getHistory("/unaligned", decodeSummary, boundedCache, signal);
          equal(boundedCache.size, 1, "expected 2x unaligned frame to evict both prior 1x frames");
          equal(boundedCache.bytes, largeFrame.byteLength * 2);
          check(boundedCache.peek("/unaligned") !== undefined);
        }
      );
    }
  ],
  [
    "8 MiB default byte budget evicts large synthetic histories well before 32 entries",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>();
      equal(cache.maxBytes, CONDITIONAL_CACHE_MAX_BYTES);
      const points = Array.from({ length: 8_000 }, (_, row) => ({
        atMs: (row + 1) * 15_000,
        coverageMs: 15_000,
        partial: false,
        cpu: { user: (row % 80) + 0.125, system: 4.25, idle: 15.625, iowait: 0.5, steal: 0.25 },
        load: { one: 2.1, five: 2.2, fifteen: 2.3 },
        mem: {
          total: 128_000_000_000,
          available: 64_000_000_000 - row * 500,
          swapUsed: 1024,
          swapInBytesPerSec: 12,
          swapOutBytesPerSec: 34,
          pressure: { warnPct: 10, criticalPct: 2 }
        },
        psi: {
          cpu: { some10: 1.1, some60: 1.2, some300: 1.3, full10: 0.1, full60: 0.2, full300: 0.3 },
          memory: { some10: 0.4, some60: 0.5, some300: 0.6, full10: 0.1, full60: 0.1, full300: 0.1 },
          io: { some10: 2.1, some60: 2.2, some300: 2.3, full10: 0.5, full60: 0.6, full300: 0.7 }
        }
      }));
      const bigFrame = makeSummaryBytes({ points });
      const maxFit = Math.floor(CONDITIONAL_CACHE_MAX_BYTES / bigFrame.byteLength);
      check(maxFit >= 1 && maxFit < CONDITIONAL_CACHE_LIMIT, `expected 1 <= maxFit < 32, got ${maxFit}`);

      await withStubbedFetch(
        req => historyResponse(bigFrame, `"big-${req.url}"`),
        async () => {
          const signal = new AbortController().signal;
          const totalRequests = maxFit + 2;
          for (let index = 0; index < totalRequests; index += 1) {
            const decoded = await getHistory(`/big-${index}`, decodeSummary, cache, signal);
            equal(decoded.table.rows, 8_000);
          }
          equal(cache.size, maxFit, "expected cache entry count capped by 8 MiB budget");
          check(cache.bytes <= CONDITIONAL_CACHE_MAX_BYTES, "expected retained bytes <= 8 MiB");
          check(cache.peek("/big-0") === undefined, "expected first big frame evicted");
          check(cache.peek(`/big-${totalRequests - 1}`) !== undefined, "expected latest big frame retained");
        }
      );
    }
  ],
  [
    "distinct hosts, ranges, windows, resolutions, and path spellings never collide and fresh caches start empty",
    async () => {
      const fresh = new ConditionalCache<SummaryHistory>();
      equal(fresh.size, 0);
      equal(fresh.bytes, 0);

      await withStubbedFetch(
        req => {
          if (req.url.includes("/projects/")) {
            const isD1 = req.url.includes("d1");
            return historyResponse(makeProjectBundleBytes("proj-a", isD1 ? 200 : 100), `"etag-${req.url}"`);
          }
          if (req.url.includes("kinds=summary,disks,nets,filesystems,block")) {
            return historyResponse(makeHostBundleBytes("host-a", 55), `"etag-${req.url}"`);
          }
          if (req.url.includes("kinds=summary,disks,nets,filesystems")) {
            return historyResponse(makeHostBundleBytes("host-a", 44), `"etag-${req.url}"`);
          }
          const marker = req.url.includes("host-b")
            ? 30
            : req.url.includes("range=6h")
              ? 20
              : req.url.includes("to=120000")
                ? 15
                : 10;
          return historyResponse(
            makeSummaryBytes({
              hostId: req.url.includes("host-b") ? "host-b" : "host-a",
              ...(req.url.includes("range=6h") ? { range: "6h", resolution: "1m", stepMs: 60_000 } : {}),
              fromMs: 0,
              toMs: req.url.includes("to=120000") ? 120_000 : 60_000,
              points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: marker, system: 1, idle: 50 } }]
            }),
            `"etag-${req.url}"`
          );
        },
        async requests => {
          const signal = new AbortController().signal;
          const sumA1h = await getSummary("host-a", { range: "1h" }, signal);
          const sumA6h = await getSummary("host-a", { range: "6h" }, signal);
          const sumB1h = await getSummary("host-b", { range: "1h" }, signal);
          const sumWin1 = await getSummary("host-a", { fromMs: 0, toMs: 60_000 }, signal);
          const sumWin2 = await getSummary("host-a", { fromMs: 0, toMs: 120_000 }, signal);
          const fleetA = await getFleetHistories("host-a", { range: "1h" }, signal);
          const hostA = await getHostHistories("host-a", { range: "1h" }, signal);
          const projBase = await getProjectHistories(
            "proj-a",
            { range: "1h" },
            { durableObjects: false, d1: false, probes: false },
            signal
          );
          const projD1 = await getProjectHistories(
            "proj-a",
            { range: "1h" },
            { durableObjects: false, d1: true, probes: false },
            signal
          );

          equal(sumA1h.table.cells("cpu.user"), [10]);
          equal(sumA6h.table.cells("cpu.user"), [20]);
          equal(sumB1h.table.cells("cpu.user"), [30]);
          equal(sumWin1.table.cells("cpu.user"), [10]);
          equal(sumWin2.table.cells("cpu.user"), [15]);
          equal(fleetA.summary.table.cells("cpu.user"), [44, 45]);
          equal(hostA.summary.table.cells("cpu.user"), [55, 56]);
          equal(projBase.worker.table.cells("requests"), [100]);
          equal(projD1.worker.table.cells("requests"), [200]);
          check(
            requests.every(req => req.ifNoneMatch === null),
            "expected every distinct key to miss on first request"
          );
        }
      );
    }
  ],
  [
    "exact values and missing cells survive a 304 and chart derivations do not mutate cached cells or time axis",
    async () => {
      const cache = new ConditionalCache<SummaryHistory>();
      const bytes = makeSummaryBytes({
        points: [
          {
            atMs: 15_000,
            coverageMs: 15_000,
            partial: false,
            cpu: { user: 0, system: 12.345678, idle: 87.654322 },
            mem: { total: 1_000, available: 250, swapUsed: 0 }
          },
          {
            atMs: 30_000,
            coverageMs: 15_000,
            partial: true
          },
          {
            atMs: 60_000,
            coverageMs: 15_000,
            partial: false,
            cpu: { user: 33.5, system: 6.5, idle: 60 },
            mem: { total: 1_000, available: 500, swapUsed: 0 }
          }
        ]
      });

      await withStubbedFetch(
        req =>
          req.ifNoneMatch === "\"exact-1\""
            ? new Response(null, { status: 304, headers: { etag: "\"exact-1\"" } })
            : historyResponse(bytes, "\"exact-1\""),
        async () => {
          const signal = new AbortController().signal;
          const initial = await getHistory("/exact", decodeSummary, cache, signal);
          equal(initial.table.times, [15_000, 30_000, 60_000]);
          equal(initial.table.cells("cpu.user"), [0, null, 33.5]);
          equal(initial.table.cells("cpu.system"), [12.345678, null, 6.5]);
          equal(initial.table.at("cpu.user", 1), undefined);
          equal(initial.table.cells("psi.cpu.some10"), [null, null, null]);

          const derivedCpu = initial.table.derived("cpuUsed", table => {
            const user = table.cells("cpu.user");
            const system = table.cells("cpu.system");
            return user.map((u, idx) => (u === null || system[idx] === null ? null : u + system[idx]!));
          });
          const derivedMem = initial.table.derived("memoryUsed", table => {
            const total = table.cells("mem.total");
            const avail = table.cells("mem.available");
            return total.map((t, idx) => (t === null || avail[idx] === null ? null : ((t - avail[idx]!) / t) * 100));
          });
          equal(derivedCpu, [12.345678, null, 40]);
          equal(derivedMem, [75, null, 50]);

          const aligned = alignTracks([initial.table.track("cpu.user"), initial.table.track("cpu.system")], 15_000);
          equal(aligned.times, [15_000, 30_000, 45_000, 60_000]);
          equal(aligned.columns[0], [0, null, null, 33.5]);

          const summed = sumTracks([initial.table.track("cpu.user"), initial.table.track("cpu.system")]);
          equal(summed.values, [12.345678, null, 40]);

          const worst = worstTrack([initial.table.track("cpu.user"), initial.table.track("cpu.system")], 15_000);
          equal(worst.values, [12.345678, null, null, 33.5]);

          const windowed = windowTracks([initial.table.track("cpu.user")], { fromMs: 15_000, toMs: 30_000 });
          equal(windowed[0]?.times, [15_000, 30_000]);
          equal(windowed[0]?.values, [0, null]);

          const revalidated = await getHistory("/exact", decodeSummary, cache, signal);
          check(revalidated === initial, "expected 304 to reuse cached SummaryHistory");
          equal(revalidated.table.times, [15_000, 30_000, 60_000], "expected cached time axis untouched");
          equal(revalidated.table.cells("cpu.user"), [0, null, 33.5], "expected cached cpu.user cells untouched");
          equal(revalidated.table.cells("cpu.system"), [12.345678, null, 6.5], "expected cached cpu.system cells untouched");
          equal(
            revalidated.table.derived("cpuUsed", () => [0, 0, 0]),
            [12.345678, null, 40],
            "expected cached derived cpuUsed untouched"
          );
        }
      );
    }
  ],
  [
    "decodeHostHistories traverses filesystems once",
    async () => {
      const root = openHistory(makeHostBundleBytes("host-a", 10)).root;
      check(root.form === "bundle", "expected bundle root");
      if (root.form !== "bundle") return;
      let filesystemReads = 0;
      const entries = root.entries.map(item =>
        item.name === "filesystems"
          ? {
              get name(): string {
                return "filesystems";
              },
              get history() {
                filesystemReads += 1;
                return item.history;
              }
            }
          : item
      );
      const decoded = decodeHostHistories({ ...root, entries });
      equal(filesystemReads, 1, "expected filesystems entry to be decoded once");
      equal(decoded.filesystems.series[0]?.table.cells("total"), [1_000]);
      equal(decoded.block.series[0]?.table.cells("p50Us"), [10]);
    }
  ]
];

async function executeSuite(): Promise<void> {
  if ("__vitest_worker__" in globalThis) {
    const suite = vitest.describe;
    const step = vitest.it;
    suite("client history cache", () => {
      for (const [title, run] of cases) {
        step(title, run);
      }
    });
    return;
  }
  for (const [, run] of cases) {
    await run();
  }
}

await executeSuite();
