import { describe, expect, it } from "vitest";
import type { HostField } from "../src/binary/history";
import { Table } from "../src/client/columns";
import type { SummaryTable } from "../src/client/history";
import { addCells, cpuUsed, lastCell, memoryUsed, netFaults, sumLatest } from "../src/client/metrics";
import { tableView, type Cell } from "./support/history";

function summary(columns: Record<string, Cell[]>, rows = Object.values(columns)[0]?.length ?? 1): SummaryTable {
  return Table.from(tableView(rows, columns), Array.from({ length: rows }, (_, index) => 1_000 + index * 15_000));
}

describe("client metrics", () => {
  it("keeps absent metrics absent instead of turning them into zero", () => {
    const table = summary({ atMs: [1_000, 16_000], coverageMs: [15_000, 15_000] });
    expect(cpuUsed(table)).toEqual([null, null]);
    expect(memoryUsed(table)).toEqual([null, null]);
    expect(table.cells("psi.cpu.some10")).toEqual([null, null]);
    expect(table.has("psi")).toBe(false);
  });

  it("derives CPU and memory use only from present fields", () => {
    const table = summary({
      "cpu.user": [8, null],
      "cpu.system": [3, 2],
      "mem.total": [8_000, 8_000],
      "mem.available": [3_000, null],
      "psi.cpu.some10": [1.2, null]
    });
    expect(cpuUsed(table)).toEqual([11, null]);
    expect(memoryUsed(table)).toEqual([62.5, null]);
    expect(table.cells("psi.cpu.some10")).toEqual([1.2, null]);
    expect(table.has("psi.cpu.some10")).toBe(true);
    expect(table.has("psi.io.some10")).toBe(false);
  });

  it("reports a column as present only when some cell holds a value", () => {
    const allMissing = Table.from(tableView(2, { "gpu.busyPct": [null, null] }), [1, 2]);
    expect(allMissing.has("gpu.busyPct")).toBe(false);
    expect(allMissing.cells("gpu.busyPct")).toEqual([null, null]);
  });

  it("treats an empty disk as unavailable rather than zero", () => {
    const cells = (entry: readonly (number | null)[]) => entry;
    expect(sumLatest([[]], cells)).toBeUndefined();
    expect(sumLatest([[4, 6], []], cells)).toBe(6);
    expect(sumLatest([[4, null], [1]], cells)).toBe(1);
  });

  it("selects the final row, present or not", () => {
    expect(lastCell([])).toBeUndefined();
    expect(lastCell([2, 3])).toBe(3);
    expect(lastCell([2, null])).toBeUndefined();
  });

  it("adds columns only where both are present and counts a missing transmit drop as zero", () => {
    expect(addCells([1, null, 3], [4, 5, null])).toEqual([5, null, null]);
    const nets = Table.from<HostField<"nets">>(tableView(2, {
      rxDropsPerSec: [1, 2], txDropsPerSec: [null, 3], rxErrorsPerSec: [0.5, 0.25], txErrorsPerSec: [0.25, 0]
    }), [1, 2]);
    expect(netFaults(nets)).toEqual([1.75, 5.25]);
  });
});
