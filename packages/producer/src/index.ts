import {
  encodeBatch, ERROR_CODE, EVENT_ID, HOST, INSTANCE, MAX_BATCH_BYTES, MAX_DURATION_MS, MAX_EVENTS, OPERATION, OUTCOME, RELEASE, SERVICE, SUCCESS_OUTCOME, TRACE_ID, SPAN_ID,
  workOf, type OperationEvent, type Trace
} from "./protocol.ts";

export type { EventError, OperationEvent, Trace } from "./protocol.ts";
export { MAX_BATCH_BYTES, MAX_EVENTS, SCHEMA_VERSION } from "./protocol.ts";

const MAX_ACK_BYTES = 4096;
const DEFAULT_QUEUE_LIMIT = 256;
const MAX_QUEUE_LIMIT = 256;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

export interface ProducerConfig {
  readonly endpoint: string;
  readonly service: string;
  readonly token: string | (() => string);
  readonly release: string;
  readonly instance?: string;
  readonly host?: string;
  readonly queueLimit?: number;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly fetch?: typeof fetch;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly newEventId?: () => string;
}

export interface OperationInput {
  readonly operation: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly work?: Readonly<Record<string, number>>;
  readonly eventId?: string;
  readonly atMs?: number;
  readonly instance?: string;
  readonly host?: string;
  readonly trace?: Trace;
  readonly errorCode?: string;
}

export interface ProducerStats {
  readonly queued: number;
  readonly dropped: number;
  readonly sent: number;
  readonly duplicates: number;
  readonly batches: number;
  readonly retries: number;
  readonly lastError: string | null;
}

export interface Producer {
  record(event: OperationInput): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): ProducerStats;
}

const EMPTY_STATS: ProducerStats = { queued: 0, dropped: 0, sent: 0, duplicates: 0, batches: 0, retries: 0, lastError: null };

function disabledProducer(): Producer {
  return {
    record: () => {},
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    stats: () => EMPTY_STATS
  };
}

function bound(value: number | undefined, fallback: number, low: number, high: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new TypeError(`producer limit must be an integer from ${low} to ${high}`);
  return value;
}

function defaultEventId(): string {
  const randomUUID = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000_000).toString(36)}`;
}

function serverMessage(error: unknown): string {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network";
}

export function createProducer(config?: ProducerConfig | null): Producer {
  if (config === undefined || config === null) return disabledProducer();
  const settings = config;
  const endpoint = settings.endpoint.trim();
  const service = settings.service.trim();
  const release = settings.release.trim();
  const staticToken = typeof settings.token === "string" ? settings.token.trim() : null;
  if (endpoint === "" || service === "" || release === "" || staticToken === "") return disabledProducer();
  if (!SERVICE.test(service)) throw new TypeError("service must be 1-32 lowercase letters, digits, or hyphens, starting with a letter");
  if (!RELEASE.test(release)) throw new TypeError("release must be 1-64 letters, digits, or ._:+- starting with a letter or digit");
  if (config.instance !== undefined && !INSTANCE.test(config.instance)) throw new TypeError("instance must be 1-128 letters, digits, or ._:- starting with a letter or digit");
  if (config.host !== undefined && !HOST.test(config.host)) throw new TypeError("host must be 1-128 letters, digits, or ._:- starting with a letter or digit");
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new TypeError("endpoint must be a URL");
  }
  if ((base.protocol !== "https:" && base.protocol !== "http:") || base.pathname !== "/" || base.search !== "" || base.hash !== "" || base.username !== "" || base.password !== "") {
    throw new TypeError("endpoint must be a bare http or https origin");
  }
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") return disabledProducer();
  const queueLimit = bound(config.queueLimit, DEFAULT_QUEUE_LIMIT, 1, MAX_QUEUE_LIMIT);
  const batchSize = bound(config.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_EVENTS);
  const flushIntervalMs = bound(config.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 1, 3_600_000);
  const timeoutMs = bound(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000);
  const maxRetries = bound(config.maxRetries, DEFAULT_MAX_RETRIES, 0, 10);
  const backoffBaseMs = bound(config.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS, 1, 60_000);
  const maxRetryAfterMs = bound(config.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS, 1, 300_000);
  const random = config.random ?? Math.random;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = config.now ?? Date.now;
  const newEventId = config.newEventId ?? defaultEventId;
  const tokenValue = () => typeof settings.token === "string" ? settings.token : settings.token();
  const target = new URL(`/ingest/observe/v1/${encodeURIComponent(service)}/batches`, base).toString();
  const encoder = new TextEncoder();

  const queue: OperationEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let closed = false;
  let dropped = 0;
  let sent = 0;
  let duplicates = 0;
  let batches = 0;
  let retries = 0;
  let lastError: string | null = null;

  function normalize(input: OperationInput): OperationEvent | null {
    const eventId = input.eventId ?? newEventId();
    const atMs = input.atMs ?? now();
    const durationMs = input.durationMs;
    const work = workOf(input.work ?? {});
    const instance = input.instance ?? settings.instance;
    const host = input.host ?? settings.host;
    if (!EVENT_ID.test(eventId) || !OPERATION.test(input.operation) || !OUTCOME.test(input.outcome)) return null;
    if (!Number.isSafeInteger(atMs) || atMs <= 0 || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) return null;
    if (work === null) return null;
    if (instance !== undefined && !INSTANCE.test(instance)) return null;
    if (host !== undefined && !HOST.test(host)) return null;
    if (input.trace !== undefined && (!TRACE_ID.test(input.trace.traceId) || !SPAN_ID.test(input.trace.spanId))) return null;
    if (input.errorCode !== undefined && (typeof input.errorCode !== "string" || !ERROR_CODE.test(input.errorCode) || input.outcome === SUCCESS_OUTCOME)) return null;
    return {
      schemaVersion: 1,
      eventId,
      atMs,
      operation: input.operation,
      outcome: input.outcome,
      durationMs,
      work,
      release,
      service,
      ...(instance === undefined ? {} : { instance }),
      ...(host === undefined ? {} : { host }),
      ...(input.trace === undefined ? {} : { trace: input.trace }),
      ...(input.errorCode === undefined ? {} : { error: { code: input.errorCode } })
    };
  }

  function backoff(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return Math.min(retryAfterMs, maxRetryAfterMs);
    const ceiling = Math.min(backoffBaseMs * 2 ** attempt, maxRetryAfterMs);
    return Math.max(1, Math.round(ceiling * (0.5 + random() * 0.5)));
  }

  function takeBatch(): OperationEvent[] {
    const batch: OperationEvent[] = [];
    while (queue.length > 0 && batch.length < batchSize) {
      const next = [...batch, queue[0]!];
      if (encoder.encode(encodeBatch(next)).byteLength > MAX_BATCH_BYTES) break;
      batch.push(queue.shift()!);
    }
    if (batch.length === 0 && queue.length > 0) {
      queue.shift();
      dropped += 1;
      lastError = "event_too_large";
    }
    return batch;
  }

  async function readAck(response: Response): Promise<{ readonly accepted: number; readonly duplicate: number } | null> {
    if (response.body === null) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        size += step.value.byteLength;
        if (size > MAX_ACK_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(step.value);
      }
    } catch {
      return null;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const { accepted, duplicate } = value as { accepted?: unknown; duplicate?: unknown };
    if (!Number.isSafeInteger(accepted) || (accepted as number) < 0 || !Number.isSafeInteger(duplicate) || (duplicate as number) < 0) return null;
    return { accepted: accepted as number, duplicate: duplicate as number };
  }

  function drop(batch: readonly OperationEvent[], reason: string): void {
    dropped += batch.length;
    lastError = reason;
  }

  async function send(batch: readonly OperationEvent[]): Promise<void> {
    const body = encodeBatch(batch);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let token: string;
      try {
        token = tokenValue();
      } catch {
        drop(batch, "token_unavailable");
        return;
      }
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        if (attempt === maxRetries) {
          drop(batch, serverMessage(error));
          return;
        }
        await sleep(backoff(attempt, null));
        retries += 1;
        continue;
      }
      if (response.ok) {
        const ack = await readAck(response);
        if (ack !== null) {
          sent += ack.accepted;
          duplicates += ack.duplicate;
          batches += 1;
          return;
        }
        if (attempt === maxRetries) {
          drop(batch, "malformed_response");
          return;
        }
        await sleep(backoff(attempt, null));
        retries += 1;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        let next: string | null = null;
        try {
          next = tokenValue();
        } catch {
          next = null;
        }
        if (next !== null && next !== token && attempt < maxRetries) {
          retries += 1;
          continue;
        }
        drop(batch, `http_${response.status}`);
        return;
      }
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        if (attempt === maxRetries) {
          drop(batch, `http_${response.status}`);
          return;
        }
        const header = response.headers.get("retry-after");
        const retryAfter = header !== null && /^\d{1,10}$/u.test(header) ? Number(header) * 1000 : null;
        await sleep(backoff(attempt, retryAfter));
        retries += 1;
        continue;
      }
      drop(batch, `http_${response.status}`);
      return;
    }
  }

  function schedule(): void {
    if (timer !== null || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, flushIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function drain(): Promise<void> {
    if (active !== null) return active;
    active = (async () => {
      for (;;) {
        const batch = takeBatch();
        if (batch.length === 0) return;
        await send(batch);
      }
    })().finally(() => {
      active = null;
    });
    return active;
  }

  function record(input: OperationInput): void {
    if (closed) {
      dropped += 1;
      lastError = "closed";
      return;
    }
    const event = normalize(input);
    if (event === null) {
      dropped += 1;
      lastError = "invalid_event";
      return;
    }
    if (queue.length >= queueLimit) {
      queue.shift();
      dropped += 1;
      lastError = "queue_overflow";
    }
    queue.push(event);
    if (queue.length >= batchSize) void drain().catch(() => { lastError = "internal"; });
    else schedule();
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (;;) {
      if (active !== null) {
        await active;
        continue;
      }
      if (queue.length === 0) return;
      await drain();
    }
  }

  return {
    record,
    flush,
    async shutdown() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
    stats: () => ({ queued: queue.length, dropped, sent, duplicates, batches, retries, lastError })
  };
}
