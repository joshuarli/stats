import type { DeploymentHistory } from "../../deployments/model.ts";
import type { ObservedRollout, VersionLabel } from "../core/model.ts";

export interface RolloutBatch {
  readonly rollouts: readonly ObservedRollout[];
  readonly versions: readonly VersionLabel[];
}

function source(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^[^a-z]+/u, "").slice(0, 32);
  return token === "" ? "unknown" : token;
}

export function rolloutsFromDeployments(history: DeploymentHistory): RolloutBatch {
  return {
    rollouts: history.deployments.map(deployment => ({
      id: deployment.id,
      atMs: deployment.atMs,
      source: source(deployment.source),
      message: deployment.message,
      shares: deployment.versions.map(version => ({ version: version.id, percent: version.percentage }))
    })),
    versions: history.versions.map(version => ({ version: version.id, label: version.tag, message: version.message }))
  };
}
