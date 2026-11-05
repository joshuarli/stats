import { Response as MiniflareResponse, type Request as MiniflareRequest, type V4WorkerOptions } from "miniflare";
import type { BoundQuery } from "../src/projects/queries.ts";
import { DATASET_OF, expectedQueries, queryKey, rows, type Dataset, type ExpectedQuery, type QueryKind, type Scenario } from "./scenario.ts";
import type { AnalyticsProvider, BuiltWorker } from "./topology.ts";

export const UNEXPECTED_QUERY = "unexpected analytics query";

export type CallOutcome = "answered" | "failed" | "unexpected" | "no scenario";

export interface AnalyticsCall {
  readonly query: string;
  readonly params: BoundQuery["params"];
  readonly kind: QueryKind | null;
  readonly dataset: Dataset | null;
  readonly project: string | null;
  readonly outcome: CallOutcome;
  readonly rows: number;
}

export interface OfflineAnalytics {
  readonly binding: Exclude<AnalyticsProvider, "unbound">;
  readonly worker: V4WorkerOptions;
  readonly calls: readonly AnalyticsCall[];
  use(model: Scenario): void;
}

const SERVICE = "analytics-provider";
const ENTRYPOINT = "Analytics";
const BRIDGE = `import { WorkerEntrypoint } from "cloudflare:workers";
export class ${ENTRYPOINT} extends WorkerEntrypoint {
  async query(request) {
    const response = await this.env.HOST.fetch("http://analytics.local/query", { method: "POST", body: JSON.stringify({ query: request.query, params: request.params }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  }
}
export default { fetch() { return new Response("not found", { status: 404 }); } };`;

function isBound(value: unknown): value is BoundQuery {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["query"] === "string" && typeof record["params"] === "object" && record["params"] !== null;
}

export function offlineAnalytics(stats: BuiltWorker): OfflineAnalytics {
  const calls: AnalyticsCall[] = [];
  let model: Scenario | null = null;
  let expected = new Map<string, ExpectedQuery>();
  const fail = (status: number, error: string) => new MiniflareResponse(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
  const answer = async (request: MiniflareRequest): Promise<MiniflareResponse> => {
    const body: unknown = await request.json();
    if (!isBound(body)) return fail(400, "analytics request is not a bound query");
    const record = (match: ExpectedQuery | undefined, outcome: CallOutcome, count: number) => {
      calls.push({ query: body.query, params: body.params, kind: match?.kind ?? null, dataset: match === undefined ? null : DATASET_OF[match.kind], project: match?.project ?? null, outcome, rows: count });
    };
    if (model === null) {
      record(undefined, "no scenario", 0);
      return fail(500, "no analytics scenario is in use");
    }
    const match = expected.get(queryKey(body));
    if (match === undefined) {
      record(undefined, "unexpected", 0);
      return fail(500, UNEXPECTED_QUERY);
    }
    const dataset = DATASET_OF[match.kind];
    if (model.modes[dataset].kind === "fail") {
      record(match, "failed", 0);
      return fail(500, `analytics dataset ${dataset} failed`);
    }
    const data = rows(model, match);
    record(match, "answered", data.length);
    return new MiniflareResponse(JSON.stringify({ data, rows: data.length, statistics: { rows_read: data.length } }), { headers: { "content-type": "application/json" } });
  };
  return {
    binding: { service: SERVICE, entrypoint: ENTRYPOINT },
    worker: { name: SERVICE, modules: true, script: BRIDGE, compatibilityDate: stats.compatibilityDate, compatibilityFlags: [...stats.compatibilityFlags], serviceBindings: { HOST: answer } },
    calls,
    use(next) {
      model = next;
      expected = new Map(expectedQueries(next).map(query => [queryKey(query.bound), query]));
    }
  };
}
