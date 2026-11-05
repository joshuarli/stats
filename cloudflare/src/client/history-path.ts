import type { RangeKey } from "../limits.ts";
import type { ProjectSummary } from "./project-model.ts";

export type HistoryQuery = { readonly range: RangeKey } | { readonly fromMs: number; readonly toMs: number };

export interface HistoryKinds {
  readonly durableObjects: boolean;
  readonly d1: boolean;
  readonly probes: boolean;
}

export function windowParams(query: HistoryQuery): string {
  return "range" in query ? `range=${encodeURIComponent(query.range)}` : `from=${Math.round(query.fromMs)}&to=${Math.round(query.toMs)}`;
}

export function projectHistoryPath(projectId: string, query: HistoryQuery, options: HistoryKinds): string {
  const kinds = ["worker", "routes", "r2", "collector"];
  if (options.durableObjects) kinds.push("durable-objects");
  if (options.d1) kinds.push("d1", "d1-statements");
  if (options.probes) kinds.push("probes");
  return `/api/v1/projects/${encodeURIComponent(projectId)}/history?${windowParams(query)}&kinds=${kinds.join(",")}`;
}

export function historyKinds(project: Pick<ProjectSummary, "durableObjectNamespaces" | "d1Databases" | "probes">): HistoryKinds {
  return { durableObjects: project.durableObjectNamespaces.length > 0, d1: project.d1Databases.length > 0, probes: project.probes.length > 0 };
}
