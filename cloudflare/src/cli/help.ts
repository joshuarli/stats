import { EXIT_MEANING } from "./exit.ts";
import { GLOBAL_OPTIONS, type Command, type OptionSpec, type OptionSpecs, type Registry } from "./registry.ts";
import { table } from "./text.ts";
import { WORKFLOW } from "./workflow.ts";
import { DEFAULT_ORIGIN } from "./auth.ts";

const EXIT_LINES = EXIT_MEANING.map(([code, meaning]) => `  ${code}  ${meaning}`);

const OUTPUT_LINES = [
  "output:",
  "  Text for humans by default. --json prints exactly one statsctl/1 document on stdout,",
  "  for failures too (an error object replaces payload). Diagnostics go to stderr.",
  "  No colour or progress is printed when stdout is not a terminal or NO_COLOR is set.",
  "  Times are UTC; windows are half-open [fromMs, toMs); u64 values are decimal strings."
];

const AUTH_LINES = [
  "credentials:",
  `  Origin is --origin, else STATS_URL, else ${DEFAULT_ORIGIN}.`,
  "  The credential is the output of `cf access token <origin>` (no stdin, 20 s limit), sent",
  "  in the cf-access-token header to that origin only. Redirects are never followed.",
  "  Override with STATSCTL_AUTH_COMMAND (run with sh -c) and STATSCTL_AUTH_HEADER.",
  "  statsctl never starts a login; on failure it exits 3 and says: run: cf access login <origin>.",
  "",
  "targets:",
  "  An origin whose host ends in .ts.net, or is a bare name with no dot (http or https), is a Node",
  "  origin behind tailscale serve: statsctl sends no credential there. Any other origin is Cloudflare.",
  "  `check ingest`, `deploy mark`, `services`, `service deployments`, and `verify --service` work on a Node origin. Every",
  "  other command reads Cloudflare telemetry and exits 2 with unsupported_on_target before any request.",
  "  `deploy mark` sends only its service deploy token, on both targets, never the Access credential."
];

function optionLine(name: string, spec: OptionSpec): readonly [string, string] {
  const flag = spec.type === "string" ? `--${name} ${spec.placeholder}` : `--${name}`;
  const notes = spec.type === "string" ? [spec.required === true ? "required" : null, spec.default === undefined ? null : `default ${spec.default}`] : [];
  const suffix = notes.filter(note => note !== null).join(", ");
  return [`  ${flag}`, suffix === "" ? spec.description : `${spec.description} (${suffix})`];
}

function optionBlock(heading: string, options: OptionSpecs): string[] {
  const entries = Object.entries(options);
  if (entries.length === 0) return [];
  return [heading, ...table(entries.map(([name, spec]) => optionLine(name, spec))), ""];
}

export function topHelp(registry: Registry): string {
  const rows = registry.commands.map(command => [`  ${command.name}`, `${command.access === "mutation" ? "[mutation] " : ""}${command.summary}`]);
  return [
    "statsctl: query, price, and verify the stats telemetry origin",
    "",
    "usage: statsctl <command> [options]",
    "       statsctl <command> --help",
    "       statsctl help <command>",
    "       statsctl help workflow",
    "",
    "commands (all read-only unless marked):",
    ...table(rows),
    "",
    ...optionBlock("global options:", GLOBAL_OPTIONS),
    ...OUTPUT_LINES,
    "",
    ...AUTH_LINES,
    "",
    "exit codes:",
    ...EXIT_LINES,
    "",
    "Run `statsctl help workflow` for copy-pastable recipes."
  ].join("\n");
}

export function commandHelp(command: Command): string {
  const options = Object.entries(command.options);
  const usage = ["statsctl", command.name, ...options.filter(([, spec]) => spec.type === "string" && spec.required === true).map(([name, spec]) => `--${name} ${spec.type === "string" ? spec.placeholder : ""}`), options.some(([, spec]) => !(spec.type === "string" && spec.required === true)) ? "[options]" : ""].filter(part => part !== "").join(" ");
  const rules = [
    ...command.exclusive.map(group => `  choose at most one of ${group.map(name => `--${name}`).join(", ")}`),
    ...command.together.map(group => `  ${group.map(name => `--${name}`).join(" and ")} go together`)
  ];
  return [
    `usage: ${usage}`,
    "",
    `${command.summary}`,
    "",
    ...command.description,
    "",
    `access: ${command.access === "mutation" ? "MUTATION, it changes remote state" : "read-only"}`,
    `targets: ${command.targets.length === 2 ? "Cloudflare origin and Node origin" : "Cloudflare origin only; exits 2 with unsupported_on_target on a Node origin"}`,
    "",
    ...optionBlock("options:", command.options),
    ...(rules.length === 0 ? [] : ["option rules (violations exit 2):", ...rules, ""]),
    ...optionBlock("global options:", GLOBAL_OPTIONS),
    "examples:",
    ...command.examples.map(example => `  ${example}`),
    "",
    "limitations:",
    ...command.limitations.map(limit => `  ${limit}`),
    "",
    ...AUTH_LINES,
    "",
    "exit codes:",
    ...EXIT_LINES
  ].join("\n");
}

export function groupHelp(word: string, commands: readonly Command[]): string {
  return [`usage: statsctl ${word} <subcommand> [options]`, "", "subcommands:", ...table(commands.map(command => [`  ${command.name}`, command.summary])), "", `Run \`statsctl help ${word} <subcommand>\` for options.`].join("\n");
}

export function workflowHelp(): string {
  return WORKFLOW;
}
