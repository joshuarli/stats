import { manifestDigest } from "./manifest.mts";

export interface Artifact { readonly releaseId: string; readonly artifactDigest: string }
export interface Deployment { readonly runtime: Artifact; readonly app: Artifact }
export type Layer = "runtime" | "app" | "combined";

/**
 * Names a qualification by the layer that differs. A runtime experiment holds the app constant and
 * keeps the runtime identity a native runtime rollout checks; an app experiment holds the runtime
 * constant and uses the app release a native-app rollout checks. A combined change is attributed to
 * the pair, which no single rollout can promote.
 */
export function experimentIdentity(baseline: Deployment, candidate: Deployment): { layer: Layer; baseline: Artifact; candidate: Artifact } {
  const runtimeChanged = baseline.runtime.artifactDigest !== candidate.runtime.artifactDigest;
  const appChanged = baseline.app.artifactDigest !== candidate.app.artifactDigest;
  if (!runtimeChanged && !appChanged) throw new Error("baseline and candidate deploy identical runtime and app artifacts");
  if (!appChanged) return { layer: "runtime", baseline: baseline.runtime, candidate: candidate.runtime };
  if (!runtimeChanged) return { layer: "app", baseline: baseline.app, candidate: candidate.app };
  const pair = (side: Deployment): Artifact => ({
    releaseId: `${side.runtime.releaseId}+${side.app.releaseId}`,
    artifactDigest: `sha256:${manifestDigest({ app: side.app.artifactDigest, runtime: side.runtime.artifactDigest })}`,
  });
  return { layer: "combined", baseline: pair(baseline), candidate: pair(candidate) };
}
