import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFrame, type SourceBatch } from "../../src/ingest/encode.ts";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/v2/sources/linux-normal.json"), "utf8")) as SourceBatch;
const TEMPLATE = FIXTURE.samples[0]!;
const BOOT_ID = FIXTURE.bootId;

export const SAMPLE_STEP_MS = 25_000;
export const SAMPLES_PER_BUCKET = 12;

export interface HostLevels {
  readonly cpuPercent: number;
  readonly memoryUsedPercent: number;
  readonly netBytesPerSec: number;
  readonly diskBytesPerSec: number;
  readonly cpuPressure: number;
}

const TOTAL_MEMORY = 8_589_934_592;
const TICKS_PER_SECOND = 800;
const FIRST_SEQ = 1_000;
const STEP_SECONDS = SAMPLE_STEP_MS / 1000;

export class HostSeries {
  private readonly hostId: string;
  private index = 0;
  private cpuTotal = 0;
  private cpuBusy = 0;
  private bytes = 0;
  private sectors = 0;
  private psiTotal = 0;

  constructor(hostId: string) {
    this.hostId = hostId;
  }

  private sample(atMs: number, levels: HostLevels): Record<string, unknown> {
    const ticks = Math.round(STEP_SECONDS * TICKS_PER_SECOND);
    this.cpuTotal += ticks;
    this.cpuBusy += Math.round(ticks * levels.cpuPercent / 100);
    this.bytes += Math.round(STEP_SECONDS * levels.netBytesPerSec / 2);
    this.sectors += Math.round(STEP_SECONDS * levels.diskBytesPerSec / 512 / 2);
    this.psiTotal += Math.round(STEP_SECONDS * 1000);
    const user = Math.round(this.cpuBusy * 0.8);
    const rest = Object.fromEntries(Object.entries(TEMPLATE).filter(([key]) => key !== "block"));
    const index = this.index++;
    const mono = String(1_000_000 + index * SAMPLE_STEP_MS);
    return {
      ...rest,
      seq: String(FIRST_SEQ + index),
      atMs: String(atMs),
      monoMs: mono,
      uptimeMs: mono,
      cpu: { idle: String(this.cpuTotal - this.cpuBusy), iowait: "0", steal: "0", system: String(this.cpuBusy - user), total: String(this.cpuTotal), user: String(user) },
      mem: { ...(TEMPLATE["mem"] as Record<string, string>), available: String(Math.round(TOTAL_MEMORY * (100 - levels.memoryUsedPercent) / 100)), total: String(TOTAL_MEMORY) },
      nets: [{ id: "eth0", rxBytes: String(this.bytes), rxDrops: "0", rxErrors: "0", rxPackets: String(Math.round(this.bytes / 1000)), txBytes: String(this.bytes), txDrops: "0", txErrors: "0", txPackets: String(Math.round(this.bytes / 1000)) }],
      disks: [{ id: "8:0", ioMs: "0", name: "sda", readSectors: String(this.sectors), reads: String(Math.round(this.sectors / 8)), writeSectors: String(this.sectors), writes: String(Math.round(this.sectors / 8)) }],
      psi: { cpu: { some10: levels.cpuPressure.toFixed(2), some60: levels.cpuPressure.toFixed(2), some300: levels.cpuPressure.toFixed(2), total: String(this.psiTotal) } }
    };
  }

  bucketFrame(bucketMs: number, levels: HostLevels): Uint8Array<ArrayBuffer> {
    const samples = Array.from({ length: SAMPLES_PER_BUCKET }, (_, offset) => this.sample(bucketMs + offset * SAMPLE_STEP_MS, levels));
    return encodeFrame({ hostId: this.hostId, bootId: BOOT_ID, samples });
  }
}
