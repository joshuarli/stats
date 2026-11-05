import { parseArgs } from "node:util";
import { fetchCredential, resolveOrigin, DEFAULT_ORIGIN } from "./auth.ts";
import { REGISTRY } from "./commands/index.ts";
import { envelopeBase, failureEnvelope, successEnvelope, type Envelope } from "./envelope.ts";
import { CommandError, EXIT, usageError, type ExitCode } from "./exit.ts";
import { commandHelp, groupHelp, topHelp, workflowHelp } from "./help.ts";
import { createHttpClient } from "./http.ts";
import { GLOBAL_OPTIONS, type Command, type CommandContext, type OptionSpecs } from "./registry.ts";
import { useColour } from "./text.ts";

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly isTty: boolean;
}

export interface Deps {
  readonly env: NodeJS.ProcessEnv;
  readonly io: Io;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

type Values = Readonly<Record<string, string | boolean | undefined>>;

function usageFailure(message: string, hint: string): CommandError {
  return usageError(`${message}\n${hint}`);
}

function parseCommandArgs(command: Command, args: readonly string[]): Values {
  const options: OptionSpecs = { ...GLOBAL_OPTIONS, ...command.options };
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: Object.fromEntries(Object.entries(options).map(([name, spec]) => [name, name === "help" ? { type: "boolean" as const, short: "h" } : { type: spec.type }]))
    });
    return parsed.values;
  } catch (error) {
    const hint = `run \`statsctl help ${command.name}\` for the options of this command`;
    throw usageFailure(error instanceof Error ? error.message.split("\n")[0] ?? "invalid arguments" : "invalid arguments", hint);
  }
}

function checkRules(command: Command, values: Values): void {
  for (const [name, spec] of Object.entries(command.options)) {
    if (spec.type === "string" && spec.required === true && values[name] === undefined) throw usageError(`missing required option --${name}`);
  }
  const present = (name: string) => values[name] !== undefined && values[name] !== false;
  for (const group of command.exclusive) {
    const given = group.filter(present);
    if (given.length > 1) throw usageError(`${given.map(name => `--${name}`).join(" and ")} cannot be used together`);
  }
  for (const group of command.together) {
    const given = group.filter(present);
    if (given.length > 0 && given.length < group.length) throw usageError(`${group.map(name => `--${name}`).join(" and ")} must be given together`);
  }
}

function leadingWords(argv: readonly string[]): string[] {
  const end = argv.findIndex(word => word.startsWith("-"));
  return argv.slice(0, end === -1 ? argv.length : end);
}

type Route =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "run"; readonly command: Command; readonly values: Values };

function route(argv: readonly string[]): Route {
  const registry = REGISTRY;
  const first = argv[0];
  if (first === undefined) throw usageFailure("no command given", "run `statsctl --help` for the command list");
  if (first === "--help" || first === "-h") return { kind: "help", text: topHelp(registry) };
  if (first === "help") {
    const words = argv.slice(1);
    if (words.length === 0) return { kind: "help", text: topHelp(registry) };
    if (words[0] === "workflow" && words.length === 1) return { kind: "help", text: workflowHelp() };
    const found = registry.resolve(words);
    if (found !== undefined && found.consumed === words.length) return { kind: "help", text: commandHelp(found.command) };
    const group = registry.group(words[0] ?? "");
    if (group.length > 0 && words.length === 1) return { kind: "help", text: groupHelp(words[0] ?? "", group) };
    throw usageFailure(`no help topic ${words.join(" ")}`, "run `statsctl --help` for the command list");
  }
  if (first.startsWith("-")) throw usageFailure(`the command must come first, before ${first}`, "run `statsctl --help` for the command list");
  const leading = leadingWords(argv);
  const found = registry.resolve(leading);
  if (found === undefined) {
    const group = registry.group(first);
    if (group.length > 0) {
      if (argv.slice(1).some(word => word === "--help" || word === "-h") && leading.length === 1) return { kind: "help", text: groupHelp(first, group) };
      throw usageFailure(`${first} needs a subcommand`, groupHelp(first, group));
    }
    throw usageFailure(`unknown command ${first}`, "run `statsctl --help` for the command list");
  }
  const values = parseCommandArgs(found.command, argv.slice(found.consumed));
  if (values["help"] === true) return { kind: "help", text: commandHelp(found.command) };
  checkRules(found.command, values);
  return { kind: "run", command: found.command, values };
}

function bold(text: string): string {
  return `\u001b[1m${text}\u001b[22m`;
}

export async function main(argv: readonly string[], deps: Deps): Promise<ExitCode> {
  const now = deps.now ?? Date.now;
  const json = argv.includes("--json");
  const leading = leadingWords(argv);
  const commandName = REGISTRY.resolve(leading)?.command.name ?? leading[0] ?? "";
  let origin = DEFAULT_ORIGIN;

  function finish(failure: { readonly code: string; readonly message: string; readonly exit: ExitCode }): ExitCode {
    deps.io.stderr(`statsctl: ${failure.message}\n`);
    if (json) deps.io.stdout(`${JSON.stringify(failureEnvelope(envelopeBase(commandName, origin, now(), {}), { code: failure.code, message: failure.message }), null, 2)}\n`);
    return failure.exit;
  }

  try {
    const routed = route(argv);
    if (routed.kind === "help") {
      deps.io.stdout(`${routed.text}\n`);
      return EXIT.ok;
    }
    const { command, values } = routed;
    const flag = values["origin"];
    try {
      origin = resolveOrigin(typeof flag === "string" ? flag : undefined, deps.env);
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : "invalid origin");
    }
    const signal = deps.signal ?? new AbortController().signal;
    const context: CommandContext = {
      origin,
      signal,
      now,
      http: createHttpClient({ origin, signal, credential: () => fetchCredential(origin, deps.env, signal) }),
      option: name => typeof values[name] === "string" ? values[name] : undefined,
      flag: name => values[name] === true
    };
    const { result, text } = await command.execute(context);
    const base = envelopeBase(command.name, origin, now(), result);
    if (json) {
      const envelope: Envelope<unknown> = successEnvelope(base, result.payload);
      deps.io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      const colour = useColour(deps.env, deps.io.isTty, json);
      deps.io.stdout(`${text.map((line, index) => colour && index === 0 ? bold(line) : line).join("\n")}\n`);
      for (const warning of result.warnings ?? []) deps.io.stderr(`statsctl: warning ${warning.code}: ${warning.message}\n`);
    }
    return result.exit ?? EXIT.ok;
  } catch (error) {
    if (error instanceof CommandError) return finish(error);
    return finish({ exit: EXIT.transport, code: "internal", message: error instanceof Error ? error.message : "unexpected failure" });
  }
}
