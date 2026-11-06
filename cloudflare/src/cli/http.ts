import { authError, transportError } from "./exit.ts";
import type { Credential } from "./auth.ts";
import { ServerOlderError } from "../observe/client/decode.ts";

export const REQUEST_TIMEOUT_MS = 15_000;
export const JSON_BODY_LIMIT = 1024 * 1024;
export const HISTORY_BODY_LIMIT = 8 * 1024 * 1024;
export const MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export interface HttpOptions {
  readonly origin: string;
  readonly credential: (() => Promise<Credential>) | null;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly backoffMs?: number;
  readonly random?: () => number;
}

export interface GetOptions {
  readonly ifNoneMatch?: string;
  readonly bodyLimit?: number;
}

export type Fetched<T> =
  | { readonly kind: "ok"; readonly value: T; readonly etag: string | null }
  | { readonly kind: "not-modified"; readonly etag: string | null };

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface HttpClient {
  readonly requests: () => number;
  getJson<T>(path: string, decode: (value: unknown) => T, options?: GetOptions): Promise<Fetched<T>>;
  getBytes(path: string, options?: GetOptions): Promise<Fetched<Uint8Array>>;
}

async function readCapped(response: Response, limit: number, abort: () => void): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    abort();
    throw transportError("body_too_large", `response is larger than ${limit} bytes`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const step = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (step.done) break;
    const value = step.value;
    size += value.byteLength;
    if (size > limit) {
      abort();
      await reader.cancel().catch(() => undefined);
      throw transportError("body_too_large", `response is larger than ${limit} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isHtml(headers: Headers, body: Uint8Array): boolean {
  if ((headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return true;
  const head = new TextDecoder().decode(body.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

export function createHttpClient(options: HttpOptions): HttpClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? 250;
  const random = options.random ?? Math.random;
  let count = 0;
  let credential: Promise<Credential> | undefined;

  function url(path: string): URL {
    if (!path.startsWith("/") || path.startsWith("//")) throw new TypeError(`request path must be absolute: ${path}`);
    const target = new URL(path, options.origin);
    if (target.origin !== options.origin) throw new TypeError("request would leave the configured origin");
    return target;
  }

  async function attempt(target: URL, accept: string, limit: number, extra: GetOptions): Promise<Reply> {
    const secret = options.credential === null ? null : await (credential ??= options.credential());
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout.signal]);
    const headers: Record<string, string> = secret === null ? { accept } : { accept, [secret.header]: secret.value };
    if (extra.ifNoneMatch !== undefined) headers["if-none-match"] = extra.ifNoneMatch;
    count += 1;
    try {
      const response = await doFetch(target, { method: "GET", headers, redirect: "manual", cache: "no-store", signal });
      const body = response.status === 304 ? new Uint8Array() : await readCapped(response, limit, () => timeout.abort());
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (error instanceof Error && error.name === "CommandError") throw error;
      if (options.signal.aborted) throw transportError("cancelled", "request cancelled");
      if (timeout.signal.aborted) throw transportError("timeout", `request exceeded ${timeoutMs} ms`);
      throw transportError("network", "request failed before a response");
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(path: string, accept: string, limit: number, extra: GetOptions): Promise<Reply> {
    const target = url(path);
    for (let tries = 0; ; tries += 1) {
      const last = tries >= MAX_RETRIES;
      let reply: Reply;
      try {
        reply = await attempt(target, accept, limit, extra);
      } catch (error) {
        const retryable = error instanceof Error && "code" in error && (error.code === "network" || error.code === "timeout");
        if (last || !retryable) throw error;
        await pause(tries);
        continue;
      }
      if (RETRYABLE_STATUS.has(reply.status) && !last) {
        await pause(tries);
        continue;
      }
      return reply;
    }
  }

  function pause(tries: number): Promise<void> {
    const delay = Math.floor(random() * backoffMs * 2 ** tries);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(transportError("cancelled", "request cancelled"));
      }, { once: true });
    });
  }

  function classify(reply: Reply, path: string, conditional: boolean): "not-modified" | "body" {
    const { status } = reply;
    if (status >= 300 && status < 400) {
      if (status === 304 && conditional) return "not-modified";
      throw authError("redirect", `${path} answered ${status}, a redirect that is not followed; the session is not signed in to ${options.origin}`);
    }
    if (status === 401 || status === 403) throw authError("unauthorized", `${path} answered ${status}`);
    if (status === 404) throw transportError("not_found", `${path} answered 404`);
    if (status < 200 || status >= 300) throw transportError(`http_${status}`, `${path} answered ${status}`);
    if (isHtml(reply.headers, reply.body)) throw authError("login_page", `${path} answered an HTML page instead of data; the session is not signed in to ${options.origin}`);
    return "body";
  }

  return {
    requests: () => count,
    async getJson<T>(path: string, decode: (value: unknown) => T, extra: GetOptions = {}): Promise<Fetched<T>> {
      const reply = await get(path, "application/json", extra.bodyLimit ?? JSON_BODY_LIMIT, extra);
      const etag = reply.headers.get("etag");
      if (classify(reply, path, extra.ifNoneMatch !== undefined) === "not-modified") return { kind: "not-modified", etag };
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.body));
      } catch {
        throw transportError("malformed_json", `${path} did not return valid JSON`);
      }
      try {
        return { kind: "ok", value: decode(parsed), etag };
      } catch (error) {
        if (error instanceof ServerOlderError) throw transportError("server_older", `${path}: ${error.message}`);
        throw transportError("contract", `${path} did not match the telemetry contract: ${error instanceof Error ? error.message : "invalid response"}`);
      }
    },
    async getBytes(path: string, extra: GetOptions = {}): Promise<Fetched<Uint8Array>> {
      const reply = await get(path, "*/*", HISTORY_BODY_LIMIT, extra);
      const etag = reply.headers.get("etag");
      if (classify(reply, path, extra.ifNoneMatch !== undefined) === "not-modified") return { kind: "not-modified", etag };
      return { kind: "ok", value: reply.body, etag };
    }
  };
}
