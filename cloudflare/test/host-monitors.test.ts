import { describe, expect, it } from "vitest";
import { Table } from "../src/client/columns";
import { sparkGeometry } from "../src/client/chart-data";
import type { DeviceHistory } from "../src/client/history";
import { buildCells, type HostData } from "../src/client/pages/host/monitors";
import { tableView } from "./support/history";

const STEP_MS = 15_000;
const SIX_HOURS = 6 * 60 * 60_000;

function devices<K extends "disks" | "nets" | "filesystems">(): DeviceHistory<K> {
  return { hostId: "h", fromMs: 0, toMs: SIX_HOURS, resolution: "raw", stepMs: STEP_MS, series: [] };
}

describe("host status sparklines", () => {
  it("keeps a sparse sample on the range clock instead of stretching it across the tile", () => {
    const samples = [0, STEP_MS, 3 * 60 * 60_000];
    const table = Table.from(tableView(samples.length, {
      "cpu.user": [10, 20, 30],
      "cpu.system": [1, 1, 1]
    }), samples);
    const data: HostData = {
      summary: { hostId: "h", fromMs: 0, toMs: SIX_HOURS, resolution: "raw", stepMs: STEP_MS, table },
      disks: devices(),
      nets: devices(),
      filesystems: devices()
    };
    const cpu = buildCells(data, null, "300").find(cell => cell.id === "cpu");
    const geometry = sparkGeometry(cpu === undefined ? [] : [cpu.spark], cpu?.times, { fromMs: 0, toMs: SIX_HOURS }, true);
    expect(cpu?.value).toBe(31);
    expect(cpu?.spark.some(value => value === null)).toBe(true);
    expect(geometry?.paths[0]?.split(" M")).toHaveLength(2);
    expect(geometry?.dot?.x).toBe(80);
    expect(geometry?.gaps).toEqual([{ x0: 80, x1: 160 }]);
    const cells = buildCells(data, null, "300");
    expect(cells.find(cell => cell.id === "pressure")).toMatchObject({ reported: false, value: undefined });
    expect(cells.find(cell => cell.id === "disk")).toMatchObject({ reported: false, value: undefined });
    const zoomed = buildCells(data, { fromMs: 4 * 60 * 60_000, toMs: 5 * 60 * 60_000 }, "300").find(cell => cell.id === "cpu");
    expect(zoomed?.reported).toBe(true);
    expect(zoomed?.value).toBeUndefined();
  });
});
