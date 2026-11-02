import type { HostField } from "../binary/history";
import type { Cells, Table } from "./columns";
import { isFiniteNumber, percentUsed } from "./format";
import type { SummaryTable } from "./history";

function combine(left: Cells, right: Cells, join: (left: number, right: number) => number | undefined): Cells {
  return left.map((value, row) => {
    const other = right[row];
    return value === null || other === null || other === undefined ? null : join(value, other) ?? null;
  });
}

export function cpuUsed(table: SummaryTable): Cells {
  return table.derived("cpuUsed", source => combine(source.cells("cpu.user"), source.cells("cpu.system"), (user, system) => user + system));
}

export function memoryUsed(table: SummaryTable): Cells {
  return table.derived("memoryUsed", source => combine(source.cells("mem.total"), source.cells("mem.available"), percentUsed));
}

export function memoryUsedBytes(table: SummaryTable): Cells {
  return table.derived("memoryUsedBytes", source => combine(source.cells("mem.total"), source.cells("mem.available"), (total, available) => total - available));
}

export function lastCell(cells: Cells): number | undefined {
  return cells[cells.length - 1] ?? undefined;
}

export function sumLatest<T>(series: readonly T[], cells: (entry: T) => Cells): number | undefined {
  let total = 0;
  let present = 0;
  for (const entry of series) {
    const value = lastCell(cells(entry));
    if (!isFiniteNumber(value)) continue;
    total += value;
    present += 1;
  }
  return present === 0 ? undefined : total;
}

export function addCells(left: Cells, right: Cells): Cells {
  return combine(left, right, (a, b) => a + b);
}

export function netDrops(table: Table<HostField<"nets">>): Cells {
  return table.derived("netDrops", source => combine(source.cells("rxDropsPerSec"), source.cells("txDropsPerSec").map(value => value ?? 0), (rx, tx) => rx + tx));
}

export function netErrors(table: Table<HostField<"nets">>): Cells {
  return table.derived("netErrors", source => combine(source.cells("rxErrorsPerSec"), source.cells("txErrorsPerSec"), (rx, tx) => rx + tx));
}

export function netFaults(table: Table<HostField<"nets">>): Cells {
  return table.derived("netFaults", source => combine(combine(netDrops(source), source.cells("rxErrorsPerSec"), (drops, rx) => drops + rx), source.cells("txErrorsPerSec"), (partial, tx) => partial + tx));
}

export function usedShare(table: Table<HostField<"filesystems">>): Cells {
  return table.derived("usedShare", source => combine(source.cells("total"), source.cells("available"), percentUsed));
}
