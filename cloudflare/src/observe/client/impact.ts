import type { RouteComparison } from "../core/store.ts";

export interface RouteSide {
  readonly requests: number;
  readonly cpuMeanMs: number;
  readonly cpuStdErrMs: number | null;
  readonly p95WallMs: number | null;
}

export interface RouteShift {
  readonly stage: RouteComparison["stage"];
  readonly label: string;
  readonly before: RouteSide | null;
  readonly after: RouteSide | null;
  readonly cpuChangeMs: number | null;
  readonly twoStdErrMs: number | null;
  readonly exceedsTwoStdErr: boolean;
}

function side(route: RouteComparison, versions: ReadonlySet<string>, introduced: boolean): RouteSide | null {
  const rows = route.versions.filter(version => versions.has(version.version) === introduced && version.requests > 0 && version.cpuMeanMs !== null);
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  if (requests === 0) return null;
  const cpuMeanMs = rows.reduce((sum, row) => sum + row.requests * row.cpuMeanMs!, 0) / requests;
  const variance = rows.every(row => row.cpuStdErrMs !== null) ? rows.reduce((sum, row) => sum + (row.requests * row.cpuStdErrMs!) ** 2, 0) / requests ** 2 : null;
  return { requests, cpuMeanMs, cpuStdErrMs: variance === null ? null : Math.sqrt(variance), p95WallMs: rows.length === 1 ? rows[0]!.p95WallMs : null };
}

export function routeShift(route: RouteComparison, introduced: readonly string[]): RouteShift {
  const versions = new Set(introduced);
  const before = side(route, versions, false);
  const after = side(route, versions, true);
  const cpuChangeMs = before === null || after === null ? null : after.cpuMeanMs - before.cpuMeanMs;
  const twoStdErrMs = before?.cpuStdErrMs == null || after?.cpuStdErrMs == null ? null : 2 * Math.sqrt(before.cpuStdErrMs ** 2 + after.cpuStdErrMs ** 2);
  return { stage: route.stage, label: route.label, before, after, cpuChangeMs, twoStdErrMs, exceedsTwoStdErr: cpuChangeMs !== null && twoStdErrMs !== null && Math.abs(cpuChangeMs) > twoStdErrMs };
}
