import type { AnalyticsQuery } from "../src/cloudflare/projects/collector.ts";
import type { ProbeFetch } from "../src/projects/probes.ts";
import type { BoundQuery } from "../src/projects/queries.ts";

export interface CollectionFixture {
  readonly capturedAtMs: number;
  readonly projectsJson: string;
  readonly responses: Readonly<Record<string, { readonly data: readonly unknown[]; readonly rowsRead: number }>>;
}

export function replayKey(bound: BoundQuery): string {
  const params = Object.entries(bound.params).filter(([name]) => name !== "start").sort(([left], [right]) => left.localeCompare(right));
  return `${bound.query}\n${JSON.stringify(params)}`;
}

function shiftedDay(day: string, hour: number, slot: number, offsetMs: number): { day: string; hour: number; slot: number } {
  const at = new Date(Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000 + slot * 300_000 - offsetMs);
  return { day: at.toISOString().slice(0, 10), hour: at.getUTCHours(), slot: Math.floor(at.getUTCMinutes() / 5) };
}

function shiftedDatetime(text: string, offsetMs: number): string {
  return new Date(Date.parse(`${text.replace(" ", "T")}Z`) - offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

function shifted(row: unknown, offsetMs: number): unknown {
  if (offsetMs === 0) return row;
  const record = { ...(row as Record<string, unknown>) };
  if (typeof record["day"] === "string") Object.assign(record, shiftedDay(record["day"], Number(record["hour"]), Number(record["slot"]), offsetMs));
  if (typeof record["bucket"] === "string") record["bucket"] = shiftedDatetime(record["bucket"], offsetMs);
  return record;
}

export function replayAnalytics(fixture: CollectionFixture, offsetMs: number): AnalyticsQuery {
  return {
    query: async (bound) => {
      const response = fixture.responses[replayKey(bound)];
      if (response === undefined) throw new Error(`the fixture has no response for ${bound.query.slice(0, 80)}`);
      return { data: response.data.map(row => shifted(row, offsetMs)), statistics: { rows_read: response.rowsRead } };
    }
  };
}

export const recordedProbe: ProbeFetch = async () => ({ status: 200, body: null });
