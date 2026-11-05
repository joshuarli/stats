import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { authError } from "./exit.ts";
import { resolveInvocationPath } from "./verify/files.ts";

const MAX_CREDENTIAL_FILE_BYTES = 4096;
const TOKEN_FORMAT = /^[!-~]+$/u;

export interface CredentialFile {
  readonly path: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export function readCredentialJson(file: string, shape: string): CredentialFile {
  const path = resolveInvocationPath(file);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw authError("credential_file_unreadable", `cannot open the credential file ${path}`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw authError("credential_file_unreadable", `${path} is not a regular file`);
    if ((stat.mode & 0o077) !== 0) throw authError("credential_file_mode", `${path} must not be readable by group or others; run: chmod 600 ${path}`);
    if (stat.size > MAX_CREDENTIAL_FILE_BYTES) throw authError("credential_file_invalid", `${path} is larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch {
      throw authError("credential_file_invalid", `${path} is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw authError("credential_file_invalid", `${path} must be a JSON object with ${shape}`);
    return { path, fields: parsed as Record<string, unknown> };
  } finally {
    closeSync(descriptor);
  }
}

export function credentialToken(file: CredentialFile): string {
  const { token } = file.fields;
  if (typeof token !== "string" || !TOKEN_FORMAT.test(token)) throw authError("credential_file_invalid", `${file.path} has no valid token`);
  return token;
}
