import { isComparisonWindow, type ComparisonWindow, type DeploymentComparison } from "../../deployments/compare.ts";
import { decodeDeploymentComparison } from "../../deployments/decode.ts";
import { UUID } from "../../deployments/model.ts";
import { transportError, usageError } from "../exit.ts";
import { defineCommand } from "../registry.ts";
import { table, timeText } from "../text.ts";
import { newestFirst, readDeploymentHistory, requireProject } from "./deployments.ts";

export interface ComparePayload {
  readonly kind: "descriptive";
  readonly requested: string;
  readonly resolvedDeploymentId: string;
  readonly comparison: DeploymentComparison;
}

export function parseComparisonWindow(value: string | undefined): ComparisonWindow {
  const window = value ?? "1h";
  if (!isComparisonWindow(window)) throw usageError("--window must be 1h, 6h, or 24h");
  return window;
}

function number(value: number | null): string {
  return value === null ? "unavailable" : String(Number(value.toFixed(4)));
}

export const compareCommand = defineCommand<ComparePayload>({
  name: "compare",
  summary: "compare one deployment against the window before it",
  description: [
    "Reports the server comparison for one exact deployment: before and after windows, invocations, per-metric deltas, and the verdict with its reasons.",
    "This is descriptive, not acceptance: it exits 0 whenever the read succeeds, whatever the verdicts say. Use `statsctl verify` for a pre-registered decision.",
    "--deployment latest resolves once to the newest deployment id in the recorded history and reports the id it used."
  ],
  access: "read",
  options: {
    project: { type: "string", placeholder: "ID", required: true, description: "project id from `statsctl projects`" },
    deployment: { type: "string", placeholder: "ID", required: true, description: "deployment id from `statsctl deployments`, or latest" },
    window: { type: "string", placeholder: "SPAN", default: "1h", description: "trailing window, one of 1h, 6h, 24h; UTC, half-open [from, to)" }
  },
  examples: ["statsctl compare --project stats --deployment DEPLOYMENT_ID --window 1h --json", "statsctl compare --project stats --deployment latest --window 1h"],
  limitations: ["Global, project-wide metrics only; operation-scoped metrics belong to `verify`.", "The after window may not be complete yet; check readyAtMs and the reasons."],
  async run(context) {
    const project = requireProject(context);
    const window = parseComparisonWindow(context.option("window"));
    const requested = context.option("deployment") ?? "";
    if (requested !== "latest" && !UUID.test(requested)) throw usageError("--deployment must be a deployment id or latest");
    let deploymentId = requested;
    let versionIds: readonly string[] = [];
    if (requested === "latest") {
      const newest = newestFirst((await readDeploymentHistory(context, project)).deployments)[0];
      if (newest === undefined) throw transportError("no_deployments", `no deployments are recorded for ${project}`);
      deploymentId = newest.id;
      versionIds = newest.versions.map(version => version.id);
    }
    const path = `/api/v1/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(deploymentId)}/comparison?window=${window}`;
    const fetched = await context.http.getJson(path, value => decodeDeploymentComparison(value, deploymentId, window));
    if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
    const comparison = fetched.value;
    return {
      project,
      windows: [comparison.before, comparison.after],
      identities: { deploymentIds: [deploymentId], versionIds },
      payload: { kind: "descriptive", requested, resolvedDeploymentId: deploymentId, comparison }
    };
  },
  render({ requested, resolvedDeploymentId, comparison }) {
    const span = (bounds: { fromMs: number; toMs: number }) => `[${timeText(bounds.fromMs)}, ${timeText(bounds.toMs)})`;
    const lines = [
      "descriptive comparison, not acceptance; run `statsctl verify` for a verdict",
      `deployment ${resolvedDeploymentId}${requested === "latest" ? " (resolved from latest)" : ""}, window ${comparison.window}`,
      `before ${span(comparison.before)}, invocations ${number(comparison.beforeInvocations)}`,
      `after  ${span(comparison.after)}, invocations ${number(comparison.afterInvocations)}`,
      `ready at ${timeText(comparison.readyAtMs)}`
    ];
    if (comparison.reasons.length > 0) lines.push("reasons the comparison is withheld:", ...comparison.reasons.map(reason => `  ${reason}`));
    if (comparison.warnings.length > 0) lines.push("warnings:", ...comparison.warnings.map(warning => `  ${warning}`));
    if (comparison.metrics.length > 0) {
      lines.push(...table([
        ["metric", "unit", "before", "after", "delta", "percent", "verdict"],
        ...comparison.metrics.map(metric => [metric.label, metric.unit, number(metric.before), number(metric.after), number(metric.delta), number(metric.deltaPercent), metric.verdict])
      ]));
    }
    return lines;
  }
});
