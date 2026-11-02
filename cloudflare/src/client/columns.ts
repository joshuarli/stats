import { isPresent, type ColumnView, type TableView } from "../binary/columns";

export type Times = readonly number[];
export type Cells = readonly (number | null)[];

export interface Track {
  readonly times: Times;
  readonly values: Cells;
}

const axes = new WeakMap<Float64Array, Times>();

function numbers(column: ColumnView, rows: number): Cells {
  if (column.type === "u64") throw new Error("history columns are never u64");
  return Array.from({ length: rows }, (_, row) => (isPresent(column, row) ? column.values[row]! : null));
}

export function hostAxis(view: TableView): Times {
  const column = view.columns.find(candidate => candidate.name === "atMs");
  if (column === undefined) return [];
  if (column.type !== "f64") throw new Error("the time axis is not f64");
  let times = axes.get(column.values);
  if (times === undefined) {
    times = Array.from(column.values);
    axes.set(column.values, times);
  }
  return times;
}

export function gridAxis(rows: number, fromMs: number, stepMs: number): Times {
  return Array.from({ length: rows }, (_, row) => fromMs + row * stepMs);
}

/** A table of named numeric columns that share one time axis. Absent cells are null, never zero. */
export class Table<Field extends string> {
  readonly rows: number;
  readonly times: Times;
  private readonly columns: ReadonlyMap<string, ColumnView>;
  private readonly cache: Map<string, Cells>;
  private none: Cells | undefined;

  constructor(rows: number, times: Times, columns: ReadonlyMap<string, ColumnView>, cache: Map<string, Cells>) {
    this.rows = rows;
    this.times = times;
    this.columns = columns;
    this.cache = cache;
  }

  static from<Field extends string>(view: TableView, times: Times): Table<Field> {
    return new Table<Field>(view.rows, times, new Map(view.columns.map(column => [column.name, column])), new Map());
  }

  has(field: Field): boolean {
    const column = this.columns.get(field);
    return column !== undefined && (column.validity === null ? this.rows > 0 : column.validity.some(byte => byte !== 0));
  }

  names(): string[] {
    return [...this.columns.keys()];
  }

  cells(field: Field): Cells {
    const known = this.cache.get(field);
    if (known !== undefined) return known;
    const column = this.columns.get(field);
    if (column === undefined) return (this.none ??= Array.from({ length: this.rows }, (): number | null => null));
    const made = numbers(column, this.rows);
    this.cache.set(field, made);
    return made;
  }

  at(field: Field, row: number): number | undefined {
    return this.cells(field)[row] ?? undefined;
  }

  track(field: Field): Track {
    return { times: this.times, values: this.cells(field) };
  }

  derived(key: string, make: (table: this) => Cells): Cells {
    const name = `derived:${key}`;
    const known = this.cache.get(name);
    if (known !== undefined) return known;
    const made = make(this);
    this.cache.set(name, made);
    return made;
  }
}
