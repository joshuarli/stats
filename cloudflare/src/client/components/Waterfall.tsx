import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "@laputa-systems/ui-dashboard";
import { axisTicks, place, type Axis } from "../waterfall";

export interface WaterfallRow {
  readonly id: string;
  readonly label: string;
  readonly note?: string | undefined;
  readonly tag?: string | undefined;
  readonly depth?: number | undefined;
  readonly from: number;
  readonly to: number;
  readonly color: number;
  readonly failed?: boolean | undefined;
  readonly values: readonly string[];
  readonly detail?: (() => JSX.Element) | undefined;
}

export interface SummaryStat {
  readonly label: JSX.Element;
  readonly value: string;
  readonly note?: string | undefined;
}

export function WaterfallSummary(props: { readonly stats: readonly SummaryStat[] }): JSX.Element {
  return (
    <dl class="wf-stats">
      <For each={props.stats}>{stat => (
        <div class="wf-stat">
          <dt>{stat.label}</dt>
          <dd>
            <strong title={stat.value}>{stat.value}</strong>
            <Show when={stat.note !== undefined}><span class="wf-stat-note">{stat.note}</span></Show>
          </dd>
        </div>
      )}</For>
    </dl>
  );
}

function gridLines(positions: readonly number[]): string {
  const layers = positions.filter(position => position > 0.2 && position < 100).map(position => `linear-gradient(var(--line), var(--line)) ${position.toFixed(3)}% 0 / 1px 100% no-repeat`);
  return layers.length === 0 ? "linear-gradient(transparent, transparent)" : layers.join(", ");
}

function StepLabel(props: { readonly row: WaterfallRow }): JSX.Element {
  return (
    <>
      <span class="wf-label">{props.row.label}</span>
      <Show when={props.row.note !== undefined}><span class="wf-note">{props.row.note}</span></Show>
      <Show when={props.row.tag !== undefined}><span class="wf-tag">{props.row.tag}</span></Show>
    </>
  );
}

export function Waterfall(props: {
  readonly label: string;
  readonly stepLabel: string;
  readonly columns: readonly string[];
  readonly valueWidth?: number | undefined;
  readonly axis: Axis;
  readonly rows: readonly WaterfallRow[];
  readonly expanded?: string | null | undefined;
  readonly onExpand?: ((id: string | null) => void) | undefined;
}): JSX.Element {
  const positions = createMemo(() => {
    const span = props.axis.to - props.axis.from;
    return axisTicks(props.axis.from, props.axis.to).map(tick => ({ tick, position: ((tick - props.axis.from) / span) * 100 }));
  });
  const expandable = createMemo(() => props.rows.some(row => row.detail !== undefined));
  return (
    <div class="table-scroll">
      <table class="wf" aria-label={props.label} style={`--wf-grid:${gridLines(positions().map(entry => entry.position))}`}>
        <colgroup>
          <col class="wf-col-step" />
          <col />
          <For each={props.columns}>{() => <col class="wf-col-value" style={props.valueWidth === undefined ? undefined : `width:${props.valueWidth}px`} />}</For>
        </colgroup>
        <thead>
          <tr>
            <th scope="col" class="wf-step">{props.stepLabel}</th>
            <th scope="col" class="wf-bar wf-axis-head">
              <For each={positions()}>{entry => <span class={entry.position > 80 ? "wf-tick end" : "wf-tick"} style={`left:${entry.position}%`}>{props.axis.format(entry.tick)}</span>}</For>
            </th>
            <For each={props.columns}>{column => <th scope="col" class="numeric">{column}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>{row => {
            const open = () => props.expanded === row.id;
            const placed = () => place(row.from, row.to, props.axis);
            return (
              <>
                <tr class={`${row.failed === true ? "failed" : ""}${open() ? " expanded" : ""}`}>
                  <th scope="row" class="wf-step" style={`--depth:${row.depth ?? 0}`}>
                    <Show
                      when={row.detail !== undefined}
                      fallback={<div class="wf-name"><Show when={expandable()}><span class="wf-lead" /></Show><StepLabel row={row} /></div>}
                    >
                      <button type="button" class="wf-name wf-toggle" data-key={row.id} title={row.label} aria-expanded={open() ? "true" : "false"} onClick={() => props.onExpand?.(open() ? null : row.id)}>
                        <span class="wf-lead"><Icon name="chevronRight" size={12} /></span>
                        <StepLabel row={row} />
                      </button>
                    </Show>
                  </th>
                  <td class="wf-bar">
                    <Show when={placed()}>{extent => (
                      <span class={`wf-fill c${row.color}${row.failed === true ? " failed" : ""}${extent().clippedStart ? " clip-start" : ""}${extent().clippedEnd ? " clip-end" : ""}`} style={`left:${extent().left}%;width:${extent().width}%`} />
                    )}</Show>
                  </td>
                  <For each={row.values}>{value => <td class="numeric">{value}</td>}</For>
                </tr>
                <Show when={open() && row.detail !== undefined}>
                  <tr class="wf-detail"><td colspan={2 + props.columns.length}>{row.detail?.()}</td></tr>
                </Show>
              </>
            );
          }}</For>
        </tbody>
      </table>
    </div>
  );
}
