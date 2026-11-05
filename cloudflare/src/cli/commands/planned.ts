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
