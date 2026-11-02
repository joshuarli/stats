import { describe, expect, it } from "vitest";
import { combineRollups, downsample, pointsFromRows, rollupFromRaw, rollupPoints, rowPoints, type DiskPoint, type NetPoint, type RawRow, type RollupPayload, type SummaryPoint } from "../src/aggregate";
import { computeDelta } from "../src/delta";
import { MAX_POINTS, type HistoryKind } from "../src/limits";
import type { Disk, Net, Sample } from "../src/protocol";

const rawPoints = (rows: readonly RawRow[], kind: HistoryKind) => pointsFromRows(rows.map(rowPoints), kind);

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

describe("swap activity", () => {
  const withSwap = (swapIn: string | undefined, swapOut: string | undefined, monoMs = "0"): Sample => ({
    seq: "1",
    atMs: "0",
    monoMs,
    mem: { total: "8", available: "4", swapTotal: "2", swapFree: "1", ...(swapIn === undefined || swapOut === undefined ? {} : { swapIn, swapOut }) }
  });

  it("turns counter differences into per-second rates, per sample and per rollup", () => {
    const delta = computeDelta(withSwap("1000", "5000"), withSwap("4000", "6000", "15000"), 15_000);
    expect(delta.swap).toEqual({ swapIn: "3000", swapOut: "1000" });

    const rows: RawRow[] = [{ sample: withSwap("4000", "6000", "15000"), delta }, { sample: withSwap("4000", "6000", "30000"), delta: { intervalMs: 15_000, disks: {}, nets: {} } }];
    const raw = rawPoints(rows, "summary") as SummaryPoint[];
    expect(raw[0]!.mem!.swapInBytesPerSec).toBeCloseTo(200, 6);
    expect(raw[0]!.mem!.swapOutBytesPerSec).toBeCloseTo((1000 * 1000) / 15_000, 6);
    expect(raw[1]!.mem!.swapInBytesPerSec).toBeUndefined();

    const rolled = rollupPoints([rollupFromRaw(rows, 0, 60_000)!], "summary") as SummaryPoint[];
    expect(rolled[0]!.mem!.swapInBytesPerSec).toBeCloseTo(200, 6);
  });

  it("leaves a gap when a counter regressed or the agent sent no swap counters", () => {
    expect(computeDelta(withSwap("4000", "6000"), withSwap("100", "7000", "15000"), 15_000).swap).toBeUndefined();
    expect(computeDelta(withSwap(undefined, undefined), withSwap("1", "1", "15000"), 15_000).swap).toBeUndefined();
    expect(computeDelta(withSwap("1", "1"), withSwap(undefined, undefined, "15000"), 15_000).swap).toBeUndefined();
  });
});

describe("uptime on summary points", () => {
  it("keeps the kernel uptime so a reset can be read as a reboot", () => {
    const sample = (uptimeMs: string, monoMs: string): Sample => ({ seq: "1", atMs: "0", monoMs, uptimeMs, cpuCount: 4 });
    const rows: RawRow[] = [{ sample: sample("5000", "0"), delta: { intervalMs: 0, disks: {}, nets: {} } }, { sample: sample("20000", "15000"), delta: { intervalMs: 15_000, disks: {}, nets: {} } }];
    const raw = rawPoints(rows, "summary") as SummaryPoint[];
    expect(raw.map(point => point.uptimeMs)).toEqual([5000, 20_000]);
    const rolled = rollupPoints([rollupFromRaw(rows, 0, 60_000)!], "summary") as SummaryPoint[];
    expect(rolled[0]!.uptimeMs).toBe(12_500);
  });

  it("leaves it out when the agent could not read it", () => {
    const row: RawRow = { sample: { seq: "1", atMs: "0", monoMs: "0", cpuCount: 4 }, delta: { intervalMs: 0, disks: {}, nets: {} } };
    expect((rawPoints([row], "summary") as SummaryPoint[])[0]!.uptimeMs).toBeUndefined();
  });
});

describe("counters a platform does not expose", () => {
  const sample = (seq: string, cpu: NonNullable<Sample["cpu"]>, txBytes: string): Sample => ({
    seq,
    atMs: String(Number(seq) * 1000),
    monoMs: String(Number(seq) * 1000),
    cpu,
    disks: [{ id: "1:0", name: "disk0", reads: "0", readSectors: txBytes, writes: "0", writeSectors: "0" }],
    nets: [{ id: "en0", rxBytes: "0", rxPackets: "0", rxDrops: "0", rxErrors: "0", txBytes, txPackets: "0", txErrors: "0" }]
  });
  const first = sample("100", { user: "10", system: "10", idle: "80", total: "100" }, "0");
  const second = sample("115", { user: "30", system: "20", idle: "150", total: "200" }, "15000");
  const rows: RawRow[] = [{ sample: second, delta: computeDelta(first, second, 15_000) }];

  it("leaves iowait, steal, tx drops, and disk busy time absent rather than zero in raw and rolled history", () => {
    const summary = rawPoints(rows, "summary") as SummaryPoint[];
    expect(summary[0]!.cpu).toEqual({ user: 20, system: 10, idle: 70 });
    const nets = rawPoints(rows, "nets") as { points: NetPoint[] }[];
    expect(nets[0]!.points[0]!.txBytesPerSec).toBe(1000);
    expect(nets[0]!.points[0]).not.toHaveProperty("txDropsPerSec");
    const disks = rawPoints(rows, "disks") as { points: DiskPoint[] }[];
    expect(disks[0]!.points[0]!.readBytesPerSec).toBe(512_000);
    expect(disks[0]!.points[0]).not.toHaveProperty("busyPct");

    const payload = rollupFromRaw(rows, 0, 60_000)!;
    expect((rollupPoints([payload], "summary") as SummaryPoint[])[0]!.cpu).toEqual({ user: 20, system: 10, idle: 70 });
    const rolledNets = rollupPoints([payload], "nets") as { points: NetPoint[] }[];
    expect(rolledNets[0]!.points[0]).not.toHaveProperty("txDropsPerSec");
    const rolledDisks = rollupPoints([payload], "disks") as { points: DiskPoint[] }[];
    expect(rolledDisks[0]!.points[0]!.readBytesPerSec).toBe(512_000);
    expect(rolledDisks[0]!.points[0]).not.toHaveProperty("busyPct");
  });
});

describe("memory pressure level", () => {
  const row = (seq: number, pressure?: "normal" | "warn" | "critical"): RawRow => ({
    sample: { seq: String(seq), atMs: String(seq * 15_000), monoMs: String(seq * 15_000), mem: { total: "100", available: "50", swapTotal: "0", swapFree: "0", ...(pressure === undefined ? {} : { pressure }) } },
    delta: { intervalMs: 15_000, disks: {}, nets: {} }
  });

  it("is a share of time at warn or worse and at critical, raw and rolled", () => {
    const rows = [row(1, "normal"), row(2, "warn"), row(3, "critical"), row(4, "normal")];
    const raw = rawPoints(rows, "summary") as SummaryPoint[];
    expect(raw.map(point => point.mem!.pressure)).toEqual([{ warnPct: 0, criticalPct: 0 }, { warnPct: 100, criticalPct: 0 }, { warnPct: 100, criticalPct: 100 }, { warnPct: 0, criticalPct: 0 }]);
    const rolled = rollupPoints([rollupFromRaw(rows, 0, 60_000)!], "summary") as SummaryPoint[];
    expect(rolled[0]!.mem!.pressure).toEqual({ warnPct: 50, criticalPct: 25 });
  });

  it("is absent when the host does not report it", () => {
    expect((rawPoints([row(1)], "summary") as SummaryPoint[])[0]!.mem).not.toHaveProperty("pressure");
    expect((rollupPoints([rollupFromRaw([row(1)], 0, 60_000)!], "summary") as SummaryPoint[])[0]!.mem).not.toHaveProperty("pressure");
  });
});

describe("gpu and power", () => {
  const sample = (monoMs: number, extra: Pick<Sample, "gpu" | "power">): Sample => ({ seq: String(monoMs / 1000), atMs: String(monoMs), monoMs: String(monoMs), cpuCount: 8, ...extra });
  const first = sample(0, { gpu: { active: "1000", total: "5000" }, power: { gpuNj: "2000000000", systemMwSum: "300000", systemReadings: "10" } });
  const second = sample(15_000, { gpu: { active: "1750", total: "6000" }, power: { gpuNj: "11700000000", systemMwSum: "314800", systemReadings: "11" } });
  const third = sample(30_000, { gpu: { active: "2000", total: "7000" }, power: { gpuNj: "13700000000", systemMwSum: "314800", systemReadings: "11" } });
  const rows = (): RawRow[] => [
    { sample: second, delta: computeDelta(first, second, 15_000) },
    { sample: third, delta: computeDelta(second, third, 15_000) }
  ];

  it("computes busy percent and watts per sample, leaving system watts out when no reading arrived", () => {
    const points = rawPoints(rows(), "summary") as SummaryPoint[];
    expect(points[0]!.gpu!.busyPct).toBeCloseTo(75, 9);
    expect(points[0]!.power!.gpuWatts).toBeCloseTo(9_700_000_000 / 15_000 / 1e6, 9);
    expect(points[0]!.power!.systemWatts).toBeCloseTo(14.8, 9);
    expect(points[1]!.gpu!.busyPct).toBeCloseTo(25, 9);
    expect(points[1]!.power!.gpuWatts).toBeCloseTo(2_000_000_000 / 15_000 / 1e6, 9);
    expect(points[1]!.power).not.toHaveProperty("systemWatts");
  });

  it("sums deltas in rollups so system watts is the mean of the readings that arrived", () => {
    const payload = rollupFromRaw(rows(), 0, 60_000)!;
    const [point] = rollupPoints([payload], "summary") as SummaryPoint[];
    expect(point!.gpu!.busyPct).toBeCloseTo(50, 9);
    expect(point!.power!.gpuWatts).toBeCloseTo(11_700_000_000 / 30_000 / 1e6, 9);
    expect(point!.power!.systemWatts).toBeCloseTo(14.8, 9);

    const [merged] = rollupPoints([combineRollups([payload, payload], 0, 120_000)!], "summary") as SummaryPoint[];
    expect(merged!.gpu!.busyPct).toBeCloseTo(50, 9);
    expect(merged!.power!.gpuWatts).toBeCloseTo(11_700_000_000 / 30_000 / 1e6, 9);
    expect(merged!.power!.systemWatts).toBeCloseTo(14.8, 9);
  });

  it("gives no system watts for a bucket where readings did not advance", () => {
    const quiet: RawRow[] = [{ sample: third, delta: computeDelta(second, third, 15_000) }];
    const [point] = rollupPoints([rollupFromRaw(quiet, 0, 60_000)!], "summary") as SummaryPoint[];
    expect(point!.power!.gpuWatts).toBeCloseTo(2_000_000_000 / 15_000 / 1e6, 9);
    expect(point!.power).not.toHaveProperty("systemWatts");
  });

  it("leaves everything absent when a sample lacks the groups, a counter regressed, or the total did not advance", () => {
    const bare = sample(15_000, {});
    const none: RawRow[] = [{ sample: bare, delta: computeDelta(first, bare, 15_000) }];
    const [raw] = rawPoints(none, "summary") as SummaryPoint[];
    expect(raw).not.toHaveProperty("gpu");
    expect(raw).not.toHaveProperty("power");
    const [rolled] = rollupPoints([rollupFromRaw(none, 0, 60_000)!], "summary") as SummaryPoint[];
    expect(rolled).not.toHaveProperty("gpu");
    expect(rolled).not.toHaveProperty("power");

    const reset = sample(15_000, { gpu: { active: "10", total: "20" }, power: { gpuNj: "5", systemMwSum: "1", systemReadings: "1" } });
    const delta = computeDelta(first, reset, 15_000);
    expect(delta.gpu).toBeUndefined();
    expect(delta.power).toBeUndefined();

    const stalled = sample(15_000, { gpu: { active: "1000", total: "5000" } });
    const [flat] = rawPoints([{ sample: stalled, delta: computeDelta(first, stalled, 15_000) }], "summary") as SummaryPoint[];
    expect(flat).not.toHaveProperty("gpu");
  });

  it("keeps a working system reading when only the gpu energy counter regressed", () => {
    const mixed = sample(15_000, { power: { gpuNj: "1", systemMwSum: "314800", systemReadings: "11" } });
    expect(computeDelta(first, mixed, 15_000).power).toEqual({ systemMwSum: "14800", systemReadings: "1" });
  });

  it("decodes rollup payloads stored before gpu and power existed", () => {
    const stored = JSON.parse(JSON.stringify(rollupFromRaw([{ sample: first, delta: { intervalMs: 15_000, disks: {}, nets: {} } }], 0, 60_000))) as RollupPayload;
    const [point] = rollupPoints([stored], "summary") as SummaryPoint[];
    expect(point).not.toHaveProperty("gpu");
    expect(point).not.toHaveProperty("power");
  });
});

describe("downsampling", () => {
  it("keeps every stride-th point and reports the stride so the step widens with it", () => {
    const { items, stride } = downsample(Array.from({ length: 1200 }, (_, index) => index));
    expect(stride).toBe(2);
    expect(items).toHaveLength(600);
    expect(items[0]).toBe(0);
    expect(items[1]).toBe(2);
    expect(items.at(-1)).toBe(1198);
    expect(items.length).toBeLessThanOrEqual(MAX_POINTS);
  });

  it("returns a copy unchanged when the input already fits", () => {
    const input = [1, 2, 3];
    const { items, stride } = downsample(input);
    expect(stride).toBe(1);
    expect(items).toEqual(input);
    expect(items).not.toBe(input);
  });
});
