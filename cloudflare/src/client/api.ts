export interface Host {
  readonly hostId: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly revoked: boolean;
  readonly lastReceivedAtMs: number | null;
  readonly online: boolean;
}
export interface Cpu {
  readonly user: number;
  readonly system: number;
  readonly idle: number;
  readonly iowait: number;
  readonly steal: number;
}
export interface Load {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
}
export interface Mem {
  readonly total: number;
  readonly available: number;
  readonly swapUsed: number;
}
export interface PsiGroup {
  readonly some10: number;
  readonly some60: number;
  readonly some300: number;
}
export interface Psi {
  readonly cpu?: PsiGroup;
  readonly memory?: PsiGroup;
  readonly io?: PsiGroup;
}
export interface SummaryPoint {
  readonly atMs: number;
  readonly coverageMs: number;
  readonly partial: boolean;
  readonly cpu?: Cpu;
  readonly load?: Load;
  readonly mem?: Mem;
  readonly psi?: Psi;
}
export interface DiskPoint {
  readonly atMs: number;
  readonly readBytesPerSec: number;
  readonly writeBytesPerSec: number;
  readonly readsPerSec: number;
  readonly writesPerSec: number;
  readonly busyPct: number;
}
export interface NetPoint {
  readonly atMs: number;
  readonly rxBytesPerSec: number;
  readonly txBytesPerSec: number;
  readonly rxPacketsPerSec: number;
  readonly txPacketsPerSec: number;
  readonly rxDropsPerSec: number;
  readonly txDropsPerSec: number;
  readonly rxErrorsPerSec: number;
  readonly txErrorsPerSec: number;
}
export interface FilesystemPoint {
  readonly atMs: number;
  readonly total: number;
  readonly available: number;
}
export interface Series<P> {
  readonly id: string;
  readonly name?: string;
  readonly points: P[];
}
export interface History<P = SummaryPoint> {
  readonly hostId: string;
  readonly range: string;
  readonly kind: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly resolution: string;
  readonly stepMs: number;
  readonly points?: P[];
  readonly series?: Series<P>[];
}
export interface Sample {
  readonly seq: string;
  readonly atMs: string;
  readonly monoMs: string;
  readonly cpu?: { readonly user: string; readonly system: string; readonly idle: string; readonly iowait: string; readonly steal: string; readonly total: string };
  readonly load?: { readonly one: string; readonly five: string; readonly fifteen: string };
  readonly mem?: { readonly total: string; readonly available: string; readonly swapTotal: string; readonly swapFree: string };
  readonly uptimeMs?: string;
  readonly cpuCount?: number;
  readonly disks?: readonly { readonly id: string; readonly name: string; readonly reads: string; readonly readSectors: string; readonly writes: string; readonly writeSectors: string; readonly ioMs: string }[];
  readonly nets?: readonly Record<string, string>[];
  readonly filesystems?: readonly { readonly id: string; readonly type: string; readonly total: string; readonly available: string }[];
  readonly psi?: Record<string, Record<string, string>>;
}
export interface Latest {
  readonly hostId: string;
  readonly receivedAtMs: number;
  readonly sample: Sample;
}

export class ApiFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" });
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok) throw new ApiFailure(response.status, response.status === 401 ? "Sign in through Cloudflare Access." : `The request failed (${response.status}).`);
  if (!type.includes("application/json")) throw new ApiFailure(0, "The response was not telemetry JSON. Sign in through Cloudflare Access.");
  return await response.json<T>();
}

export const getHosts = () => getJson<{ hosts: Host[] }>("/api/v1/hosts");
export const getLatest = (hostId: string) => getJson<Latest>(`/api/v1/hosts/${encodeURIComponent(hostId)}/latest`);
export const getSummary = (hostId: string, range: string) => getJson<History<SummaryPoint>>(`/api/v1/hosts/${encodeURIComponent(hostId)}/history?range=${range}&kind=summary`);
export const getDisks = (hostId: string, range: string) => getJson<History<DiskPoint>>(`/api/v1/hosts/${encodeURIComponent(hostId)}/history?range=${range}&kind=disks`);
export const getNets = (hostId: string, range: string) => getJson<History<NetPoint>>(`/api/v1/hosts/${encodeURIComponent(hostId)}/history?range=${range}&kind=nets`);
export const getFilesystems = (hostId: string, range: string) => getJson<History<FilesystemPoint>>(`/api/v1/hosts/${encodeURIComponent(hostId)}/history?range=${range}&kind=filesystems`);
