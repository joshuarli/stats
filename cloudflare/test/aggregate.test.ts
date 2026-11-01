import { describe, expect, it } from "vitest";
import { rollupFromRaw, rollupPoints, type RawRow, type RollupPayload } from "../src/aggregate";
import type { Disk, Net } from "../src/protocol";

const disk = (sectors: string): Disk => ({
  id: "8:0",
  name: "sda",
  reads: "10",
  readSectors: sectors,
  writes: "5",
  writeSectors: "20",
  ioMs: "100"
});

const net = (bytes: string): Net => ({
  id: "eth0",
  rxBytes: bytes,
  rxPackets: "1",
  rxDrops: "0",
  rxErrors: "0",
  txBytes: "0",
  txPackets: "0",
  txDrops: "0",
  txErrors: "0"
});

function row(disks: Record<string, Disk>, nets: Record<string, Net>, intervalMs: number): RawRow {
  return {
    sample: { seq: "1", atMs: "0", monoMs: "0", disks: Object.values(disks), nets: Object.values(nets) },
    delta: { intervalMs, disks, nets }
  };
}

function payloadWithoutCoverage(payload: RollupPayload): RollupPayload {
  return {
    ...payload,
    disks: { "8:0": { reads: "10", readSectors: "1000", writes: "5", writeSectors: "20", ioMs: "100" } },
    nets: { eth0: { rxBytes: "1000", rxPackets: "1", rxDrops: "0", rxErrors: "0", txBytes: "0", txPackets: "0", txDrops: "0", txErrors: "0" } }
  };
}

describe("rolled rates", () => {
  it("divides a device delta by the interval that device covered", () => {
    const payload = rollupFromRaw([row({ "8:0": disk("1000") }, { eth0: net("1000") }, 15_000), row({}, {}, 15_000)], 0, 60_000)!;
    const disks = rollupPoints([payload], "disks") as { points: { readBytesPerSec: number }[] }[];
    const nets = rollupPoints([payload], "nets") as { points: { rxBytesPerSec: number }[] }[];
    expect(disks[0]!.points[0]!.readBytesPerSec).toBeCloseTo((1000 * 512 * 1000) / 15_000, 6);
    expect(nets[0]!.points[0]!.rxBytesPerSec).toBeCloseTo((1000 * 1000) / 15_000, 6);
  });

  it("falls back to the bucket coverage for a payload written before the field existed", () => {
    const payload = payloadWithoutCoverage(rollupFromRaw([row({ "8:0": disk("1000") }, { eth0: net("1000") }, 15_000), row({}, {}, 15_000)], 0, 60_000)!);
    const disks = rollupPoints([payload], "disks") as { points: { readBytesPerSec: number }[] }[];
    expect(disks[0]!.points[0]!.readBytesPerSec).toBeCloseTo((1000 * 512 * 1000) / 30_000, 6);
  });
});
