import type { ApplicationTotals } from "./telemetry.ts";

const measures = [
  ["events", "1", "SUM"],
  ["failed", "outcome <> 'ok'", "SUM"],
  ["cancelled", "outcome = 'cancelled'", "SUM"],
  ["requests", "http_status IS NOT NULL", "SUM"],
  ["requestDurationMsSum", "CASE WHEN http_status IS NOT NULL THEN duration_ms ELSE 0 END", "SUM"],
  ["requestDurationMsMax", "CASE WHEN http_status IS NOT NULL THEN duration_ms ELSE 0 END", "MAX"],
  ["status2xx", "CASE WHEN http_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END", "SUM"],
  ["status3xx", "CASE WHEN http_status BETWEEN 300 AND 399 THEN 1 ELSE 0 END", "SUM"],
  ["status4xx", "CASE WHEN http_status BETWEEN 400 AND 499 THEN 1 ELSE 0 END", "SUM"],
  ["status5xx", "CASE WHEN http_status BETWEEN 500 AND 599 THEN 1 ELSE 0 END", "SUM"],
  ["durationMsSum", "duration_ms", "SUM"],
  ["durationMsMax", "duration_ms", "MAX"],
  ["firstAtMs", "event_at", "MIN"],
  ["lastAtMs", "event_at", "MAX"]
] as const satisfies readonly (readonly [keyof ApplicationTotals, string, "SUM" | "MIN" | "MAX"])[];

const column = (name: string) => name.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`);
export const measureColumns = measures.map(([name]) => column(name)).join(", ");
export const measureDefinitions = measures.map(([name]) => `${column(name)} INTEGER${name === "events" ? " NOT NULL CHECK (events > 0)" : ""}`).join(", ");
export function scalarMeasures(alias: string): string {
  return measures.map(([name, expression]) => `${expression.replace(/\b(event_at|duration_ms|outcome|http_status)\b/gu, field => field === "http_status" ? `NULLIF(${alias}.http_status, 0)` : `${alias}.${field}`)} AS ${column(name)}`).join(", ");
}
export function aggregateMeasures(alias: string): string {
  return measures.map(([name, , aggregate]) => `${aggregate}(${alias}.${column(name)}) AS ${name}`).join(", ");
}
export const updateMeasures = measures.map(([name, , aggregate]) => `${column(name)} = CASE WHEN ${column(name)} IS NULL THEN excluded.${column(name)} WHEN excluded.${column(name)} IS NULL THEN ${column(name)} ELSE ${aggregate === "SUM" ? `${column(name)} + excluded.${column(name)}` : `${aggregate}(${column(name)}, excluded.${column(name)})`} END`).join(", ");
