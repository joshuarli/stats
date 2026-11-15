import type { SqlStatements } from "../../core/sql.ts";
import { aggregateMeasures, measureColumns, measureDefinitions, scalarMeasures, updateMeasures } from "./measures.ts";
import { APPLICATION_ROLLUP_TABLE, APPLICATION_SUMMARY_TABLE } from "./schema.ts";

const bucket = (value: string, unit: number) => `(${value} - ((${value} % ${unit} + ${unit}) % ${unit}))`;
const columns = `service, resolution, bucket, operation_present, operation, ${measureColumns}`;

export function upgradeApplicationRollups(db: SqlStatements): void {
  if (db.rows("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", APPLICATION_ROLLUP_TABLE).length > 0) return;
  db.run(`CREATE TABLE ${APPLICATION_ROLLUP_TABLE} (
    service TEXT NOT NULL, resolution INTEGER NOT NULL CHECK (resolution IN (1000, 60000)),
    bucket INTEGER NOT NULL, operation_present INTEGER NOT NULL CHECK (operation_present IN (0, 1)),
    operation TEXT NOT NULL, ${measureDefinitions},
    CHECK (operation_present = 1 OR operation = ''), CHECK (bucket % resolution = 0),
    PRIMARY KEY (service, resolution, bucket, operation_present, operation)
  ) WITHOUT ROWID`);
  const insert = (unit: number) => `INSERT INTO ${APPLICATION_ROLLUP_TABLE} (${columns}) SELECT NEW.service, ${unit}, ${bucket("NEW.event_at", unit)}, NEW.operation IS NOT NULL, COALESCE(NEW.operation, ''), ${scalarMeasures("NEW")} WHERE true ON CONFLICT DO UPDATE SET ${updateMeasures};`;
  const key = (unit: number) => `service = OLD.service AND resolution = ${unit} AND bucket = ${bucket("OLD.event_at", unit)} AND operation_present = (OLD.operation IS NOT NULL) AND operation = COALESCE(OLD.operation, '')`;
  const rebuildSecond = `DELETE FROM ${APPLICATION_ROLLUP_TABLE} WHERE ${key(1000)};
    INSERT INTO ${APPLICATION_ROLLUP_TABLE} (${columns}) SELECT service, 1000, ${bucket("event_at", 1000)}, operation IS NOT NULL, COALESCE(operation, ''), ${aggregateMeasures("v")} FROM (SELECT p.*, ${scalarMeasures("p")} FROM ${APPLICATION_SUMMARY_TABLE} p WHERE p.service = OLD.service AND p.event_at >= ${bucket("OLD.event_at", 1000)} AND p.event_at < ${bucket("OLD.event_at", 1000)} + 1000 AND p.operation IS OLD.operation) v GROUP BY service, operation;`;
  const rebuildMinute = `DELETE FROM ${APPLICATION_ROLLUP_TABLE} WHERE ${key(60000)};
    INSERT INTO ${APPLICATION_ROLLUP_TABLE} (${columns}) SELECT service, 60000, ${bucket("bucket", 60000)}, operation_present, operation, ${aggregateMeasures("v")} FROM ${APPLICATION_ROLLUP_TABLE} v WHERE service = OLD.service AND resolution = 1000 AND bucket >= ${bucket("OLD.event_at", 60000)} AND bucket < ${bucket("OLD.event_at", 60000)} + 60000 AND operation_present = (OLD.operation IS NOT NULL) AND operation = COALESCE(OLD.operation, '') GROUP BY service, operation_present, operation;`;
  db.run(`CREATE TRIGGER observe_rollup_insert AFTER INSERT ON ${APPLICATION_SUMMARY_TABLE} BEGIN ${insert(1000)} ${insert(60000)} END`);
  db.run(`CREATE TRIGGER observe_rollup_delete AFTER DELETE ON ${APPLICATION_SUMMARY_TABLE} BEGIN ${rebuildSecond} ${rebuildMinute} END`);
  db.run(`INSERT INTO ${APPLICATION_ROLLUP_TABLE} (${columns}) SELECT service, 1000, ${bucket("event_at", 1000)}, operation IS NOT NULL, COALESCE(operation, ''), ${aggregateMeasures("v")} FROM (SELECT p.*, ${scalarMeasures("p")} FROM ${APPLICATION_SUMMARY_TABLE} p) v GROUP BY service, ${bucket("event_at", 1000)}, operation`);
  db.run(`INSERT INTO ${APPLICATION_ROLLUP_TABLE} (${columns}) SELECT service, 60000, ${bucket("bucket", 60000)}, operation_present, operation, ${aggregateMeasures("v")} FROM ${APPLICATION_ROLLUP_TABLE} v WHERE resolution = 1000 GROUP BY service, ${bucket("bucket", 60000)}, operation_present, operation`);
}
