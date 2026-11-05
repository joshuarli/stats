import type { Request as MiniflareRequest, Response as MiniflareResponse } from "miniflare";
import { parseProjects } from "../src/projects/config.ts";
import type { Outbound } from "./topology.ts";

export interface OutboundRequest {
  readonly url: string;
  readonly scenario: string;
}

export interface OfflineOutbound {
  readonly handler: Outbound;
  readonly requests: readonly OutboundRequest[];
  scenario: string;
  unexpected(): OutboundRequest[];
}

export function probeUrls(projectsJson: string): string[] {
  return parseProjects(projectsJson).flatMap(project => project.probes.map(probe => new URL(probe.url).href));
}

export function offlineOutbound(declared: readonly string[]): OfflineOutbound {
  const expected = new Set(declared.map(url => new URL(url).href));
  const requests: OutboundRequest[] = [];
  const outbound: OfflineOutbound = {
    requests,
    scenario: "startup",
    handler: (request: MiniflareRequest) => {
      requests.push({ url: request.url, scenario: outbound.scenario });
      return new Response(`offline: ${request.url} is not reachable from the local stack`, { status: 503 }) as unknown as MiniflareResponse;
    },
    unexpected: () => requests.filter(request => !expected.has(new URL(request.url).href))
  };
  return outbound;
}

export function describeUnexpected(requests: readonly OutboundRequest[]): string {
  return `unexpected outbound requests from the local stack: ${requests.map(request => `${request.url} (during ${request.scenario})`).join(", ")}`;
}
