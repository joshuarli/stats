export const EXIT = {
  ok: 0,
  usage: 2,
  auth: 3,
  transport: 4,
  pending: 5,
  unchanged: 6,
  regressed: 7
} as const;

export type ExitCode = typeof EXIT[keyof typeof EXIT];

export const EXIT_MEANING: readonly (readonly [ExitCode, string])[] = [
  [EXIT.ok, "read succeeded, or verification improved"],
  [EXIT.usage, "usage error, or a deploy marker id already recorded with different content"],
  [EXIT.auth, "authentication: no credential, a login page, an Access challenge, a redirect, 401, or 403"],
  [EXIT.transport, "transport or contract failure, or a command that is not implemented"],
  [EXIT.pending, "verification is pending or has insufficient data"],
  [EXIT.unchanged, "verification is unchanged or confounded"],
  [EXIT.regressed, "verification regressed"]
];

export class CommandError extends Error {
  readonly exit: ExitCode;
  readonly code: string;

  constructor(exit: ExitCode, code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.exit = exit;
    this.code = code;
  }
}

export const usageError = (message: string) => new CommandError(EXIT.usage, "usage", message);
export const authError = (code: string, message: string) => new CommandError(EXIT.auth, code, message);
export const transportError = (code: string, message: string) => new CommandError(EXIT.transport, code, message);
export const unsupportedOnTarget = (command: string, origin: string) =>
  new CommandError(EXIT.usage, "unsupported_on_target", `${command} reads Cloudflare telemetry and is not available on the Node origin ${origin}`);
