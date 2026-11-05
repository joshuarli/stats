import { statSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";

export const DEFAULT_LISTEN = "127.0.0.1:18791";
export const DATABASE_FILE = "stats.sqlite";

export interface Listen {
  readonly host: string;
  readonly port: number;
}

export interface NodeConfig {
  readonly databasePath: string;
  readonly listen: Listen;
  readonly allowedLogins: ReadonlySet<string>;
}

export class NodeConfigError extends Error {
  override readonly name = "NodeConfigError";
}

function dataDirectory(value: string | undefined): string {
  if (value === undefined || value === "") throw new NodeConfigError("STATS_DATA_DIR is required");
  const directory = resolve(value);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(directory).isDirectory();
  } catch {
    throw new NodeConfigError(`STATS_DATA_DIR ${directory} does not exist`);
  }
  if (!isDirectory) throw new NodeConfigError(`STATS_DATA_DIR ${directory} is not a directory`);
  return directory;
}

function listen(value: string | undefined): Listen {
  const text = value === undefined || value === "" ? DEFAULT_LISTEN : value;
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):(\d{1,5})$/u.exec(text);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (host === undefined || isIP(host) === 0 || !Number.isInteger(port) || port > 65_535) {
    throw new NodeConfigError(`STATS_LISTEN must be IPV4:PORT or [IPV6]:PORT, got ${JSON.stringify(text)}`);
  }
  return { host, port };
}

function allowedLogins(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === "") throw new NodeConfigError("STATS_ALLOWED_LOGINS is required");
  const logins = value.split(",").map(login => login.trim());
  if (logins.some(login => login === "" || /[\s\p{Cc}]/u.test(login))) throw new NodeConfigError("STATS_ALLOWED_LOGINS must be comma-separated logins with no empty entries or whitespace inside a login");
  return new Set(logins);
}

export function nodeConfig(env: Readonly<Record<string, string | undefined>>): NodeConfig {
  return {
    databasePath: join(dataDirectory(env["STATS_DATA_DIR"]), DATABASE_FILE),
    listen: listen(env["STATS_LISTEN"]),
    allowedLogins: allowedLogins(env["STATS_ALLOWED_LOGINS"])
  };
}
