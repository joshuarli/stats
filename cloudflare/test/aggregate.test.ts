import { describe, expect, it } from "vitest";
import { rawPoints, rollupFromRaw, rollupPoints, type RawRow, type RollupPayload, type SummaryPoint } from "../src/aggregate";
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

describe("pressure full stalls", () => {
  const psiRow = (psi: NonNullable<RawRow["sample"]["psi"]>): RawRow => ({
    sample: { seq: "1", atMs: "0", monoMs: "0", psi },
    delta: { intervalMs: 15_000, disks: {}, nets: {} }
  });
  const withFull = { some10: "2.00", some60: "1.00", some300: "0.50", total: "9", full10: "1.50", full60: "0.75", full300: "0.25", fullTotal: "4" };
  const someOnly = { some10: "3.00", some60: "2.00", some300: "1.00", total: "9" };

  it("keeps full averages on raw and rolled summaries", () => {
    const raw = rawPoints([psiRow({ memory: withFull, io: someOnly })], "summary") as SummaryPoint[];
    expect(raw[0]!.psi!.memory).toEqual({ some10: 2, some60: 1, some300: 0.5, full10: 1.5, full60: 0.75, full300: 0.25 });
    expect(raw[0]!.psi!.io).toEqual({ some10: 3, some60: 2, some300: 1 });

    const payload = rollupFromRaw([psiRow({ memory: withFull, io: someOnly }), psiRow({ memory: { ...withFull, full10: "2.50" }, io: someOnly })], 0, 60_000)!;
    const rolled = rollupPoints([payload], "summary") as SummaryPoint[];
    expect(rolled[0]!.psi!.memory!.full10).toBe(2);
    expect(rolled[0]!.psi!.memory!.full300).toBe(0.25);
    expect(rolled[0]!.psi!.io).toEqual({ some10: 3, some60: 2, some300: 1 });
  });
});
