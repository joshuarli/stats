import { spawn } from "node:child_process";
import { authError, usageError } from "./exit.ts";

export const DEFAULT_ORIGIN = "https://stats.17166969.xyz";
export const AUTH_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_HEADER = "cf-access-token";
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/u;
const MAX_CREDENTIAL_CHARS = 16 * 1024;

export interface Credential {
  readonly header: string;
  readonly value: string;
}

export type Target = "cloudflare" | "node";

export function targetOf(origin: string): Target {
  const { hostname } = new URL(origin);
  return hostname.endsWith(".ts.net") || !hostname.includes(".") && !hostname.includes(":") ? "node" : "cloudflare";
}

export function resolveOrigin(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const raw = flag ?? env["STATS_URL"] ?? DEFAULT_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`origin is not a URL: ${raw}`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || targetOf(url.origin) === "node"))) throw new TypeError("origin must be https, or http on loopback or the tailnet");
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new TypeError("origin must be a bare scheme, host, and port");
  return url.origin;
}

export function loginHint(origin: string): string {
  return `run: cf access login ${origin}`;
}

export function credentialCommand(origin: string, env: NodeJS.ProcessEnv): { readonly file: string; readonly args: readonly string[] } {
  const override = env["STATSCTL_AUTH_COMMAND"];
  return override === undefined || override === "" ? { file: "cf", args: ["access", "token", origin] } : { file: "sh", args: ["-c", override] };
}

export function credentialHeader(env: NodeJS.ProcessEnv): string {
  const header = env["STATSCTL_AUTH_HEADER"] ?? DEFAULT_HEADER;
  if (!HEADER_NAME.test(header)) throw usageError("STATSCTL_AUTH_HEADER is not a valid header name");
  return header;
}

export function fetchCredential(origin: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Credential> {
  const header = credentialHeader(env);
  const { file, args } = credentialCommand(origin, env);
  const fail = (why: string) => authError("credential_unavailable", `${why}; ${loginHint(origin)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "ignore"], timeout: AUTH_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL", signal, env });
    let output = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > MAX_CREDENTIAL_CHARS) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", error => reject(fail((error as NodeJS.ErrnoException).code === "ENOENT" ? `credential command ${file} not found` : "credential command could not run")));
    child.once("close", (status, termination) => {
      if (overflow) return reject(fail("credential command printed too much"));
      if (status !== 0) return reject(fail(termination === null ? `credential command exited ${status ?? "abnormally"}` : "credential command timed out or was cancelled"));
      const value = output.trim();
      if (value === "" || /[\r\n]/u.test(value)) return reject(fail("credential command printed no single-line credential"));
      resolve({ header, value });
    });
  });
}
