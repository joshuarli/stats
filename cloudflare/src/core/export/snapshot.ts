import { createHash } from "node:crypto";
import type { SqlDatabase, SqlValue } from "../sql.ts";

export const EXPORT_FORMAT = "stats-export/1";
export const MAX_PAGE_ROWS = 2000;
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

const MAINTENANCE_TABLE = "stats_maintenance";
const IMPORT_TABLE = "stats_import";
const INTERNAL_TABLES: ReadonlySet<string> = new Set([MAINTENANCE_TABLE, IMPORT_TABLE, "schema_version"]);
const NAME = /^[a-z_][a-z0-9_]{0,62}$/u;

export type MaintenanceState = "open" | "fenced" | "importing";

export interface TableManifest {
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly string[];
  readonly key: readonly string[];
  readonly rows: number;
  readonly sha256: string;
}

export interface ObjectManifest {
  readonly format: typeof EXPORT_FORMAT;
  readonly object: string;
  readonly schema: SchemaVersion;
  readonly exportedAtMs: number;
  readonly alarmAtMs: number | null;
  readonly tables: readonly TableManifest[];
}

export interface SchemaVersion {
  readonly sha256: string;
}

export interface Page {
  readonly rows: readonly (readonly SqlValue[])[];
  readonly next: readonly SqlValue[] | null;
}

export class SnapshotError extends Error {
  readonly code: "incompatible" | "conflict" | "integrity" | "invalid" | "maintenance";

  constructor(code: SnapshotError["code"], message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function quote(name: string): string {
  if (!NAME.test(name)) throw new SnapshotError("invalid", `unexpected identifier ${name}`);
  return `"${name}"`;
}

export function initializeMaintenance(sql: Pick<SqlDatabase, "run">): void {
  sql.run(`CREATE TABLE IF NOT EXISTS ${MAINTENANCE_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL CHECK (state IN ('fenced', 'importing'))) STRICT`);
  sql.run(`CREATE TABLE IF NOT EXISTS ${IMPORT_TABLE} (table_name TEXT PRIMARY KEY, manifest TEXT NOT NULL, rows INTEGER NOT NULL) STRICT`);
}

export function maintenanceState(sql: SqlDatabase): MaintenanceState {
  return sql.rows<{ state: MaintenanceState }>(`SELECT state FROM ${MAINTENANCE_TABLE} WHERE id = 1`)[0]?.state ?? "open";
}

export function setFence(sql: SqlDatabase, fenced: boolean): MaintenanceState {
  initializeMaintenance(sql);
  const state = maintenanceState(sql);
  if (state === "importing") throw new SnapshotError("maintenance", "an import is in progress");
  if (fenced) sql.run(`INSERT OR REPLACE INTO ${MAINTENANCE_TABLE} (id, state) VALUES (1, 'fenced')`);
  else sql.run(`DELETE FROM ${MAINTENANCE_TABLE}`);
  return fenced ? "fenced" : "open";
}

interface TableShape {
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly string[];
  readonly key: readonly string[];
  readonly rowid: boolean;
}

function shapes(sql: SqlDatabase): TableShape[] {
  const tables = sql.rows<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name");
  return tables.filter(table => !INTERNAL_TABLES.has(table.name)).map(table => {
    const info = sql.rows<{ name: string; pk: number }>(`PRAGMA table_info(${quote(table.name)})`);
    const columns = info.map(column => column.name);
    for (const column of columns) quote(column);
    const primary = info.filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name);
    const rowid = primary.length === 0;
    return { name: table.name, sql: table.sql, columns, key: rowid ? ["rowid"] : primary, rowid };
  });
}

function checkValue(table: string, value: SqlValue): SqlValue {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new SnapshotError("integrity", `${table} holds an integer outside the exact JSON range`);
  return value;
}

function selectList(shape: TableShape): string {
  return [...(shape.rowid ? ["rowid AS __rowid"] : []), ...shape.columns.map(quote)].join(", ");
}

function keyOf(shape: TableShape, row: Record<string, SqlValue>): SqlValue[] {
  return shape.rowid ? [row["__rowid"]!] : shape.key.map(column => row[column]!);
}

function keyColumns(shape: TableShape): string {
  return shape.rowid ? "rowid" : shape.key.map(quote).join(", ");
}

function rowValues(shape: TableShape, row: Record<string, SqlValue>): SqlValue[] {
  return shape.columns.map(column => checkValue(shape.name, row[column] ?? null));
}

function digestTable(sql: SqlDatabase, shape: TableShape): { rows: number; sha256: string } {
  const hash = createHash("sha256");
  let rows = 0;
  let after: SqlValue[] | null = null;
  for (;;) {
    const page = sql.rows<Record<string, SqlValue>>(`SELECT ${selectList(shape)} FROM ${quote(shape.name)} ${afterClause(shape, after)} ORDER BY ${keyColumns(shape)} LIMIT ?`, ...(after ?? []), MAX_PAGE_ROWS);
    for (const row of page) {
      hash.update(JSON.stringify(rowValues(shape, row)));
      hash.update("\n");
      rows += 1;
    }
    if (page.length < MAX_PAGE_ROWS) break;
    after = keyOf(shape, page.at(-1)!);
  }
  return { rows, sha256: hash.digest("hex") };
}

function schemaVersion(sql: SqlDatabase): SchemaVersion {
  const hash = createHash("sha256");
  for (const shape of shapes(sql)) hash.update(`${shape.name}\n${normalized(shape.sql)}\n`);
  return { sha256: hash.digest("hex") };
}

export function exportManifest(sql: SqlDatabase, object: string, nowMs: number, alarmAtMs: number | null): ObjectManifest {
  if (maintenanceState(sql) !== "fenced") throw new SnapshotError("maintenance", "export needs a fenced object");
  return {
    format: EXPORT_FORMAT,
    object,
    schema: schemaVersion(sql),
    exportedAtMs: nowMs,
    alarmAtMs,
    tables: shapes(sql).map(shape => ({ name: shape.name, sql: shape.sql, columns: shape.columns, key: shape.key, ...digestTable(sql, shape) }))
  };
}

function shapeOf(sql: SqlDatabase, table: string): TableShape {
  const shape = shapes(sql).find(candidate => candidate.name === table);
  if (shape === undefined) throw new SnapshotError("invalid", `unknown table ${table}`);
  return shape;
}

function afterClause(shape: TableShape, after: readonly SqlValue[] | null): string {
  if (after === null) return "";
  if (after.length !== shape.key.length) throw new SnapshotError("invalid", `cursor for ${shape.name} has ${after.length} values, not ${shape.key.length}`);
  return `WHERE (${keyColumns(shape)}) > (${after.map(() => "?").join(", ")})`;
}

export function exportPage(sql: SqlDatabase, table: string, after: readonly SqlValue[] | null, limit: number): Page {
  if (maintenanceState(sql) !== "fenced") throw new SnapshotError("maintenance", "export needs a fenced object");
  const shape = shapeOf(sql, table);
  const bounded = Math.max(1, Math.min(MAX_PAGE_ROWS, Math.floor(limit)));
  const found = sql.rows<Record<string, SqlValue>>(`SELECT ${selectList(shape)} FROM ${quote(shape.name)} ${afterClause(shape, after)} ORDER BY ${keyColumns(shape)} LIMIT ?`, ...(after ?? []), bounded + 1);
  const rows: SqlValue[][] = [];
  let bytes = 0;
  let next: SqlValue[] | null = null;
  for (const [index, row] of found.entries()) {
    const values = rowValues(shape, row);
    const size = JSON.stringify(values).length;
    if (index === bounded || (rows.length > 0 && bytes + size > MAX_PAGE_BYTES)) break;
    rows.push(values);
    bytes += size;
    next = keyOf(shape, row);
  }
  return { rows, next: rows.length < found.length ? next : null };
}

function normalized(definition: string): string {
  return definition.replace(/\s+/gu, " ").replace(/\s*([(),])\s*/gu, "$1").trim();
}

function sameShape(manifest: TableManifest, shape: TableShape): boolean {
  return normalized(manifest.sql) === normalized(shape.sql) && JSON.stringify(manifest.columns) === JSON.stringify(shape.columns) && JSON.stringify(manifest.key) === JSON.stringify(shape.key);
}

export function beginImport(sql: SqlDatabase, manifest: ObjectManifest): void {
  if (manifest.format !== EXPORT_FORMAT) throw new SnapshotError("incompatible", `unsupported export format ${String(manifest.format)}`);
  if (manifest.object.length === 0) throw new SnapshotError("incompatible", "the export names no object");
  sql.transaction(() => {
    const state = maintenanceState(sql);
    const existing = sql.rows<{ manifest: string }>(`SELECT manifest FROM ${IMPORT_TABLE} LIMIT 1`)[0];
    if (state === "importing") {
      if (existing?.manifest !== JSON.stringify(manifest)) throw new SnapshotError("conflict", "a different import is in progress");
      return;
    }
    const local = shapes(sql);
    const names = local.map(shape => shape.name);
    if (JSON.stringify(names) !== JSON.stringify(manifest.tables.map(table => table.name))) throw new SnapshotError("incompatible", "export tables do not match this object's tables");
    for (const shape of local) {
      const expected = manifest.tables.find(table => table.name === shape.name)!;
      if (!sameShape(expected, shape)) throw new SnapshotError("incompatible", `table ${shape.name} has a different definition`);
      if (sql.rows<{ found: number }>(`SELECT EXISTS (SELECT 1 FROM ${quote(shape.name)}) AS found`)[0]?.found === 1) throw new SnapshotError("conflict", `import needs an empty object; ${shape.name} has rows`);
    }
    sql.run(`INSERT OR REPLACE INTO ${MAINTENANCE_TABLE} (id, state) VALUES (1, 'importing')`);
    for (const table of manifest.tables) sql.run(`INSERT INTO ${IMPORT_TABLE} (table_name, manifest, rows) VALUES (?, ?, 0)`, table.name, JSON.stringify(manifest));
  });
}

export interface ImportProgress {
  readonly table: string;
  readonly rows: number;
}

export function importProgress(sql: SqlDatabase): readonly ImportProgress[] {
  initializeMaintenance(sql);
  return sql.rows<{ table_name: string; rows: number }>(`SELECT table_name, rows FROM ${IMPORT_TABLE} ORDER BY table_name`).map(row => ({ table: row.table_name, rows: row.rows }));
}

export function importRows(sql: SqlDatabase, table: string, offset: number, rows: readonly (readonly SqlValue[])[]): ImportProgress {
  return sql.transaction(() => {
    if (maintenanceState(sql) !== "importing") throw new SnapshotError("maintenance", "no import is in progress");
    const progress = sql.rows<{ rows: number }>(`SELECT rows FROM ${IMPORT_TABLE} WHERE table_name = ?`, table)[0];
    if (progress === undefined) throw new SnapshotError("invalid", `table ${table} is not part of this import`);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SnapshotError("invalid", "offset must be a non-negative integer");
    if (offset + rows.length <= progress.rows) return { table, rows: progress.rows };
    if (offset > progress.rows) throw new SnapshotError("conflict", `${table} has ${progress.rows} imported rows; a page at offset ${offset} would leave a gap`);
    const fresh = rows.slice(progress.rows - offset);
    const shape = shapeOf(sql, table);
    const insert = `INSERT INTO ${quote(shape.name)} (${shape.columns.map(quote).join(", ")}) VALUES (${shape.columns.map(() => "?").join(", ")})`;
    for (const values of fresh) {
      if (values.length !== shape.columns.length) throw new SnapshotError("invalid", `a ${table} row has ${values.length} values, not ${shape.columns.length}`);
      for (const value of values) checkValue(table, value);
      sql.run(insert, ...values);
    }
    const total = progress.rows + fresh.length;
    sql.run(`UPDATE ${IMPORT_TABLE} SET rows = ? WHERE table_name = ?`, total, table);
    return { table, rows: total };
  });
}

export function finishImport(sql: SqlDatabase): ObjectManifest {
  if (maintenanceState(sql) !== "importing") throw new SnapshotError("maintenance", "no import is in progress");
  const stored = sql.rows<{ manifest: string }>(`SELECT manifest FROM ${IMPORT_TABLE} LIMIT 1`)[0];
  if (stored === undefined) throw new SnapshotError("integrity", "the import has no manifest");
  const manifest = JSON.parse(stored.manifest) as ObjectManifest;
  for (const table of manifest.tables) {
    const actual = digestTable(sql, shapeOf(sql, table.name));
    if (actual.rows !== table.rows || actual.sha256 !== table.sha256) throw new SnapshotError("integrity", `${table.name} holds ${actual.rows} rows with digest ${actual.sha256.slice(0, 12)}, expected ${table.rows} with ${table.sha256.slice(0, 12)}`);
  }
  sql.transaction(() => {
    sql.run(`DELETE FROM ${IMPORT_TABLE}`);
    sql.run(`DELETE FROM ${MAINTENANCE_TABLE}`);
  });
  return manifest;
}
