import type { HostServiceResources, ResourcePoint } from "./service-resources-model.ts";

export interface PlacedService {
  readonly name: string;
  readonly hostIds: readonly string[];
}

export interface ServicePlacement {
  readonly service: string;
  readonly hostId: string | null;
  readonly points: readonly ResourcePoint[];
  readonly reported: boolean;
  readonly cpuMeanCores: number | null;
  readonly cpuPeakCores: number | null;
  readonly memoryBytes: number | null;
  readonly cpuShareOfBusiest: number | null;
}

export interface HostPlacements {
  readonly hostId: string | null;
  readonly name: string;
  readonly cpuMeanCores: number | null;
  readonly memoryBytes: number | null;
  readonly services: readonly ServicePlacement[];
}

export const UNPLACED_HOST_NAME = "No host assigned";

const known = (values: readonly (number | null)[]): number[] => values.filter((value): value is number => value !== null);

export function latestLevel(points: readonly ResourcePoint[], pick: (point: ResourcePoint) => number | null): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = pick(points[index]!);
    if (value !== null) return value;
  }
  return null;
}

export function meanLevel(points: readonly ResourcePoint[], pick: (point: ResourcePoint) => number | null): number | null {
  const values = known(points.map(pick));
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function peakLevel(points: readonly ResourcePoint[], pick: (point: ResourcePoint) => number | null): number | null {
  const values = known(points.map(pick));
  return values.length === 0 ? null : Math.max(...values);
}

function total(values: readonly (number | null)[]): number | null {
  const present = known(values);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

const busiestFirst = (left: { readonly cpuMeanCores: number | null }, right: { readonly cpuMeanCores: number | null }): number =>
  (right.cpuMeanCores ?? -1) - (left.cpuMeanCores ?? -1);

/**
 * Groups services under each host they are assigned to, busiest host first and busiest service first within a host.
 * A service on several hosts is placed once per host with that host's levels; CPU shares use one scale across every host.
 */
export function placeServices(services: readonly PlacedService[], resources: readonly HostServiceResources[], hostName: (hostId: string) => string): HostPlacements[] {
  const series = new Map(resources.flatMap(result => result.services.map(service => [`${result.hostId}/${service.name}`, service.points] as const)));
  const measure = (service: string, hostId: string | null) => {
    const points = hostId === null ? undefined : series.get(`${hostId}/${service}`);
    return { service, hostId, points: points ?? [], reported: points !== undefined, cpuMeanCores: points === undefined ? null : meanLevel(points, point => point.cpuCores), cpuPeakCores: points === undefined ? null : peakLevel(points, point => point.cpuCores), memoryBytes: points === undefined ? null : latestLevel(points, point => point.memoryBytes) };
  };
  const hostIds = [...new Set(services.flatMap(service => service.hostIds))].sort();
  const raw = hostIds.map(hostId => ({ hostId: hostId as string | null, name: hostName(hostId), services: services.filter(service => service.hostIds.includes(hostId)).map(service => measure(service.name, hostId)) }));
  const unplaced = services.filter(service => service.hostIds.length === 0);
  if (unplaced.length > 0) raw.push({ hostId: null, name: UNPLACED_HOST_NAME, services: unplaced.map(service => measure(service.name, null)) });
  const busiest = Math.max(0, ...raw.flatMap(group => group.services.map(service => service.cpuMeanCores ?? 0)));
  const groups = raw.map(group => {
    const placed = group.services.map(service => ({ ...service, cpuShareOfBusiest: busiest > 0 && service.cpuMeanCores !== null ? service.cpuMeanCores / busiest : null }));
    placed.sort((left, right) => busiestFirst(left, right) || left.service.localeCompare(right.service));
    return { hostId: group.hostId, name: group.name, cpuMeanCores: total(placed.map(service => service.cpuMeanCores)), memoryBytes: total(placed.map(service => service.memoryBytes)), services: placed };
  });
  return groups.sort((left, right) => (left.hostId === null ? 1 : 0) - (right.hostId === null ? 1 : 0) || busiestFirst(left, right) || left.name.localeCompare(right.name));
}
