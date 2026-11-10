import { createSignal, type Accessor } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "@laputa-systems/ui-dashboard";
import { SortableHeader } from "@laputa-systems/ui-dashboard/data";

export interface Sort<K extends string> {
  readonly key: K;
  readonly direction: 1 | -1;
}

export function createSort<K extends string>(initial: Sort<K>, defaults?: Readonly<Partial<Record<K, 1 | -1>>>): { readonly sort: Accessor<Sort<K>>; readonly sortBy: (key: K) => void } {
  const [sort, setSort] = createSignal(initial);
  const sortBy = (key: K) => setSort(current => ({ key, direction: current.key === key ? (current.direction === 1 ? -1 : 1) : (defaults?.[key] ?? 1) }));
  return { sort, sortBy };
}

export function compareSortValues(left: number | string | null, right: number | string | null): number {
  if (left === null || right === null) {
    if (left === null && right === null) return 0;
    return left === null ? 1 : -1;
  }
  if (typeof left === "string" || typeof right === "string") return String(left).localeCompare(String(right));
  return left - right;
}

export function SortHeader<K extends string>(props: {
  readonly label: string;
  readonly sortKey: K;
  readonly sort: Sort<K>;
  readonly onSort: (key: K) => void;
  readonly class?: string | undefined;
}): JSX.Element {
  return <SortableHeader label={props.label} class={props.class} buttonClass="sort-button" direction={props.sort.key === props.sortKey ? (props.sort.direction === 1 ? "ascending" : "descending") : undefined} onSort={() => props.onSort(props.sortKey)} indicator={direction => <Icon name={direction === "ascending" ? "sortUp" : "sortDown"} size={10} />} />;
}
