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

const project = (description = "project id from `statsctl projects`"): OptionSpecs => ({ project: { type: "string", placeholder: "ID", description } });
const requiredProject: OptionSpecs = { project: { type: "string", placeholder: "ID", required: true, description: "project id from `statsctl projects`" } };
const window = (values: string, fallback: string): OptionSpecs => ({ window: { type: "string", placeholder: "SPAN", default: fallback, description: `trailing window, one of ${values}; UTC, half-open [from, to)` } });

export const plannedCommands: readonly Command[] = [
  planned({
    name: "cost",
    summary: "price one project's resource use over a window and find the bottleneck",
    description: [
      "Builds the same cost report as the dashboard from the authenticated history routes, priced from a versioned tariff table.",
      "Totals list their priced meters, excluded meters, and residuals. Missing data is `uncollected`, never zero.",
      "Large series are omitted unless --series is set; each line shows its top 15 children."
    ],
    options: {
      ...project(),
      all: { type: "boolean", description: "report every project; exclusive with --project" },
      ...window("1h, 6h, 24h, 7d, 30d", "latest settled hour"),
      from: { type: "string", placeholder: "MS", description: "window start, epoch milliseconds UTC (inclusive); needs --to" },
      to: { type: "string", placeholder: "MS", description: "window end, epoch milliseconds UTC (exclusive); needs --from" },
      "month-to-date": { type: "boolean", description: "UTC calendar month so far; not the billing cycle" },
      input: { type: "string", placeholder: "FILE", description: "price a saved snapshot offline instead of reading the origin" },
      series: { type: "boolean", description: "include full series" }
    },
    exclusive: [["project", "all"], ["window", "from", "month-to-date"], ["input", "all"]],
    together: [["from", "to"]],
    examples: ["statsctl cost --project stats --window 1h --json", "statsctl cost --project stats --input .work/statsctl/snapshots/stats.json --json"],
    limitations: ["A lower monthly estimate is not evidence that a change helped; use `verify` for that."]
  }),
  planned({
    name: "snapshot",
    summary: "save the exact inputs of a cost report so it can be replayed offline",
    description: [
      "Reads the history frames, deployments, and observe data for one window and writes them with their windows, revisions, and SHA-256 hashes. Credentials are never stored.",
      "Replay with `statsctl cost --input FILE`."
    ],
    options: { ...requiredProject, ...window("1h, 6h, 24h, 7d, 30d", "latest settled hour"), out: { type: "string", placeholder: "FILE", required: true, description: "snapshot path; default directory is .work/statsctl/snapshots/" } },
    examples: ["statsctl snapshot --project stats --window 24h --out .work/statsctl/snapshots/stats-24h.json"],
    limitations: ["Each snapshot is capped at 4 MiB and the directory at 200 MiB."]
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
  })
];
