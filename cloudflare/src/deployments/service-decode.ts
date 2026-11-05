import { HOST_ID, MARKER_ID, MARKER_VERSION, type Service, type ServiceDeploymentHistory, type ServiceMarker } from "../core/installation/services.ts";
import { UUID, annotation, record, type Deployment } from "./model.ts";

function string(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("invalid service string");
  return value;
}

function nullableString(value: unknown, limit: number): string | null {
  return value === null ? null : string(value, limit);
}

function time(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8.64e15) throw new Error("invalid service time");
  return value;
}

function list<T>(value: unknown, limit: number, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error("invalid service array");
  return value.map(decode);
}

function hostIds(value: unknown): string[] {
  return list(value, 64, item => {
    const id = string(item, 34);
    if (!HOST_ID.test(id)) throw new Error("invalid service host id");
    return id;
  });
}

function decodeMarkerDeployment(value: unknown): Deployment {
  const item = record(value);
  const id = string(item["id"], 36);
  if (!UUID.test(id)) throw new Error("invalid marker deployment id");
  const versions = list(item["versions"], 1, raw => {
    const version = record(raw);
    const versionId = string(version["id"], 128);
    if (!MARKER_VERSION.test(versionId) || version["percentage"] !== 100) throw new Error("invalid marker version");
    return { id: versionId, percentage: 100 };
  });
  if (versions.length !== 1 || item["source"] !== "marker" || item["deferred"] !== false) throw new Error("invalid marker deployment");
  return { id, atMs: time(item["atMs"]), source: "marker", message: annotation(nullableString(item["message"], 1000), 1000), versions, deferred: false };
}

export function decodeServiceMarker(value: unknown, service: string): ServiceMarker {
  const item = record(value);
  const markerId = string(item["markerId"], 128);
  if (item["service"] !== service || !MARKER_ID.test(markerId)) throw new Error("service marker mismatch");
  return { service, markerId, hostIds: hostIds(item["hostIds"]), deployment: decodeMarkerDeployment(item["deployment"]) };
}

export function decodeService(value: unknown): Service {
  const item = record(value);
  return {
    name: string(item["name"], 32),
    hostIds: hostIds(item["hostIds"]),
    healthUrl: nullableString(item["healthUrl"], 2048),
    unit: nullableString(item["unit"], 128),
    createdAtMs: time(item["createdAtMs"])
  };
}

export function decodeServices(value: unknown): Service[] {
  return list(record(value)["services"], 1000, decodeService);
}

export function decodeServiceDeploymentHistory(value: unknown, service: string): ServiceDeploymentHistory {
  const item = record(value);
  if (item["projectId"] !== service) throw new Error("service history mismatch");
  const deployments = list(item["deployments"], 1000, decodeMarkerDeployment);
  if (new Set(deployments.map(deployment => deployment.id)).size !== deployments.length) throw new Error("duplicate deployment");
  const markers = list(item["markers"], 1000, raw => {
    const marker = record(raw);
    const markerId = string(marker["markerId"], 128);
    if (!MARKER_ID.test(markerId)) throw new Error("invalid marker id");
    return { deploymentId: string(marker["deploymentId"], 36), markerId, hostIds: hostIds(marker["hostIds"]) };
  });
  const known = new Set(deployments.map(deployment => deployment.id));
  if (markers.length !== deployments.length || !markers.every(marker => known.has(marker.deploymentId))) throw new Error("service markers do not match deployments");
  return { projectId: service, worker: string(item["worker"], 63), enabled: true, sync: null, versions: [], deployments, markers };
}
