import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXPORT_FORMAT, MAX_PAGE_BYTES, MAX_PAGE_ROWS, type ObjectManifest, type Page } from "../../core/export/snapshot.ts";
import type { SqlValue } from "../../core/sql.ts";
import { HISTORY_BODY_LIMIT } from "../http.ts";
import { CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { defineCommand, type CommandContext } from "../registry.ts";
import { invocationDirectory } from "../snapshot-store.ts";

const BACKUP_FORMAT = "stats-backup/1";
const CHECKPOINT_FORMAT = "stats-backup-checkpoint/1";
const OBJECT = /^(installation|observe:[a-z][a-z0-9-]{0,31})$/u;
const TABLE = /^[a-z_][a-z0-9_]{0,62}$/u;
const IMPORT_PAGE_BYTES = MAX_PAGE_BYTES / 4;
const IMPORT_PAGE_ROWS = MAX_PAGE_ROWS / 4;
const OBJECT_CONCURRENCY = 4;
const ROW_ATTEMPTS = 6;

async function eachLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    try {
      while (!failed && next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!);
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  });
  const settled = await Promise.allSettled(lanes);
  const failure = settled.find(result => result.status === "rejected");
  if (failure !== undefined) throw failure.reason as unknown;
  return results;
}

async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const retryable = error instanceof CommandError && error.exit === EXIT.transport && error.code !== "contract";
      if (!retryable || tries >= ROW_ATTEMPTS) throw error;
      await new Promise(wake => setTimeout(wake, Math.min(30_000, 500 * 2 ** tries)));
    }
  }
}

interface BackupIndex {
  readonly format: typeof BACKUP_FORMAT;
  readonly exportFormat: typeof EXPORT_FORMAT;
  readonly origin: string;
  readonly createdAtMs: number;
  readonly objects: readonly string[];
}

interface ObjectsPayload {
  readonly objects: readonly string[];
}

function decodeObjects(value: unknown): ObjectsPayload {
  const objects = (value as { objects?: unknown })?.objects;
  if (!Array.isArray(objects) || objects.some(object => typeof object !== "string" || !OBJECT.test(object))) throw transportError("contract", "objects list is malformed");
  return { objects: objects as string[] };
}

function decodeManifest(value: unknown): ObjectManifest {
  const manifest = value as ObjectManifest;
  if (manifest?.format !== EXPORT_FORMAT || typeof manifest.object !== "string" || !Array.isArray(manifest.tables)) throw transportError("contract", "export manifest is malformed");
  for (const table of manifest.tables as readonly unknown[]) {
    const entry = table as { readonly name?: unknown; readonly rows?: unknown; readonly sha256?: unknown };
    if (typeof entry.name !== "string" || !TABLE.test(entry.name) || !Number.isSafeInteger(entry.rows) || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256)) throw transportError("contract", "export manifest table is malformed");
  }
  return manifest;
}

function decodePage(value: unknown): Page {
  const page = value as Page;
  if (!Array.isArray(page?.rows) || (page.next !== null && !Array.isArray(page.next))) throw transportError("contract", "export page is malformed");
  return page;
}

function objectPath(object: string): string {
  return `/api/v1/admin/objects/${object}`;
}

function directoryName(object: string): string {
  return object.replace(":", "-");
}

async function listObjects(context: CommandContext): Promise<readonly string[]> {
  const fetched = await context.http.getJson("/api/v1/admin/objects", decodeObjects);
  if (fetched.kind !== "ok") throw transportError("contract", "objects list was not returned");
  return fetched.value.objects;
}

function selected(context: CommandContext, all: readonly string[]): readonly string[] {
  const only = context.option("object");
  if (only === undefined) return all;
  if (!all.includes(only)) throw usageError(`--object must be one of ${all.join(", ")}`);
  return [only];
}

function writeExclusive(path: string, text: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try { writeSync(descriptor, text); } finally { closeSync(descriptor); }
}

function rowsDigest(lines: Iterable<string>): { rows: number; sha256: string } {
  const hash = createHash("sha256");
  let rows = 0;
  for (const line of lines) {
    hash.update(line);
    hash.update("\n");
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

function* tableLines(file: string): Generator<string> {
  const text = readFileSync(file, "utf8");
  if (text.length === 0) return;
  if (!text.endsWith("\n")) throw usageError(`${file} is truncated`);
  for (const line of text.slice(0, -1).split("\n")) yield line;
}

interface ExportCheckpoint {
  readonly bytes: number;
  readonly rows: number;
  readonly sha256: string;
  readonly next: readonly SqlValue[] | null;
}

const checkpointName = (table: string) => `.${table}.page.json`;

function checkpointPrefix(directory: string, table: string): { checkpoint: ExportCheckpoint; prefix: Uint8Array } | undefined {
  const path = join(directory, checkpointName(table));
  if (!existsSync(path)) return undefined;
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as ExportCheckpoint;
  if (checkpoint === null || !Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes < 0 ||
    !Number.isSafeInteger(checkpoint.rows) || checkpoint.rows < 0 || typeof checkpoint.sha256 !== "string" ||
    (checkpoint.next !== null && !Array.isArray(checkpoint.next))) throw usageError(`${path} has an invalid export checkpoint`);
  const prefix = readFileSync(join(directory, `${table}.ndjson`)).subarray(0, checkpoint.bytes);
  if (prefix.length !== checkpoint.bytes || createHash("sha256").update(prefix).digest("hex") !== checkpoint.sha256) {
    throw usageError(`${table} does not match its verified export checkpoint`);
  }
  return { checkpoint, prefix };
}

function writeProgress(path: string, value: unknown): void {
  writeExclusive(`${path}.next`, `${JSON.stringify(value)}\n`);
  renameSync(`${path}.next`, path);
}

function snapshotIdentity(manifest: ObjectManifest): string {
  return JSON.stringify([manifest.format, manifest.object, manifest.schema, manifest.alarmAtMs, manifest.tables]);
}

async function exportObject(context: CommandContext, object: string, directory: string, resumeFrom: string | undefined): Promise<{ readonly object: string; readonly tables: number; readonly rows: number }> {
  const fetched = await context.http.getJson(`${objectPath(object)}/export/manifest`, decodeManifest, { bodyLimit: HISTORY_BODY_LIMIT });
  if (fetched.kind !== "ok") throw transportError("contract", `${object} manifest was not returned`);
  const manifest = fetched.value;
  if (manifest.object !== object) throw transportError("contract", `${object} answered with the manifest of ${manifest.object}`);
  const target = join(directory, directoryName(object));
  mkdirSync(target, { mode: 0o700 });
  let source: string | undefined;
  if (resumeFrom !== undefined) {
    const previous = join(resumeFrom, directoryName(object));
    const savedManifest = join(previous, "manifest.json");
    if (existsSync(savedManifest)) {
      if (snapshotIdentity(decodeManifest(JSON.parse(readFileSync(savedManifest, "utf8")))) !== snapshotIdentity(manifest)) {
        throw usageError(`${object} changed since the interrupted export; start a fresh export`);
      }
      source = previous;
    }
  }
  writeProgress(join(target, "manifest.json"), manifest);
  let total = 0;
  for (const table of manifest.tables) {
    const saved = source === undefined ? undefined : checkpointPrefix(source, table.name);
    const descriptor = openSync(join(target, `${table.name}.ndjson`), "wx", 0o600);
    const hash = createHash("sha256");
    let rows = saved?.checkpoint.rows ?? 0;
    let bytes = saved?.checkpoint.bytes ?? 0;
    let after = saved?.checkpoint.next ?? null;
    const checkpointPath = join(target, checkpointName(table.name));
    try {
      if (saved !== undefined) {
        writeFileSync(descriptor, saved.prefix);
        hash.update(saved.prefix);
        writeProgress(checkpointPath, saved.checkpoint);
      }
      if (saved === undefined || after !== null) for (;;) {
        const query = new URLSearchParams({ table: table.name, limit: String(MAX_PAGE_ROWS), ...(after === null ? {} : { after: JSON.stringify(after) }) });
        const page = await context.http.getJson(`${objectPath(object)}/export/rows?${query}`, decodePage, { bodyLimit: HISTORY_BODY_LIMIT });
        if (page.kind !== "ok") throw transportError("contract", `${object} ${table.name} page was not returned`);
        const data = new TextEncoder().encode(page.value.rows.map(row => `${JSON.stringify(row)}\n`).join(""));
        writeFileSync(descriptor, data);
        hash.update(data);
        bytes += data.length;
        rows += page.value.rows.length;
        after = page.value.next;
        writeProgress(checkpointPath, { bytes, rows, sha256: hash.copy().digest("hex"), next: after });
        if (after === null) break;
      }
    } finally {
      closeSync(descriptor);
    }
    const sha256 = hash.digest("hex");
    if (rows !== table.rows || sha256 !== table.sha256) throw new CommandError(EXIT.transport, "integrity", `${object} ${table.name}: exported ${rows} rows with digest ${sha256.slice(0, 12)}, manifest says ${table.rows} with ${table.sha256.slice(0, 12)}; was the object written to during export?`);
    total += rows;
  }
  return { object, tables: manifest.tables.length, rows: total };
}

function readIndex(directory: string): BackupIndex {
  let index: BackupIndex;
  try {
    index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as BackupIndex;
  } catch {
    throw usageError(`${directory} has no readable index.json; the export did not finish`);
  }
  if (index.format !== BACKUP_FORMAT || index.exportFormat !== EXPORT_FORMAT || !Array.isArray(index.objects) || (index.objects as readonly unknown[]).some(object => typeof object !== "string" || !OBJECT.test(object))) throw usageError(`${directory} is not a ${BACKUP_FORMAT} backup`);
  return index;
}

function readObjectManifest(directory: string, object: string): ObjectManifest {
  let manifest: ObjectManifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, directoryName(object), "manifest.json"), "utf8")) as ObjectManifest;
  } catch {
    throw usageError(`${object} has no readable manifest.json; the backup is incomplete`);
  }
  if (manifest.format !== EXPORT_FORMAT || manifest.object !== object) throw usageError(`${object} manifest is not a ${EXPORT_FORMAT} manifest for that object`);
  return manifest;
}

export function verifyBackup(directory: string): readonly { readonly object: string; readonly rows: number }[] {
  const index = readIndex(directory);
  return index.objects.map(object => {
    const manifest = readObjectManifest(directory, object);
    let rows = 0;
    for (const table of manifest.tables) {
      if (!TABLE.test(table.name)) throw usageError(`${object} names an invalid table`);
      const file = join(directory, directoryName(object), `${table.name}.ndjson`);
      if (!existsSync(file)) throw usageError(`${object} ${table.name} is missing from the backup`);
      const digest = rowsDigest(tableLines(file));
      if (digest.rows !== table.rows || digest.sha256 !== table.sha256) throw usageError(`${object} ${table.name} does not match its manifest; the backup is incomplete or altered`);
      rows += digest.rows;
    }
    return { object, rows };
  });
}

interface Progress {
  readonly state: string;
  readonly progress: readonly { readonly table: string; readonly rows: number }[];
}

function decodeProgress(value: unknown): Progress {
  const progress = value as Progress;
  if (typeof progress?.state !== "string" || !Array.isArray(progress.progress)) throw transportError("contract", "import progress is malformed");
  return progress;
}

async function importObject(context: CommandContext, directory: string, object: string): Promise<{ readonly object: string; readonly rows: number }> {
  const manifest = readObjectManifest(directory, object);
  const begun = await withRetry(() => context.http.postJson(`${objectPath(object)}/import/begin`, manifest, decodeProgress));
  let rows = 0;
  for (const table of manifest.tables) {
    const done = begun.progress.find(entry => entry.table === table.name)?.rows ?? 0;
    let offset = 0;
    let batch: SqlValue[][] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      const page = batch;
      if (page.length > 0 && offset + page.length > done) await withRetry(() => context.http.postJson(`${objectPath(object)}/import/rows`, { table: table.name, offset, rows: page }, value => value));
      offset += batch.length;
      batch = [];
      bytes = 0;
    };
    for (const line of tableLines(join(directory, directoryName(object), `${table.name}.ndjson`))) {
      if (batch.length >= IMPORT_PAGE_ROWS || (batch.length > 0 && bytes + line.length > IMPORT_PAGE_BYTES)) await flush();
      batch.push(JSON.parse(line) as SqlValue[]);
      bytes += line.length;
    }
    await flush();
    rows += offset;
  }
  await withRetry(() => context.http.postJson(`${objectPath(object)}/import/finish`, {}, value => value));
  return { object, rows };
}

export const backupObjectsCommand = defineCommand<ObjectsPayload>({
  name: "backup objects",
  summary: "list the durable objects a backup covers",
  description: ["Lists the Installation object and one observation store per known service, as named by the export and import routes."],
  access: "read",
  options: {},
  examples: ["statsctl backup objects --json"],
  limitations: [],
  async run(context) {
    return { payload: { objects: await listObjects(context) } };
  },
  render(payload) {
    return payload.objects.map(object => object);
  }
});

interface MaintenanceResult {
  readonly state: string;
  readonly objects: readonly string[];
  readonly unconfirmed?: readonly { object: string; code: string; detail: string }[];
}

export const backupFenceCommand = defineCommand<MaintenanceResult>({
  name: "backup fence",
  summary: "pause or resume writes on durable objects for a consistent backup",
  description: [
    "MUTATION: --state fenced pauses every write (agents and producers receive 503 and retry) while reads continue; --state open resumes writes and re-arms maintenance alarms.",
    "Without --object, every object is changed. A fenced object refuses ingest, so keep the fence shorter than the agents' queue."
  ],
  access: "mutation",
  options: {
    state: { type: "string", placeholder: "fenced|open", required: true, description: "the maintenance state to set" },
    object: { type: "string", placeholder: "OBJECT", description: "one object from `backup objects` (default: all)" }
  },
  examples: ["statsctl backup fence --state fenced", "statsctl backup fence --state open"],
  limitations: [
    "An object that is importing cannot be fenced or opened; finish the import first.",
    "Opening all objects attempts every object and exits 4 if any result could not be confirmed."
  ],
  async run(context) {
    const state = context.option("state");
    if (state !== "fenced" && state !== "open") throw usageError("--state must be fenced or open");
    const objects = selected(context, await listObjects(context));
    const confirmed = [];
    const unconfirmed = [];
    for (const object of objects) {
      context.signal.throwIfAborted();
      try {
        await context.http.postJson(`${objectPath(object)}/maintenance`, { fenced: state === "fenced" }, value => {
          const result = value as { object?: unknown; state?: unknown } | null;
          if (result?.object !== object || result.state !== state) throw new Error(`expected ${object} to be ${state}`);
          return result;
        });
        confirmed.push(object);
      } catch (error) {
        if (state === "fenced" || objects.length === 1 || !(error instanceof CommandError)) throw error;
        unconfirmed.push({ object, code: error.code, detail: error.message });
      }
    }
    if (unconfirmed.length > 0) return { payload: { state, objects: confirmed, unconfirmed }, exit: EXIT.transport };
    return { payload: { state, objects: confirmed } };
  },
  render(payload) {
    return [
      `${payload.objects.length} object${payload.objects.length === 1 ? "" : "s"} ${payload.state}`,
      ...(payload.unconfirmed ?? []).map(failure => `unconfirmed ${failure.object}: ${failure.detail}`)
    ];
  }
});

export const backupExportCommand = defineCommand<{ readonly directory: string; readonly objects: readonly { readonly object: string; readonly tables: number; readonly rows: number }[] }>({
  name: "backup export",
  requestTimeoutMs: 120_000,
  summary: "export every fenced durable object to a new verified backup directory",
  description: [
    "Writes DIR/index.json and, per object, manifest.json plus one NDJSON file per table, all mode 0600 in mode 0700 directories. Each table's row count and SHA-256 are checked against the object's manifest before the next table starts.",
    "Fence the objects first with `statsctl backup fence --state fenced`. The backup holds token verifiers; store it like a credential."
  ],
  access: "read",
  options: {
    out: { type: "string", placeholder: "DIR", required: true, description: "new directory for the backup, resolved from the invocation directory" },
    "resume-from": { type: "string", placeholder: "DIR", description: "partial export to reuse while the source remains fenced" },
    serial: { type: "boolean", description: "fetch one object at a time to reduce load on the source" },
    object: { type: "string", placeholder: "OBJECT", description: "one object from `backup objects` (default: all)" }
  },
  examples: ["statsctl backup export --out .work/backups/2026-11-14"],
  limitations: ["index.json is written after all pages pass verification. Resume into a new output from the previous DIR.partial, with the same source and selection."],
  async run(context) {
    const directory = resolve(invocationDirectory(), context.option("out") ?? "");
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || readdirSync(directory).length > 0)) throw usageError(`${directory} must be a new or empty directory`);
    const objects = selected(context, await listObjects(context));
    const staging = `${directory}.partial`;
    const resume = context.option("resume-from");
    const previous = resume === undefined ? undefined : resolve(invocationDirectory(), resume);
    const checkpointSource = { format: CHECKPOINT_FORMAT, origin: context.origin, objects };
    const sourceJson = JSON.stringify(checkpointSource);
    if (previous !== undefined) {
      const previousSource = join(previous, ".export-source.json");
      if (!existsSync(previousSource) || readFileSync(previousSource, "utf8").trim() !== sourceJson) {
        throw usageError("--resume-from must name a partial export from this origin and object selection");
      }
    }
    if (existsSync(staging)) throw usageError(`${staging} already exists; use a new --out and pass it with --resume-from`);
    mkdirSync(dirname(staging), { recursive: true, mode: 0o700 });
    mkdirSync(staging, { mode: 0o700 });
    writeProgress(join(staging, ".export-source.json"), checkpointSource);
    const exported = await eachLimited(objects, context.flag("serial") ? 1 : OBJECT_CONCURRENCY,
      object => exportObject(context, object, staging, previous));
    const index: BackupIndex = { format: BACKUP_FORMAT, exportFormat: EXPORT_FORMAT, origin: context.origin, createdAtMs: context.now(), objects };
    writeExclusive(join(staging, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    verifyBackup(staging);
    for (const object of objects) {
      const target = join(staging, directoryName(object));
      for (const table of readObjectManifest(staging, object).tables) unlinkSync(join(target, checkpointName(table.name)));
    }
    unlinkSync(join(staging, ".export-source.json"));
    if (existsSync(directory)) rmdirSync(directory);
    renameSync(staging, directory);
    return { payload: { directory, objects: exported } };
  },
  render(payload) {
    return [`exported ${payload.objects.length} objects to ${payload.directory}`, ...payload.objects.map(entry => `  ${entry.object}: ${entry.tables} tables, ${entry.rows} rows`)];
  }
});

export const backupImportCommand = defineCommand<{ readonly objects: readonly { readonly object: string; readonly rows: number }[] }>({
  name: "backup import",
  requestTimeoutMs: 120_000,
  summary: "restore a verified backup into fresh, empty durable objects",
  description: [
    "MUTATION: verifies every table file against its manifest, then for each object begins an import (the object must be empty and have identical table definitions), sends rows from the recorded progress, and finishes, which re-checks every count and digest before the object reopens.",
    "Rerunning after an interruption resumes from each table's recorded progress."
  ],
  access: "mutation",
  options: {
    in: { type: "string", placeholder: "DIR", required: true, description: "backup directory from `backup export`" },
    object: { type: "string", placeholder: "OBJECT", description: "one object from the backup (default: all)" }
  },
  examples: ["statsctl backup import --in .work/backups/2026-11-14 --origin http://127.0.0.1:8787"],
  limitations: ["An object that already holds data refuses the import; import into a new namespace or storage scope."],
  async run(context) {
    const directory = resolve(invocationDirectory(), context.option("in") ?? "");
    verifyBackup(directory);
    const index = readIndex(directory);
    const objects = selected(context, index.objects);
    const imported = await eachLimited(objects, OBJECT_CONCURRENCY, object => importObject(context, directory, object));
    return { payload: { objects: imported } };
  },
  render(payload) {
    return [`imported ${payload.objects.length} objects`, ...payload.objects.map(entry => `  ${entry.object}: ${entry.rows} rows`)];
  }
});
