import { MAX_ERRORS_PER_INVOCATION, MAX_LABEL_BYTES, MAX_MESSAGE_BYTES, MAX_NAME_BYTES, MAX_STACK_BYTES } from "./limits.ts";
import { parseStack, type StackFrame } from "./stack.ts";
import { fingerprint, sha256Hex } from "./grouping.ts";

export type Stage = "worker" | "object";
export type InvocationKind = "fetch" | "rpc" | "alarm" | "scheduled";
export type ErrorSource = "uncaught" | "caught";

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface ObservedError {
  readonly source: ErrorSource;
  readonly operation: string | null;
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

export interface ObservedInvocation {
  readonly version: string | null;
  readonly stage: Stage;
  readonly objectId: string | null;
  readonly kind: InvocationKind;
  readonly label: string;
  readonly status: number | null;
  readonly outcome: string;
  readonly cpuMs: number;
  readonly wallMs: number;
  readonly eventAtMs: number;
  readonly trace: TraceContext | null;
  readonly errors: readonly ObservedError[];
}

export interface MessagePolicy {
  readonly safeNames: ReadonlySet<string>;
}

export interface PreparedError {
  readonly ordinal: number;
  readonly source: ErrorSource;
  readonly operation: string | null;
  readonly name: string;
  readonly message: string | null;
  readonly frames: readonly StackFrame[];
  readonly fingerprint: string;
}

export interface PreparedInvocation {
  readonly key: string;
  readonly digest: string;
  readonly version: string | null;
  readonly stage: Stage;
  readonly objectId: string | null;
  readonly kind: InvocationKind;
  readonly label: string;
  readonly status: number | null;
  readonly outcome: string;
  readonly cpuMs: number;
  readonly wallMs: number;
  readonly eventAtMs: number;
  readonly trace: TraceContext | null;
  readonly errorCount: number;
  readonly errors: readonly PreparedError[];
}

export type Rejection = "invalid_trace" | "invalid_version" | "invalid_object" | "invalid_label" | "invalid_status" | "invalid_outcome" | "invalid_timing" | "invalid_operation";

export type Preparation = { readonly ok: true; readonly invocation: PreparedInvocation } | { readonly ok: false; readonly reason: Rejection };

const TRACE_ID = /^(?!0{32})[0-9a-f]{32}$/u;
const SPAN_ID = /^(?!0{16})[0-9a-f]{16}$/u;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OBJECT_ID = /^[0-9a-f]{64}$/u;
const OUTCOME = /^[A-Za-z]{1,32}$/u;
const OPERATION = /^[a-z][a-z0-9_.]{0,63}$/u;

export async function prepareInvocation(input: ObservedInvocation, policy: MessagePolicy): Promise<Preparation> {
  const reason = rejection(input);
  if (reason !== null) return { ok: false, reason };
  const errors = await Promise.all(input.errors.slice(0, MAX_ERRORS_PER_INVOCATION).map((error, ordinal) => prepareError(error, ordinal, policy)));
  const fields = {
    version: input.version,
    stage: input.stage,
    objectId: input.objectId,
    kind: input.kind,
    label: input.label,
    status: input.status,
    outcome: input.outcome,
    cpuMs: input.cpuMs,
    wallMs: input.wallMs,
    eventAtMs: input.eventAtMs,
    trace: input.trace,
    errorCount: input.errors.length,
    errors
  };
  const key = input.trace === null
    ? (await sha256Hex(["observe.key.v1", input.version ?? "", input.objectId ?? "", input.kind, input.label, String(input.eventAtMs)].join("\u0000"))).slice(0, 32)
    : input.trace.spanId;
  const digest = await sha256Hex(JSON.stringify(fields));
  return { ok: true, invocation: { key, digest, ...fields } };
}

function rejection(input: ObservedInvocation): Rejection | null {
  if (input.trace !== null && (!TRACE_ID.test(input.trace.traceId) || !SPAN_ID.test(input.trace.spanId))) return "invalid_trace";
  if (input.version !== null && !VERSION_ID.test(input.version)) return "invalid_version";
  if ((input.stage === "object") !== (input.objectId !== null) || (input.objectId !== null && !OBJECT_ID.test(input.objectId))) return "invalid_object";
  if (input.label === "" || utf8Length(input.label) > MAX_LABEL_BYTES || hasControlCharacter(input.label)) return "invalid_label";
  if (input.status !== null && !(Number.isInteger(input.status) && input.status >= 100 && input.status <= 599)) return "invalid_status";
  if (!OUTCOME.test(input.outcome)) return "invalid_outcome";
  if (![input.cpuMs, input.wallMs].every(ms => Number.isSafeInteger(ms) && ms >= 0) || !Number.isSafeInteger(input.eventAtMs) || input.eventAtMs <= 0) return "invalid_timing";
  if (input.errors.some(error => error.operation !== null && !OPERATION.test(error.operation))) return "invalid_operation";
  return null;
}

async function prepareError(error: ObservedError, ordinal: number, policy: MessagePolicy): Promise<PreparedError> {
  const name = truncateUtf8(error.name, MAX_NAME_BYTES);
  const message = policy.safeNames.has(name) ? truncateUtf8(error.message, MAX_MESSAGE_BYTES) : null;
  const frames = error.stack === null ? [] : parseStack(truncateUtf8(error.stack, MAX_STACK_BYTES));
  return { ordinal, source: error.source, operation: error.operation, name, message, frames, fingerprint: await fingerprint({ operation: error.operation, name, message, frames }) };
}

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) bytes += utf8Width(char.codePointAt(0) ?? 0);
  return bytes;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const width = utf8Width(char.codePointAt(0) ?? 0);
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += char.length;
  }
  return text.slice(0, end);
}

function utf8Width(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}
