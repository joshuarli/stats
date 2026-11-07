import { For } from "solid-js";
import type { JSX } from "@solidjs/web";

export interface SegmentedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (value: T) => void;
  readonly pending?: boolean | undefined;
  readonly class?: string | undefined;
}

export function Segmented<T extends string>(props: SegmentedProps<T>): JSX.Element {
  const classes = () => [
    "ui-segmented",
    props.pending === true ? "ui-segmented-pending" : undefined,
    props.class
  ].filter(Boolean).join(" ");

  return (
    <div class={classes()} role="group" aria-label={props.label}>
      <For each={props.options}>{([value, label]) => (
        <button
          type="button"
          class="ui-segment segment"
          aria-pressed={props.value === value ? "true" : "false"}
          onClick={() => props.onChange(value)}
        >
          {label}
        </button>
      )}</For>
    </div>
  );
}
