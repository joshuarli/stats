import { defineCommand } from "../registry.ts";
import { transportError, usageError, EXIT } from "../exit.ts";
import { table, timeText } from "../text.ts";
import { parseDuration } from "../verify/files.ts";

interface ReportingHost {
  readonly name: string;
  readonly revoked: boolean;
  readonly lastReceivedAtMs: number | null;
}

interface HostReport {
  readonly name: string;
  readonly state: "reporting" | "missing" | "ambiguous" | "revoked" | "stale";
  readonly lastReceivedAtMs: number | null;
}

interface CheckHostsPayload {
  readonly maxAgeMs: number;
  readonly hosts: readonly HostReport[];
}

function decodeReportingHosts(value: unknown): readonly ReportingHost[] {
  const hosts = (value as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hosts)) throw new Error("expected a hosts array");
  return hosts.map((item: unknown) => {
    const entry = item as Partial<ReportingHost> | null;
    if (typeof entry?.name !== "string" || typeof entry.revoked !== "boolean") throw new Error("invalid host identity");
    const { lastReceivedAtMs } = entry;
    if (lastReceivedAtMs !== null && (typeof lastReceivedAtMs !== "number" || lastReceivedAtMs < 0 ||
      !Number.isSafeInteger(lastReceivedAtMs) || !Number.isFinite(new Date(lastReceivedAtMs).getTime()))) {
      throw new Error("invalid host reporting data");
    }
    return { name: entry.name, revoked: entry.revoked, lastReceivedAtMs };
  });
}

function hostReport(name: string, hosts: readonly ReportingHost[], cutoff: number, now: number): HostReport {
  const matches = hosts.filter(host => host.name === name);
  const entry = matches[0];
  if (entry === undefined) return { name, state: "missing", lastReceivedAtMs: null };
  if (matches.length !== 1) return { name, state: "ambiguous", lastReceivedAtMs: null };
  const { lastReceivedAtMs } = entry;
  if (entry.revoked) return { name, state: "revoked", lastReceivedAtMs };
  const reporting = lastReceivedAtMs !== null && lastReceivedAtMs > cutoff && lastReceivedAtMs <= now;
  return { name, state: reporting ? "reporting" : "stale", lastReceivedAtMs };
}

export const checkHostsCommand = defineCommand<CheckHostsPayload>({
  name: "check hosts",
  summary: "verify that each expected host recently delivered telemetry",
  description: [
    "Reads the installation's host roster and checks each exact name against the server receipt time.",
    "Exit 7 if an expected host is missing, ambiguous, revoked, or stale. A snapshot can return 200 and still fail the freshness check."
  ],
  access: "read",
  targets: ["orange", "node"],
  options: {
    hosts: { type: "string", placeholder: "NAMES", required: true, description: "comma-separated names of expected online hosts" },
    "max-age": { type: "string", placeholder: "SPAN", default: "2m", description: "maximum age of the latest host receipt" }
  },
  examples: ["statsctl check hosts --hosts lisa,threadripper --max-age 2m --json"],
  limitations: ["Run after at least one reporting interval to verify recovery. A fresh receipt alone does not verify complete backfill."],
  async run(context) {
    const names = (context.option("hosts") ?? "").split(",").map(name => name.trim());
    if (names.includes("") || new Set(names).size !== names.length) throw usageError("--hosts must list distinct, nonempty names");
    const maxAgeMs = parseDuration(context.option("max-age") ?? "2m");
    const response = await context.http.getJson("/api/v1/hosts", decodeReportingHosts);
    if (response.kind !== "ok") throw transportError("contract", "host list answered not-modified to an unconditional request");
    const now = context.now();
    const hosts = names.map(name => hostReport(name, response.value, now - maxAgeMs, now));
    return { payload: { maxAgeMs, hosts }, exit: hosts.every(host => host.state === "reporting") ? EXIT.ok : EXIT.regressed };
  },
  render(payload) {
    return table(payload.hosts.map(item => [item.name, item.state, timeText(item.lastReceivedAtMs)]));
  }
});
