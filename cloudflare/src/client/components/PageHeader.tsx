import { For, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isPending, latest } from "solid-js";
import { Icon } from "./Icon";
import { ranges, useTelemetry } from "../state";

export function PageHeader(props: ParentProps<{ readonly title: string; readonly subtitle: string; readonly eyebrow?: string | undefined; readonly titleExtra?: JSX.Element | undefined; readonly actions?: JSX.Element | undefined }>): JSX.Element {
  return (
    <header class="page-header">
      <div class="page-title">
        {props.eyebrow === undefined ? null : <p class="eyebrow">{props.eyebrow}</p>}
        <div class="title-line">
          <h1>{props.title}</h1>
          {props.titleExtra}
        </div>
        <p class="page-subtitle">{props.subtitle}</p>
      </div>
      {props.actions === undefined ? null : <div class="page-actions">{props.actions}</div>}
      {props.children}
    </header>
  );
}

export function RangePicker(): JSX.Element {
  const { range, setRange } = useTelemetry();
  return (
    <div class={isPending(range) ? "segmented pending" : "segmented"} role="group" aria-label="Time range">
      <For each={ranges}>
        {(option) => (
          <button
            class="segment"
            type="button"
            aria-pressed={latest(range) === option ? "true" : "false"}
            onClick={() => { setRange(option); }}
          >
            {option}
          </button>
        )}
      </For>
    </div>
  );
}

export function RefreshButton(props: { readonly pending: boolean; readonly onClick: () => void }): JSX.Element {
  return (
    <button class="btn btn-secondary" type="button" onClick={props.onClick} disabled={props.pending}>
      <Icon name="refresh" size={14} class={props.pending ? "spin" : undefined} />
      Refresh
    </button>
  );
}
