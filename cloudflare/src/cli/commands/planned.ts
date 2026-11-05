import { CommandError, EXIT } from "../exit.ts";
import { defineCommand, type Access, type Command, type CommandSpec, type OptionSpecs } from "../registry.ts";

type PlannedSpec = Pick<CommandSpec<never>, "name" | "summary" | "description" | "options" | "examples" | "limitations"> & {
  readonly access?: Access;
  readonly exclusive?: readonly (readonly string[])[];
  readonly together?: readonly (readonly string[])[];
};

function planned(spec: PlannedSpec): Command {
  const { access = "read", ...rest } = spec;
  return defineCommand<never>({
    ...rest,
    access,
    async run() {
      throw new CommandError(EXIT.transport, "not_implemented", `statsctl ${spec.name} is not implemented in this build`);
    },
    render: () => []
  });
}

const requiredProject: OptionSpecs = { project: { type: "string", placeholder: "ID", required: true, description: "project id from `statsctl projects`" } };
const window = (values: string, fallback: string): OptionSpecs => ({ window: { type: "string", placeholder: "SPAN", default: fallback, description: `trailing window, one of ${values}; UTC, half-open [from, to)` } });

export const plannedCommands: readonly Command[] = [
  planned({
    name: "deployments",
    summary: "list a project's deployments with their version ids",
    description: ["Lists deployments from the server's recorded history, newest first, with versions and sync state. Use the ids with `compare` and `verify`."],
    options: requiredProject,
    examples: ["statsctl deployments --project stats --json"],
    limitations: ["`latest` resolves once to an immutable deployment id."]
  }),
  planned({
    name: "compare",
    summary: "compare one deployment against the window before it",
    description: ["Reports the server comparison for one exact deployment: before and after windows, invocations, per-metric deltas, and the verdict with its reasons."],
    options: { ...requiredProject, deployment: { type: "string", placeholder: "ID", required: true, description: "deployment id from `statsctl deployments`" }, ...window("1h, 6h, 24h", "1h") },
    examples: ["statsctl compare --project stats --deployment DEPLOYMENT_ID --window 1h --json"],
    limitations: ["Global, project-wide metrics only; operation-scoped metrics belong to `verify`."]
  }),
  planned({
    name: "verify",
    summary: "decide whether a deployment used fewer resources for the same work",
    description: [
      "Applies a pre-registered policy to the before and after windows of one deployment and prints a verdict: improved, unchanged, confounded, insufficient-data, pending, or regressed.",
      "--wait sleeps until the after window is ready, then polls at most every 15 minutes. State is kept in .work/statsctl/verify/<deployment-id>.json so an interrupted run resumes."
    ],
    options: {
      ...requiredProject,
      deployment: { type: "string", placeholder: "ID", required: true, description: "deployment id from `statsctl deployments`" },
      ...window("1h, 6h, 24h", "1h"),
      policy: { type: "string", placeholder: "FILE", required: true, description: "policy JSON file, e.g. bench/policies/<id>.json" },
      wait: { type: "boolean", description: "wait for the after window to settle instead of exiting pending" },
      timeout: { type: "string", placeholder: "SPAN", default: "30m", description: "give up waiting after this span and exit 5 with a resume command" },
      readiness: { type: "boolean", description: "list each signal the policy needs as available or unavailable and exit" }
    },
    examples: ["statsctl verify --project stats --deployment DEPLOYMENT_ID --window 1h --policy bench/policies/EXPERIMENT.json --wait --timeout 2h --json"],
    limitations: ["A full verify makes at most 60 requests."]
  }),
  planned({
    name: "observe routes",
    summary: "rank routes by CPU with latency percentiles over a window",
    description: ["Reads the observe service for the stats project. Read-only."],
    options: { project: { type: "string", placeholder: "ID", required: true, description: "only `stats` is observed" }, ...window("1h, 6h, 24h, 7d", "24h") },
    examples: ["statsctl observe routes --project stats --window 1h --json"],
    limitations: ["Observe retention is 7 days."]
  }),
  planned({
    name: "observe traces",
    summary: "list recent traces, slowest or failed first",
    description: ["Reads trace summaries from the observe service. Read-only."],
    options: { project: { type: "string", placeholder: "ID", required: true, description: "only `stats` is observed" }, ...window("1h, 6h, 24h, 7d", "24h"), route: { type: "string", placeholder: "LABEL", description: "only this route label" }, failed: { type: "boolean", description: "only failed invocations" } },
    examples: ["statsctl observe traces --project stats --window 1h --failed --json"],
    limitations: ["Resolving, reopening, and source-map registration are not exposed; use `pnpm observe`."]
  }),
  planned({
    name: "observe issues",
    summary: "list observed error groups",
    description: ["Reads issue groups from the observe service. Read-only."],
    options: { project: { type: "string", placeholder: "ID", required: true, description: "only `stats` is observed" }, state: { type: "string", placeholder: "STATE", description: "open or resolved" }, "introduced-in": { type: "string", placeholder: "VERSION", description: "only issues first seen in this version" } },
    examples: ["statsctl observe issues --project stats --state open --json"],
    limitations: ["Stack frames are never written to snapshots."]
  }),
  planned({
    name: "observe deployment",
    summary: "show new issues and failure rates for one rollout",
    description: ["Reads the observe impact report for one rollout. Read-only."],
    options: { project: { type: "string", placeholder: "ID", required: true, description: "only `stats` is observed" }, deployment: { type: "string", placeholder: "ID", required: true, description: "rollout or deployment id" } },
    examples: ["statsctl observe deployment --project stats --deployment DEPLOYMENT_ID --json"],
    limitations: ["Exploratory: whole-retention scan by version; `verify` does not use it."]
  }),
  planned({
    name: "check ingest",
    summary: "send one known sample through production ingest and read it back",
    description: [
      "MUTATION: writes one real sample. Encodes one sample with a fresh sequence and time, POSTs it, expects accepted 1, reads it back from host history, re-POSTs the identical bytes and expects duplicate 1, and confirms the stored count did not change.",
      "Use only with the synthetic-check host credential."
    ],
    access: "mutation",
    options: { "credential-file": { type: "string", placeholder: "FILE", required: true, description: "host credential JSON, mode 0600; never passed in argv" } },
    examples: ["statsctl check ingest --credential-file .work/credentials/synthetic-check.json --json"],
    limitations: ["Synthetic samples carry a synthetic flag and are excluded from organic metrics, but their cost stays in totals."]
  })
];
