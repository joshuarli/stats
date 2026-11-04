import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { decodeExploration, decodeHealth, decodeImpact, decodeIssues, decodeOccurrences, decodeTrace, decodeTraces } from "./decode.ts";
import type { InvocationSummary, IssueState } from "../core/store.ts";

const USAGE = `usage: observe <command> [options]

commands:
  health                          collector health
  routes [--window 1h|6h|24h|7d]  routes ranked by CPU with latency percentiles
  traces [--route R] [--failed] [--slowest] [--window W]
  trace <trace id>                one trace as a text waterfall
  issues [--state open|resolved] [--introduced-in VERSION]
  issue <fingerprint>             an issue's stack and recent occurrences
  resolve <fingerprint> | reopen <fingerprint>
  deployment <rollout id>         new issues, regressions, and failure rates
  sourcemap <version> <map path> [--file NAME]
                                  register a bundle's source map for a version

options:
  --base URL   observe API base (or OBSERVE_URL), e.g. https://stats.example/api/observe
  --json       print the decoded response instead of text

auth: OBSERVE_AUTH_COMMAND prints a credential, sent in the header named by
OBSERVE_AUTH_HEADER. Credentials are never read from arguments.`;

const WINDOWS: Record<string, number> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };

export const EXIT = { ok: 0, usage: 1, unavailable: 2, notFound: 3, conflict: 4 } as const;

class Exit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Context {
  readonly base: string;
  readonly headers: Record<string, string>;
  readonly json: boolean;
  readonly out: (line: string) => void;
}

function credential(env: NodeJS.ProcessEnv): Record<string, string> {
  const command = env["OBSERVE_AUTH_COMMAND"];
  if (command === undefined || command === "") return {};
  const header = env["OBSERVE_AUTH_HEADER"];
  if (header === undefined || !/^[A-Za-z0-9-]{1,64}$/u.test(header)) throw new Exit(EXIT.usage, "OBSERVE_AUTH_COMMAND needs OBSERVE_AUTH_HEADER, the header that carries its output");
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) throw new Exit(EXIT.unavailable, "OBSERVE_AUTH_COMMAND failed");
  return { [header]: result.stdout.trim() };
}

async function call<T>(context: Context, path: string, decode: (value: unknown) => T, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`${context.base}${path}`, { ...init, headers: { ...context.headers, ...init.headers as Record<string, string> } }); }
  catch { throw new Exit(EXIT.unavailable, `could not reach ${context.base}`); }
  if (response.status === 404) throw new Exit(EXIT.notFound, "not found or expired");
  if (response.status === 409) throw new Exit(EXIT.conflict, "a different map is already registered for this version and file");
  if (response.status === 400) throw new Exit(EXIT.usage, `rejected: ${await response.text()}`);
  if (!response.ok) throw new Exit(EXIT.unavailable, `collector unavailable (${response.status})`);
  if (response.status === 204) return decode(null);
  try { return decode(await response.json()); }
  catch (error) { throw new Exit(EXIT.unavailable, error instanceof Error ? error.message : "invalid response"); }
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function table(rows: readonly (readonly string[])[], numeric: ReadonlySet<number>): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(row => row[column]?.length ?? 0))) ?? [];
  return rows.map(row => row.map((cell, column) => numeric.has(column) ? cell.padStart(widths[column] ?? 0) : cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
}

function windowQuery(value: string | undefined, now: number): URLSearchParams {
  const span = WINDOWS[value ?? "24h"];
  if (span === undefined) throw new Exit(EXIT.usage, "window must be 1h, 6h, 24h, or 7d");
  return new URLSearchParams({ from: String(now - span), to: String(now) });
}

function waterfall(invocations: readonly InvocationSummary[]): string[] {
  const origin = Math.min(...invocations.map(invocation => invocation.atMs));
  const span = Math.max(1, ...invocations.map(invocation => invocation.atMs - origin + invocation.wallMs));
  const width = 48;
  const ordered = [...invocations].sort((a, b) => (a.stage === "object" ? 1 : 0) - (b.stage === "object" ? 1 : 0) || a.atMs - b.atMs);
  return table(ordered.map(invocation => {
    const start = Math.round(((invocation.atMs - origin) / span) * width);
    const length = Math.max(1, Math.round((invocation.wallMs / span) * width));
    return [invocation.stage === "worker" ? invocation.label : `  ${invocation.label}`, `${" ".repeat(start)}${"█".repeat(Math.min(length, width - start))}`.padEnd(width), `+${ms(invocation.atMs - origin)}`, ms(invocation.wallMs), `${ms(invocation.cpuMs)} cpu`, invocation.failed ? "failed" : ""];
  }), new Set([2, 3, 4]));
}

async function run(command: string, positional: readonly string[], values: Record<string, string | boolean | undefined>, context: Context, now: number): Promise<void> {
  const print = (value: unknown, text: () => string[]) => { for (const line of context.json ? [JSON.stringify(value, null, 2)] : text()) context.out(line); };
  const argument = (what: string, pattern: RegExp) => {
    const value = positional[0];
    if (value === undefined || !pattern.test(value)) throw new Exit(EXIT.usage, `${command} needs a ${what}`);
    return value;
  };
  const string = (key: string) => typeof values[key] === "string" ? values[key] : undefined;
  switch (command) {
    case "health": {
      const health = await call(context, "/health", decodeHealth);
      return print(health, () => [`${health.liveInvocations} invocations retained, newest ${health.newestAtMs === null ? "never" : new Date(health.newestAtMs).toISOString()}`, `${health.openIssues} open issues, cleanup lag ${ms(health.cleanupLagMs)}`, `rejected ${health.rejected}, duplicate ${health.duplicate}, evicted ${health.evicted}`]);
    }
    case "routes": {
      const exploration = await call(context, `/explore?${windowQuery(string("window"), now)}`, decodeExploration);
      const total = Math.max(1, exploration.routes.reduce((sum, route) => sum + route.cpuMs, 0));
      return print(exploration.routes, () => table([["route", "requests", "failed", "cpu", "p50", "p95", "p99", "p95 cpu"], ...exploration.routes.map(route => [route.label, String(route.requests), String(route.failed), `${Math.round((route.cpuMs / total) * 100)}%`, ms(route.p50WallMs), ms(route.p95WallMs), ms(route.p99WallMs), ms(route.p95CpuMs)])], new Set([1, 2, 3, 4, 5, 6, 7])));
    }
    case "traces": {
      const query = windowQuery(string("window"), now);
      query.set("limit", "20");
      if (string("route") !== undefined) query.set("label", string("route")!);
      if (values["failed"] === true) query.set("failed", "true");
      if (values["slowest"] === true) query.set("order", "slowest");
      const traces = await call(context, `/traces?${query}`, decodeTraces);
      return print(traces.items, () => table([["trace", "route", "status", "wall", "cpu", "at"], ...traces.items.map(trace => [trace.traceId ?? "-", trace.label, trace.status === null ? trace.outcome : String(trace.status), ms(trace.wallMs), ms(trace.cpuMs + trace.objectCpuMs), new Date(trace.atMs).toISOString()])], new Set([3, 4])));
    }
    case "trace": {
      const id = argument("32-hex trace id", /^[0-9a-f]{32}$/u);
      const trace = await call(context, `/traces/${id}`, value => decodeTrace(value, id));
      return print(trace, () => [...waterfall(trace.invocations), ...trace.occurrences.map(occurrence => `error ${occurrence.name}${occurrence.operation === null ? "" : ` [${occurrence.operation}]`} at ${occurrence.frames[0] === undefined ? "no stack" : `${occurrence.frames[0].fn ?? "?"} (${occurrence.frames[0].file}:${occurrence.frames[0].line})`}`)]);
    }
    case "issues": {
      const query = new URLSearchParams({ state: string("state") ?? "open", limit: "100" });
      if (string("introduced-in") !== undefined) query.set("introducedIn", string("introduced-in")!);
      const issues = await call(context, `/issues?${query}`, decodeIssues);
      return print(issues.items, () => table([["fingerprint", "issue", "count", "last seen", "since"], ...issues.items.map(issue => [issue.fingerprint, `${issue.name}${issue.operation === null ? "" : ` [${issue.operation}]`} ${issue.frame ?? ""}`, String(issue.occurrences), new Date(issue.lastAtMs).toISOString(), issue.firstVersionLabel ?? issue.firstVersion?.slice(0, 8) ?? "-"])], new Set([2])));
    }
    case "issue": {
      const id = argument("64-hex fingerprint", /^[0-9a-f]{64}$/u);
      const occurrences = await call(context, `/issues/${id}/occurrences?limit=10`, decodeOccurrences);
      const first = occurrences.items[0];
      if (first === undefined) throw new Exit(EXIT.notFound, "no retained occurrences");
      return print(occurrences.items, () => [`${first.name}${first.operation === null ? "" : ` [${first.operation}]`} ${first.message ?? "(message withheld)"}`, ...first.frames.map(frame => `  at ${frame.fn ?? "?"} (${frame.file}:${frame.line}:${frame.column})`), "", ...table(occurrences.items.map(item => [new Date(item.atMs).toISOString(), item.version?.slice(0, 8) ?? "-", item.traceId ?? "-"]), new Set())]);
    }
    case "resolve":
    case "reopen": {
      const id = argument("64-hex fingerprint", /^[0-9a-f]{64}$/u);
      const state: IssueState = command === "resolve" ? "resolved" : "open";
      await call(context, `/issues/${id}/state`, () => null, { method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(context.base).origin }, body: JSON.stringify({ state }) });
      return print({ fingerprint: id, state }, () => [`${id} ${state}`]);
    }
    case "deployment": {
      const id = argument("rollout id", /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/u);
      const impact = await call(context, `/rollouts/${id}/impact`, value => decodeImpact(value, id));
      const rate = (introduced: boolean) => {
        const rows = impact.versions.filter(version => version.introduced === introduced);
        const requests = rows.reduce((sum, row) => sum + row.requests, 0);
        return requests === 0 ? "no requests" : `${((rows.reduce((sum, row) => sum + row.failed, 0) / requests) * 100).toFixed(2)}% of ${requests}`;
      };
      return print(impact, () => impact.state === "expired" ? ["older than retained data"] : [
        `failed requests ${rate(false)} -> ${rate(true)}`,
        ...impact.newIssues.map(issue => `new        ${issue.name}${issue.operation === null ? "" : ` [${issue.operation}]`} ${issue.frame ?? ""} (${issue.occurrences})`),
        ...impact.regressions.map(issue => `regressed  ${issue.name}${issue.operation === null ? "" : ` [${issue.operation}]`} ${issue.frame ?? ""} (${issue.occurrences})`),
        ...(impact.newIssues.length + impact.regressions.length === 0 ? ["no new or regressed issues"] : [])
      ]);
    }
    case "sourcemap": {
      const version = argument("version", /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/u);
      const path = positional[1];
      if (path === undefined) throw new Exit(EXIT.usage, "sourcemap needs the path of a .map file");
      const file = string("file") ?? basename(path).replace(/\.map$/u, "");
      let map: string;
      try { map = readFileSync(path, "utf8"); } catch { throw new Exit(EXIT.usage, `cannot read ${path}`); }
      const result = await call(context, `/artifacts/${encodeURIComponent(version)}/${encodeURIComponent(file)}`, value => {
        const fields = value as { result?: unknown };
        if (fields.result !== "accepted" && fields.result !== "duplicate") throw new Error("invalid artifact response");
        return fields.result;
      }, { method: "PUT", headers: { "Content-Type": "application/json", Origin: new URL(context.base).origin }, body: map });
      return print({ version, file, result }, () => [`${file} for ${version}: ${result}`]);
    }
    default:
      throw new Exit(EXIT.usage, USAGE);
  }
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void, err: (line: string) => void, now = Date.now()): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { base: { type: "string" }, json: { type: "boolean" }, file: { type: "string" }, window: { type: "string" }, route: { type: "string" }, failed: { type: "boolean" }, slowest: { type: "boolean" }, state: { type: "string" }, "introduced-in": { type: "string" } }
    });
    const [command, ...rest] = positionals;
    if (command === undefined) throw new Exit(EXIT.usage, USAGE);
    const base = (values.base ?? env["OBSERVE_URL"] ?? "").replace(/\/+$/u, "");
    if (!/^https?:\/\//u.test(base)) throw new Exit(EXIT.usage, "set --base or OBSERVE_URL to the observe API, e.g. https://stats.example/api/observe");
    await run(command, rest, values, { base, headers: credential(env), json: values.json === true, out }, now);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof Exit) { err(error.message); return error.code; }
    if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) { err(error.message); return EXIT.usage; }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, line => process.stdout.write(`${line}\n`), line => process.stderr.write(`${line}\n`));
}
