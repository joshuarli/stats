import { readLimitedText } from "../../body.ts";
import type { SqlDatabase, SqlValue } from "../sql.ts";
import { beginImport, exportManifest, exportPage, finishImport, importProgress, importRows, MAX_PAGE_BYTES, MAX_PAGE_ROWS, maintenanceState, setFence, SnapshotError, type ObjectManifest } from "./snapshot.ts";

export const MAINTENANCE_PATH = /^\/(maintenance|export\/manifest|export\/rows|import\/begin|import\/rows|import\/finish|import\/progress)$/u;
const MAX_IMPORT_BODY_BYTES = MAX_PAGE_BYTES * 2;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface MaintainedObject {
  readonly name: string;
  readonly sql: SqlDatabase;
  readonly now: () => number;
  readonly alarmAtMs: () => Promise<number | null>;
  readonly rearm: () => Promise<void>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

const STATUS: Readonly<Record<SnapshotError["code"], number>> = { incompatible: 409, conflict: 409, integrity: 422, invalid: 400, maintenance: 409 };

async function body(request: Request, limit: number): Promise<unknown> {
  const text = await readLimitedText(request, limit);
  if (text === null) throw new SnapshotError("invalid", "body exceeds the cap");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SnapshotError("invalid", "body must be valid JSON");
  }
}

function cursor(value: string | null): readonly SqlValue[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new SnapshotError("invalid", "after must be a JSON array"); }
  if (!Array.isArray(parsed) || parsed.some(entry => entry !== null && typeof entry !== "string" && typeof entry !== "number")) throw new SnapshotError("invalid", "after must be a JSON array of scalars");
  return parsed as SqlValue[];
}

function rowsOf(value: unknown): readonly (readonly SqlValue[])[] {
  if (!Array.isArray(value) || value.length > MAX_PAGE_ROWS) throw new SnapshotError("invalid", `rows must be an array of at most ${MAX_PAGE_ROWS} rows`);
  for (const row of value) if (!Array.isArray(row) || row.some(entry => entry !== null && typeof entry !== "string" && typeof entry !== "number")) throw new SnapshotError("invalid", "each row must be an array of scalars");
  return value as SqlValue[][];
}

export async function handleMaintenance(request: Request, path: string, object: MaintainedObject): Promise<Response | null> {
  const route = MAINTENANCE_PATH.exec(path)?.[1];
  if (route === undefined) return null;
  const url = new URL(request.url);
  const { sql } = object;
  try {
    if (route === "maintenance" && request.method === "GET") return json({ object: object.name, state: maintenanceState(sql) });
    if (route === "maintenance" && request.method === "POST") {
      const value = await body(request, 256) as { fenced?: unknown };
      if (typeof value?.fenced !== "boolean") throw new SnapshotError("invalid", "fenced must be a boolean");
      const state = setFence(sql, value.fenced);
      if (state === "open") await object.rearm();
      return json({ object: object.name, state });
    }
    if (route === "export/manifest" && request.method === "GET") return json(exportManifest(sql, object.name, object.now(), await object.alarmAtMs()));
    if (route === "export/rows" && request.method === "GET") {
      const table = url.searchParams.get("table") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? MAX_PAGE_ROWS);
      return json(exportPage(sql, table, cursor(url.searchParams.get("after")), Number.isFinite(limit) ? limit : MAX_PAGE_ROWS));
    }
    if (route === "import/begin" && request.method === "POST") {
      const manifest = await body(request, MAX_MANIFEST_BYTES) as ObjectManifest;
      if (manifest?.object !== object.name) throw new SnapshotError("incompatible", `the export is for ${String(manifest?.object)}, not ${object.name}`);
      beginImport(sql, manifest);
      return json({ object: object.name, state: maintenanceState(sql), progress: importProgress(sql) });
    }
    if (route === "import/progress" && request.method === "GET") return json({ object: object.name, state: maintenanceState(sql), progress: importProgress(sql) });
    if (route === "import/rows" && request.method === "POST") {
      const value = await body(request, MAX_IMPORT_BODY_BYTES) as { table?: unknown; offset?: unknown; rows?: unknown };
      if (typeof value?.table !== "string" || typeof value.offset !== "number") throw new SnapshotError("invalid", "table and offset are required");
      return json(importRows(sql, value.table, value.offset, rowsOf(value.rows)));
    }
    if (route === "import/finish" && request.method === "POST") {
      const manifest = finishImport(sql);
      await object.rearm();
      return json({ object: object.name, state: maintenanceState(sql), tables: manifest.tables.map(table => ({ name: table.name, rows: table.rows, sha256: table.sha256 })) });
    }
    return failure(405, "invalid_request", "method not allowed");
  } catch (error) {
    if (error instanceof SnapshotError) return failure(STATUS[error.code], error.code, error.message);
    throw error;
  }
}

export function maintenanceDenial(sql: SqlDatabase, method: string): Response | null {
  const state = maintenanceState(sql);
  if (state === "open" || (state === "fenced" && (method === "GET" || method === "HEAD"))) return null;
  return Response.json({ error: { code: "maintenance", message: state === "importing" ? "an import is in progress" : "writes are paused for maintenance" } }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
}
