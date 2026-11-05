import { createHash } from "node:crypto";
import { decodeProject, boolean, list, record, text, timestamp, type ProjectSummary } from "../client/project-model.ts";
import { PRICING_REVISION } from "../cost/pricing.ts";
import { decodeObjectMethods } from "../observe/client/decode.ts";
import type { ObjectMethods as ObservedObjectMethods } from "../observe/core/store.ts";
import type { Warning } from "./envelope.ts";
import { transportError } from "./exit.ts";
import { MEASUREMENT_REVISION } from "./revisions.ts";
import type { ResolvedWindows } from "./windows.ts";

export const SNAPSHOT_SCHEMA = "statsctl-snapshot/1";
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export interface RequestCounts {
  readonly shared: number;
  readonly project: number;
}

export interface ObservedMethods {
  readonly now: ObservedObjectMethods;
  readonly before: ObservedObjectMethods | null;
}

export interface CostInputs {
  readonly capturedAtMs: number;
  readonly project: ProjectSummary;
  readonly windows: ResolvedWindows;
  readonly notes: readonly Warning[];
  readonly requests: RequestCounts;
  readonly current: Uint8Array;
  readonly previous: Uint8Array | null;
  readonly methods: ObservedMethods | null;
}

interface FrameInput {
  readonly name: string;
  readonly sha256: string;
  readonly encoding: "base64";
  readonly data: string;
}

interface JsonInput {
  readonly name: string;
  readonly sha256: string;
  readonly encoding: "json";
  readonly data: unknown;
}

type SnapshotInput = FrameInput | JsonInput;

export interface Snapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly cliRevision: string;
  readonly pricingRevision: string;
  readonly measurementRevision: string;
  readonly identities: {
    readonly worker: string;
    readonly buckets: readonly string[];
    readonly durableObjectNamespaces: readonly string[];
    readonly d1Databases: readonly string[];
  };
  readonly inputs: readonly SnapshotInput[];
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const BASE64_CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), character => character.charCodeAt(0));
}

const frame = (name: string, bytes: Uint8Array): FrameInput => ({ name, sha256: sha256(bytes), encoding: "base64", data: toBase64(bytes) });
const json = (name: string, data: unknown): JsonInput => ({ name, sha256: sha256(JSON.stringify(data)), encoding: "json", data });

function methodsJson(methods: ObservedMethods): unknown {
  return { now: methods.now, before: methods.before };
}

export function encodeSnapshot(inputs: CostInputs, cliRevision: string): Snapshot {
  const { project } = inputs;
  return {
    schema: SNAPSHOT_SCHEMA,
    cliRevision,
    pricingRevision: PRICING_REVISION,
    measurementRevision: MEASUREMENT_REVISION,
    identities: { worker: project.worker, buckets: project.buckets, durableObjectNamespaces: project.durableObjectNamespaces, d1Databases: project.d1Databases },
    inputs: [
      json("resolution", { capturedAtMs: inputs.capturedAtMs, windows: inputs.windows, notes: inputs.notes, requests: inputs.requests }),
      json("project", project),
      frame("history.current", inputs.current),
      ...(inputs.previous === null ? [] : [frame("history.previous", inputs.previous)]),
      ...(inputs.methods === null ? [] : [json("observe.methods", methodsJson(inputs.methods))])
    ]
  };
}

export function serializeSnapshot(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

export const inputDigests = (snapshot: Snapshot): readonly { readonly name: string; readonly sha256: string }[] => snapshot.inputs.map(({ name, sha256: digest }) => ({ name, sha256: digest }));

function refuse(code: string, message: string): never {
  throw transportError(code, message);
}

function malformed(what: string): never {
  return refuse("snapshot_malformed", `the snapshot is malformed: ${what}`);
}

function guarded<T>(read: () => T, what: string): T {
  try {
    return read();
  } catch (error) {
    return malformed(`${what}: ${error instanceof Error ? error.message : "invalid"}`);
  }
}

function window(value: unknown, what: string) {
  const fields = record(value, what);
  return { fromMs: timestamp(fields["fromMs"], what), toMs: timestamp(fields["toMs"], what) };
}

function decodedInputs(parsed: Readonly<Record<string, unknown>>): ReadonlyMap<string, unknown> {
  const decoded = new Map<string, unknown>();
  for (const item of guarded(() => list(parsed["inputs"], 16, (entry, what) => record(entry, what), "inputs"), "inputs")) {
    const name = guarded(() => text(item["name"], "input name", 64), "input name");
    const digest = guarded(() => text(item["sha256"], "input digest", 64), `${name} digest`);
    if (decoded.has(name)) malformed(`input ${name} appears twice`);
    if (item["encoding"] === "base64") {
      const data = guarded(() => text(item["data"], "frame", 16 * 1024 * 1024), name);
      const bytes = guarded(() => fromBase64(data), name);
      if (toBase64(bytes) !== data) malformed(`${name} is not canonical base64`);
      if (sha256(bytes) !== digest) refuse("snapshot_hash_mismatch", `input ${name} does not match its SHA-256`);
      decoded.set(name, bytes);
    } else if (item["encoding"] === "json") {
      if (sha256(JSON.stringify(item["data"])) !== digest) refuse("snapshot_hash_mismatch", `input ${name} does not match its SHA-256`);
      decoded.set(name, item["data"]);
    } else malformed(`input ${name} has an unknown encoding`);
  }
  return decoded;
}

export function parseSnapshot(source: string): CostInputs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return malformed("not valid JSON");
  }
  const fields = guarded(() => record(parsed, "snapshot"), "snapshot");
  if (fields["schema"] !== SNAPSHOT_SCHEMA) refuse("snapshot_schema", `the snapshot schema is ${JSON.stringify(fields["schema"])}, this statsctl reads ${SNAPSHOT_SCHEMA}`);
  if (fields["pricingRevision"] !== PRICING_REVISION) refuse("snapshot_pricing_revision", `the snapshot was priced at revision ${JSON.stringify(fields["pricingRevision"])}, this statsctl prices at ${PRICING_REVISION}`);
  if (fields["measurementRevision"] !== MEASUREMENT_REVISION) refuse("snapshot_measurement_revision", `the snapshot measurement revision is ${JSON.stringify(fields["measurementRevision"])}, this statsctl uses ${MEASUREMENT_REVISION}`);
  const inputs = decodedInputs(fields);
  const need = <T>(name: string, read: (value: unknown) => T): T => {
    if (!inputs.has(name)) return malformed(`input ${name} is missing`);
    return guarded(() => read(inputs.get(name)), name);
  };
  const optional = <T>(name: string, read: (value: unknown) => T): T | null => inputs.has(name) ? need(name, read) : null;
  const bytes = (value: unknown): Uint8Array => {
    if (!(value instanceof Uint8Array)) throw new Error("expected a frame");
    return value;
  };
  const project = need("project", decodeProject);
  const identities = guarded(() => record(fields["identities"], "identities"), "identities");
  const same = (key: string, expected: string | readonly string[]) => {
    if (JSON.stringify(identities[key]) !== JSON.stringify(expected)) malformed(`identities.${key} differs from the project input`);
  };
  same("worker", project.worker);
  same("buckets", project.buckets);
  same("durableObjectNamespaces", project.durableObjectNamespaces);
  same("d1Databases", project.d1Databases);
  const resolution = need("resolution", value => {
    const entry = record(value, "resolution");
    const windows = record(entry["windows"], "windows");
    const requests = record(entry["requests"], "requests");
    return {
      capturedAtMs: timestamp(entry["capturedAtMs"], "captured clock"),
      windows: { current: window(windows["current"], "current window"), previous: window(windows["previous"], "previous window"), monthToDate: boolean(windows["monthToDate"], "month to date") },
      notes: list(entry["notes"], 64, (item, what) => {
        const note = record(item, what);
        return { code: text(note["code"], what, 128), message: text(note["message"], what, 1024) };
      }, "notes"),
      requests: { shared: timestamp(requests["shared"], "shared requests"), project: timestamp(requests["project"], "project requests") }
    };
  });
  const methods = optional("observe.methods", value => {
    const entry = record(value, "observe methods");
    return { now: decodeObjectMethods(entry["now"]), before: entry["before"] === null ? null : decodeObjectMethods(entry["before"]) };
  });
  return {
    capturedAtMs: resolution.capturedAtMs,
    project,
    windows: resolution.windows,
    notes: resolution.notes,
    requests: resolution.requests,
    current: need("history.current", bytes),
    previous: optional("history.previous", bytes),
    methods
  };
}
