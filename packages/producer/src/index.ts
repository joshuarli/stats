import {
  encodeBatch, encodeEvent, ERROR_CODE, EVENT_ID, HOST, INSTANCE, MAX_BATCH_BYTES, MAX_DURATION_MS, MAX_EVENTS, OPERATION, OUTCOME, RELEASE, SERVICE, SUCCESS_OUTCOME, TRACE_ID, SPAN_ID,
  boundedDiagnostics, workOf, type Diagnostics, type OperationEvent, type Trace
} from "./protocol.ts";

export type { Diagnostics, EventError, OperationEvent, Trace } from "./protocol.ts";
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

export type BindingProducerConfig = Omit<ProducerConfig, "endpoint" | "token" | "fetch"> & {
  readonly postBatch: (body: string, signal: AbortSignal) => Promise<Response>;
};

export interface OperationInput {
  readonly release?: string;
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
  readonly diagnostics?: Diagnostics;
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
  return configuredProducer(config);
}

export function createBindingProducer(config?: BindingProducerConfig | null): Producer {
  return configuredProducer(config);
}

function configuredProducer(config?: ProducerConfig | BindingProducerConfig | null): Producer {
  if (config === undefined || config === null) return disabledProducer();
  const settings = config;
  const service = settings.service.trim();
  const release = settings.release.trim();
  if (service === "" || release === "") return disabledProducer();
  let delivery: { readonly kind: "binding"; readonly post: BindingProducerConfig["postBatch"] } | { readonly kind: "http"; readonly target: string; readonly fetch: typeof fetch; readonly token: () => string };
  if ("postBatch" in settings) {
    if (typeof settings.postBatch !== "function") throw new TypeError("postBatch must be a function");
    delivery = { kind: "binding", post: settings.postBatch };
  } else {
    const endpoint = settings.endpoint.trim();
    const staticToken = typeof settings.token === "string" ? settings.token.trim() : null;
    if (endpoint === "" || staticToken === "") return disabledProducer();
    let base: URL;
    try { base = new URL(endpoint); } catch { throw new TypeError("endpoint must be a URL"); }
    if ((base.protocol !== "https:" && base.protocol !== "http:") || base.pathname !== "/" || base.search !== "" || base.hash !== "" || base.username !== "" || base.password !== "") throw new TypeError("endpoint must be a bare http or https origin");
    const fetchFn = settings.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== "function") return disabledProducer();
    delivery = { kind: "http", target: new URL(`/ingest/observe/v1/${encodeURIComponent(service)}/batches`, base).toString(), fetch: fetchFn, token: () => typeof settings.token === "string" ? settings.token : settings.token() };
  }
  if (!SERVICE.test(service)) throw new TypeError("service must be 1-32 lowercase letters, digits, or hyphens, starting with a letter");
  if (!RELEASE.test(release)) throw new TypeError("release must be 1-64 letters, digits, or ._:+- starting with a letter or digit");
  if (config.instance !== undefined && !INSTANCE.test(config.instance)) throw new TypeError("instance must be 1-128 letters, digits, or ._:- starting with a letter or digit");
  if (config.host !== undefined && !HOST.test(config.host)) throw new TypeError("host must be 1-128 letters, digits, or ._:- starting with a letter or digit");
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
  const encoder = new TextEncoder();

  const producerId = defaultEventId();
  const startedAtMs = now();
  let accepted = 0;
  const queue: { event: OperationEvent; size: number }[] = [];
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
    const eventRelease = input.release ?? release;
    const work = workOf(input.work ?? {});
    const instance = input.instance ?? settings.instance;
    const host = input.host ?? settings.host;
    if (!EVENT_ID.test(eventId) || !OPERATION.test(input.operation) || !OUTCOME.test(input.outcome)) return null;
    if (!Number.isSafeInteger(atMs) || atMs <= 0 || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) return null;
    if (work === null || typeof eventRelease !== "string" || !RELEASE.test(eventRelease)) return null;
    if (instance !== undefined && !INSTANCE.test(instance)) return null;
    if (host !== undefined && !HOST.test(host)) return null;
    if (input.trace !== undefined && (!TRACE_ID.test(input.trace.traceId) || !SPAN_ID.test(input.trace.spanId))) return null;
    if (input.errorCode !== undefined && (typeof input.errorCode !== "string" || !ERROR_CODE.test(input.errorCode) || input.outcome === SUCCESS_OUTCOME)) return null;
    if (input.diagnostics !== undefined && (input.diagnostics.version !== 1 || typeof input.diagnostics.name !== "string" || typeof input.diagnostics.message !== "string" || !Array.isArray(input.diagnostics.frames) || !input.diagnostics.frames.every(frame => typeof frame === "string"))) return null;
    return {
      schemaVersion: 1,
      eventId,
      atMs,
      operation: input.operation,
      outcome: input.outcome,
      durationMs,
      work,
      release: eventRelease,
      service,
      ...(instance === undefined ? {} : { instance }),
      ...(host === undefined ? {} : { host }),
      ...(input.trace === undefined ? {} : { trace: input.trace }),
      ...(input.errorCode === undefined ? {} : { error: { code: input.errorCode } }),
      ...(input.diagnostics === undefined ? {} : { diagnostics: boundedDiagnostics(input.diagnostics) })
    };
  }

  function backoff(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return Math.min(retryAfterMs, maxRetryAfterMs);
    const ceiling = Math.min(backoffBaseMs * 2 ** attempt, maxRetryAfterMs);
    return Math.max(1, Math.round(ceiling * (0.5 + random() * 0.5)));
  }

  function takeBatch(boundary: number): OperationEvent[] {
    const batch: OperationEvent[] = [];
    let size = 13; // {"events":[]} plus one comma for each event after the first.
    while (queue.length > 0 && queue[0]!.event.delivery!.sequence <= boundary && batch.length < batchSize) {
      const next = queue[0]!;
      const added = next.size + (batch.length === 0 ? 0 : 1);
      if (size + added > MAX_BATCH_BYTES) break;
      size += added;
      batch.push(queue.shift()!.event);
    }
    if (batch.length === 0 && queue.length > 0 && queue[0]!.event.delivery!.sequence <= boundary) {
      queue.shift();
      dropped += 1;
      lastError = "event_too_large";
    }
    const atMs = now();
    return batch.map(event => ({ ...event, delivery: { ...event.delivery!, accepted, dropped, queued: queue.length, atMs } }));
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
      let token: string | undefined;
      try {
        if (delivery.kind === "http") token = delivery.token();
      } catch {
        drop(batch, "token_unavailable");
        return;
      }
      let response: Response;
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        response = delivery.kind === "binding" ? await delivery.post(body, signal) : await delivery.fetch(delivery.target, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body,
          signal
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
          next = delivery.kind === "http" ? delivery.token() : null;
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

  function schedule(delay = flushIntervalMs): void {
    if (timer !== null || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function drain(boundary = accepted): Promise<void> {
    if (active !== null) return active;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    active = (async () => {
      for (;;) {
        const batch = takeBatch(boundary);
        if (batch.length === 0) return;
        await send(batch);
      }
    })().finally(() => {
      active = null;
      if (queue.length > 0 && !closed) {
        if (queue.length >= batchSize && timer !== null) { clearTimeout(timer); timer = null; }
        schedule(queue.length >= batchSize ? 0 : flushIntervalMs);
      }
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
    accepted += 1;
    const queuedEvent = { ...event, delivery: { id: producerId, sequence: accepted, accepted, dropped, queued: 0, startedAtMs, atMs: now() } };
    const sized = { ...queuedEvent, delivery: { ...queuedEvent.delivery, accepted: Number.MAX_SAFE_INTEGER, dropped: Number.MAX_SAFE_INTEGER, queued: MAX_QUEUE_LIMIT, atMs: Number.MAX_SAFE_INTEGER } };
    queue.push({ event: queuedEvent, size: encoder.encode(encodeEvent(sized)).byteLength });
    if (queue.length >= batchSize) void drain().catch(() => { lastError = "internal"; });
    else schedule();
  }

  async function flush(): Promise<void> {
    const boundary = accepted;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (;;) {
      if (active !== null) {
        await active;
        continue;
      }
      if (queue.length === 0 || queue[0]!.event.delivery!.sequence > boundary) return;
      await drain(boundary);
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
