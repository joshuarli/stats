import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { authError } from "./exit.ts";
import { resolveInvocationPath } from "./verify/files.ts";

const MAX_CREDENTIAL_FILE_BYTES = 4096;
const TOKEN_FORMAT = /^[!-~]+$/u;

export interface CredentialFile {
  readonly path: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface CredentialWrite {
  readonly replace: boolean;
}

function destination(file: string, replace: boolean): string {
  const path = resolveInvocationPath(file);
  let existing;
  try {
    existing = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw authError("credential_file_unreadable", `cannot inspect the credential file ${path}`);
  }
  if (existing.isSymbolicLink()) throw authError("credential_file_invalid", `${path} is a symbolic link; refusing to write through it`);
  if (!existing.isFile()) throw authError("credential_file_invalid", `${path} is not a regular file`);
  if ((existing.mode & 0o077) !== 0) throw authError("credential_file_mode", `${path} must not be readable by group or others; run: chmod 600 ${path}`);
  if (!replace) throw authError("credential_file_exists", `${path} already exists; choose another path or remove it`);
  return path;
}

export function prepareCredentialWrite(file: string, options: CredentialWrite): string {
  return destination(file, options.replace);
}

export function credentialFileExists(file: string): boolean {
  try {
    lstatSync(resolveInvocationPath(file));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw authError("credential_file_unreadable", `cannot inspect the credential file ${resolveInvocationPath(file)}`);
  }
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

export function credentialToken(file: CredentialFile, field = "token"): string {
  const token = file.fields[field];
  if (typeof token !== "string" || !TOKEN_FORMAT.test(token)) throw authError("credential_file_invalid", `${file.path} has no valid ${field}`);
  return token;
}

export function writeCredentialJson(file: string, fields: Readonly<Record<string, unknown>>, options: CredentialWrite): string {
  const path = destination(file, options.replace);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(fields, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
    }
    throw authError("credential_file_unwritable", `cannot write the credential file ${path}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return path;
}
