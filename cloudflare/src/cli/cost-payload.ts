import type { Track } from "../client/columns.ts";
import type { CostReport, PlanBillReport, RankEntry, ReportLine } from "../cost/report.ts";

export const CHILD_LIMIT = 15;

export interface Omitted {
  readonly count: number;
  readonly monthly: number;
}

export type PresentedLine = Omit<ReportLine, "children" | "trend"> & {
  readonly trend?: Track | null;
  readonly children: readonly PresentedLine[];
  readonly omitted: Omitted | null;
};

type IsolatedPlanBill = Extract<PlanBillReport, { readonly kind: "isolated" }>;

export type PresentedPlanBill =
  | Exclude<PlanBillReport, IsolatedPlanBill>
  | (Omit<IsolatedPlanBill, "billed" | "projected"> & Partial<Pick<IsolatedPlanBill, "billed" | "projected">>);

export interface PresentedRanking {
  readonly byCost: readonly RankEntry[];
  readonly byChange: readonly RankEntry[];
  readonly omitted: { readonly byCost: number; readonly byChange: number };
}

export type PresentedReport = Omit<CostReport, "lines" | "ranking" | "planBill"> & {
  readonly lines: readonly PresentedLine[];
  readonly ranking: PresentedRanking;
  readonly planBill: PresentedPlanBill;
};

const monthlyNow = (line: ReportLine): number => line.price.kind === "priced" ? line.price.monthly.now : -1;

function keepers(children: readonly ReportLine[]): ReadonlySet<ReportLine> {
  const pinned = children.filter(child => child.kind === "unrouted" || child.kind === "uncollected");
  const ranked = children.filter(child => !pinned.includes(child)).sort((a, b) => monthlyNow(b) - monthlyNow(a) || a.id.localeCompare(b.id));
  return new Set([...pinned, ...ranked].slice(0, Math.max(CHILD_LIMIT, pinned.length)));
}

function presentLine(line: ReportLine, series: boolean): PresentedLine {
  const { children, trend, ...rest } = line;
  const kept = children.length > CHILD_LIMIT ? keepers(children) : null;
  const shown = kept === null ? children : children.filter(child => kept.has(child));
  const dropped = kept === null ? [] : children.filter(child => !kept.has(child));
  return {
    ...rest,
    ...(series ? { trend } : {}),
    children: shown.map(child => presentLine(child, series)),
    omitted: dropped.length === 0 ? null : { count: dropped.length, monthly: dropped.reduce((sum, child) => sum + Math.max(0, monthlyNow(child)), 0) }
  };
}

function presentPlanBill(plan: PlanBillReport, series: boolean): PresentedPlanBill {
  if (plan.kind !== "isolated") return plan;
  const { billed, projected, ...rest } = plan;
  return series ? { ...rest, billed, projected } : rest;
}

export function presentReport(report: CostReport, series: boolean): PresentedReport {
  const { lines, ranking, planBill, ...rest } = report;
  return {
    ...rest,
    lines: lines.map(line => presentLine(line, series)),
    ranking: {
      byCost: ranking.byCost.slice(0, CHILD_LIMIT),
      byChange: ranking.byChange.slice(0, CHILD_LIMIT),
      omitted: { byCost: Math.max(0, ranking.byCost.length - CHILD_LIMIT), byChange: Math.max(0, ranking.byChange.length - CHILD_LIMIT) }
    },
    planBill: presentPlanBill(planBill, series)
  };
}
