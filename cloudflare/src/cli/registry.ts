import type { CommandResult } from "./envelope.ts";
import type { Target } from "./auth.ts";
import type { HttpClient } from "./http.ts";

export type OptionSpec =
  | { readonly type: "string"; readonly description: string; readonly placeholder: string; readonly default?: string; readonly required?: true }
  | { readonly type: "boolean"; readonly description: string };

export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

export type Access = "read" | "mutation";

export interface CommandContext {
  readonly origin: string;
  readonly http: HttpClient;
  readonly signal: AbortSignal;
  readonly now: () => number;
  option(name: string): string | undefined;
  flag(name: string): boolean;
}

export interface CommandSpec<P> {
  readonly name: string;
  readonly summary: string;
  readonly description: readonly string[];
  readonly access: Access;
  readonly targets?: readonly Target[];
  readonly options: OptionSpecs;
  readonly exclusive?: readonly (readonly string[])[];
  readonly together?: readonly (readonly string[])[];
  readonly examples: readonly string[];
  readonly limitations: readonly string[];
  run(context: CommandContext): Promise<CommandResult<P>>;
  render(payload: P): readonly string[];
}

export interface Command extends Omit<CommandSpec<unknown>, "run" | "render" | "exclusive" | "together" | "targets"> {
  readonly targets: readonly Target[];
  readonly exclusive: readonly (readonly string[])[];
  readonly together: readonly (readonly string[])[];
  execute(context: CommandContext): Promise<{ readonly result: CommandResult<unknown>; readonly text: readonly string[] }>;
}

const CLOUDFLARE_ONLY: readonly Target[] = ["cloudflare"];

export function defineCommand<P>(spec: CommandSpec<P>): Command {
  return {
    name: spec.name,
    summary: spec.summary,
    description: spec.description,
    access: spec.access,
    targets: spec.targets ?? CLOUDFLARE_ONLY,
    options: spec.options,
    exclusive: spec.exclusive ?? [],
    together: spec.together ?? [],
    examples: spec.examples,
    limitations: spec.limitations,
    async execute(context) {
      const result = await spec.run(context);
      return { result, text: spec.render(result.payload) };
    }
  };
}

export const GLOBAL_OPTIONS: OptionSpecs = {
  json: { type: "boolean", description: "print one statsctl/1 JSON document on stdout, for failures too" },
  origin: { type: "string", placeholder: "URL", description: "stats origin (default: STATS_URL, else https://stats.17166969.xyz)" },
  help: { type: "boolean", description: "print this help and exit; works offline" }
};

export class Registry {
  readonly commands: readonly Command[];

  constructor(commands: readonly Command[]) {
    const names = new Set(commands.map(command => command.name));
    if (names.size !== commands.length) throw new Error("duplicate command name");
    this.commands = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  }

  resolve(words: readonly string[]): { readonly command: Command; readonly consumed: number } | undefined {
    for (const length of [3, 2, 1]) {
      const name = words.slice(0, length).join(" ");
      const command = this.commands.find(candidate => candidate.name === name);
      if (command !== undefined && words.length >= length) return { command, consumed: length };
    }
    return undefined;
  }

  group(word: string): readonly Command[] {
    return this.commands.filter(command => command.name.startsWith(`${word} `));
  }
}
