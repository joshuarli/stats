import { bytes } from "../../client/format.ts";
import { placeServices, type HostPlacements } from "../../core/installation/service-placement.ts";
import { HOST_ID } from "../../core/installation/services.ts";
import { decodeHostServiceResources } from "../../core/installation/service-resources-model.ts";
import { decodeServices } from "../../deployments/service-decode.ts";
import { RANGE_MS, RANGES, type RangeKey } from "../../limits.ts";
import { transportError, usageError } from "../exit.ts";
import { defineCommand } from "../registry.ts";
import { table, timeText } from "../text.ts";

export interface ServicesUsagePayload {
  readonly window: RangeKey;
  readonly fromMs: number;
  readonly toMs: number;
  readonly hosts: readonly HostUsage[];
}

interface HostUsage extends Omit<HostPlacements, "services"> {
  readonly services: readonly ServiceUsageRow[];
}

interface ServiceUsageRow {
  readonly service: string;
  readonly reported: boolean;
  readonly cpuMeanCores: number | null;
  readonly cpuPeakCores: number | null;
  readonly memoryBytes: number | null;
  readonly cpuShareOfBusiest: number | null;
}

function decodeHostNames(value: unknown): Map<string, string> {
  const hosts = (value as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hosts)) throw new Error("expected a hosts array");
  return new Map(hosts.map((item: unknown) => {
    const entry = item as { hostId?: unknown; name?: unknown } | null;
    if (typeof entry?.hostId !== "string" || !HOST_ID.test(entry.hostId) || typeof entry.name !== "string") throw new Error("invalid host identity");
    return [entry.hostId, entry.name] as const;
  }));
}

function windowOf(value: string | undefined): RangeKey {
  const found = RANGES.find(range => range === (value ?? "1h"));
  if (found === undefined) throw usageError(`--window must be one of ${RANGES.join(", ")}`);
  return found;
}

const cores = (value: number | null): string => value === null ? "-" : value.toFixed(2);

export const servicesUsageCommand = defineCommand<ServicesUsagePayload>({
  name: "services usage",
  summary: "group services by host and rank their CPU and memory over a window",
  description: [
    "Places every service under each host it is assigned to, busiest host first and busiest service first within a host, as the dashboard's Services page does.",
    "CPU is the window's mean cgroup CPU in cores, peak its highest sample, and memory the latest reading. Share compares each service's mean CPU with the busiest service on any host."
  ],
  access: "read",
  targets: ["orange", "node"],
  options: { window: { type: "string", placeholder: "RANGE", default: "1h", description: `window ending now: ${RANGES.join(", ")}` } },
  examples: ["statsctl services usage", "statsctl services usage --window 24h --json"],
  limitations: ["Levels come from host agents' cgroup samples; a service with no cgroup on a host shows no data there, never zero."],
  async run(context) {
    const window = windowOf(context.option("window"));
    const toMs = context.now();
    const fromMs = toMs - RANGE_MS[window];
    const services = await context.http.getJson("/api/v1/services", decodeServices);
    const hosts = await context.http.getJson("/api/v1/hosts", decodeHostNames);
    if (services.kind !== "ok" || hosts.kind !== "ok") throw transportError("contract", "the service or host list answered not-modified to an unconditional request");
    const hostIds = [...new Set(services.value.flatMap(service => service.hostIds))].sort();
    const resources = await Promise.all(hostIds.map(async hostId => {
      const fetched = await context.http.getJson(`/api/v1/hosts/${hostId}/services?fromMs=${fromMs}&toMs=${toMs}`, decodeHostServiceResources);
      if (fetched.kind !== "ok") throw transportError("contract", `host ${hostId} service resources answered not-modified to an unconditional request`);
      return fetched.value;
    }));
    const groups = placeServices(services.value, resources, hostId => hosts.value.get(hostId) ?? hostId);
    return {
      payload: {
        window, fromMs, toMs,
        hosts: groups.map(group => ({ ...group, services: group.services.map(({ points: _points, hostId: _hostId, ...row }) => row) }))
      }
    };
  },
  render({ window, toMs, hosts }) {
    if (hosts.length === 0) return ["no services configured"];
    const rows: string[][] = [["host", "service", "cpu", "peak", "share", "memory"]];
    for (const host of hosts) {
      rows.push([host.name, `${host.services.length} ${host.services.length === 1 ? "service" : "services"}`, cores(host.cpuMeanCores), "", "", host.memoryBytes === null ? "-" : bytes(host.memoryBytes)]);
      for (const service of host.services) {
        rows.push(["", service.service, ...(service.reported ? [cores(service.cpuMeanCores), cores(service.cpuPeakCores), service.cpuShareOfBusiest === null ? "-" : `${Math.round(service.cpuShareOfBusiest * 100)}%`, service.memoryBytes === null ? "-" : bytes(service.memoryBytes)] : ["no cgroup data", "", "", ""])]);
      }
    }
    return [`services by host over ${window} ending ${timeText(toMs)}; cpu in cores, share of the busiest service`, ...table(rows)];
  }
});
