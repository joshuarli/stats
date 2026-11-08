import {
  Badge as UiBadge,
  CollapsiblePanel as UiCollapsiblePanel,
  EmptyState as UiEmptyState,
  ErrorState as UiErrorState,
  type IconName,
  Meter as UiMeter,
  Notice as UiNotice,
  Pagination as UiPagination,
  Segmented as UiSegmented,
  Skeleton as UiSkeleton,
  type Tone as UiTone
} from "@joshuarli/ui";
import { createSignal, Show, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { errorMessage } from "../format";
import { HEALTH_GLYPH, HEALTH_LABEL, type Health } from "../health";

export type Tone = UiTone;

export function Badge(props: { readonly tone: Tone; readonly children: JSX.Element; readonly dot?: boolean }): JSX.Element {
  return <UiBadge tone={props.tone} dot={props.dot} class={`badge badge-${props.tone}`}>{props.children}</UiBadge>;
}

export function EntityCell(props: {
  readonly marker: JSX.Element;
  readonly name: string;
  readonly href: string;
  readonly id: string;
  readonly note?: string | undefined;
  readonly onHover?: ((hovered: boolean) => void) | undefined;
}): JSX.Element {
  const hover = (hovered: boolean) => () => props.onHover?.(hovered);
  return (
    <div class="entity-cell">
      {props.marker}
      <div>
        <a class="entity-name" href={props.href} onMouseEnter={hover(true)} onFocus={hover(true)} onMouseLeave={hover(false)} onBlur={hover(false)}>{props.name}</a>
        <span class={props.note === undefined ? "entity-id" : "entity-id entity-note"} title={props.id}>{props.note ?? props.id}</span>
      </div>
    </div>
  );
}

export function StateCell(props: { readonly tone: Tone; readonly label: string; readonly note?: string | undefined }): JSX.Element {
  return (
    <div class="state-cell">
      <Badge tone={props.tone} dot>{props.label}</Badge>
      <Show when={props.note !== undefined}>
        <span class="cell-note">{props.note}</span>
      </Show>
    </div>
  );
}

const COLLAPSED_KEY = "stats.collapsed";

function readCollapsed(): ReadonlySet<string> {
  const raw = window.localStorage.getItem(COLLAPSED_KEY);
  if (raw === null) return new Set<string>();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return new Set<string>(); }
  return new Set<string>(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
}

const [collapsedWidgets, setCollapsedWidgets] = createSignal<ReadonlySet<string>>(readCollapsed());

function storeCollapsed(next: ReadonlySet<string>): void {
  setCollapsedWidgets(next);
  window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
}

export function revealWidget(id: string): void {
  if (!collapsedWidgets().has(id)) return;
  storeCollapsed(new Set([...collapsedWidgets()].filter(entry => entry !== id)));
}

export function jumpTo(anchor: string): void {
  revealWidget(anchor);
  requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

export function Widget(props: ParentProps<{
  readonly title: string;
  readonly meta?: JSX.Element | undefined;
  readonly class?: string | undefined;
  readonly bodyClass?: string | undefined;
  readonly expandable?: boolean | undefined;
  readonly id?: string | undefined;
}>): JSX.Element {
  const collapsed = () => props.id !== undefined && collapsedWidgets().has(props.id);
  const toggleCollapsed = () => {
    const id = props.id;
    if (id === undefined) return;
    storeCollapsed(collapsed() ? new Set([...collapsedWidgets()].filter(entry => entry !== id)) : new Set([...collapsedWidgets(), id]));
  };

  return (
    <UiCollapsiblePanel
      title={props.title}
      meta={props.meta}
      id={props.id}
      expandable={props.expandable}
      collapsible={props.id !== undefined}
      collapsed={collapsed()}
      onToggleCollapsed={toggleCollapsed}
      class={["widget", props.class].filter(Boolean).join(" ")}
      slotClass={props.class}
      bodyClass={props.bodyClass}
    >
      {props.children}
    </UiCollapsiblePanel>
  );
}

export function HealthMark(props: { readonly health: Health | undefined | (() => Health | undefined); readonly showOk?: boolean | undefined; readonly labelled?: boolean | undefined }): JSX.Element {
  const current = () => (typeof props.health === "function" ? props.health() : props.health);
  return (
    <Show when={current()}>
      {(health) => (
        <Show when={health() !== "ok" || props.showOk === true}>
          <span class={`health health-${health()}`}>
            <span class="health-icon" aria-hidden="true">{HEALTH_GLYPH[health()]}</span>
            <span class={props.labelled === true && health() !== "ok" ? "health-text" : "sr-only"}>{HEALTH_LABEL[health()]}</span>
          </span>
        </Show>
      )}
    </Show>
  );
}

const VALUE_WITH_UNIT = /^(-?\d[\d.,]*)(\s*[^\d\s.,].*)$/u;

export function MetricValue(props: { readonly text: string }): JSX.Element {
  const match = VALUE_WITH_UNIT.exec(props.text);
  return match === null ? props.text : <>{match[1]}<span class="tile-unit">{match[2]}</span></>;
}

export function EmptyState(props: { readonly title: string; readonly detail?: string | undefined; readonly icon?: IconName | undefined; readonly action?: JSX.Element | undefined }): JSX.Element {
  return <UiEmptyState title={props.title} detail={props.detail} icon={props.icon} action={props.action} class="empty-state" />;
}

export function ErrorState(props: { readonly error: unknown; readonly retry?: (() => void) | undefined; readonly compact?: boolean | undefined }): JSX.Element {
  return (
    <UiErrorState
      title="Telemetry could not be loaded"
      detail={errorMessage(props.error)}
      retry={props.retry}
      compact={props.compact}
      class={props.compact === true ? "error-state compact" : "error-state"}
    />
  );
}

export function Skeleton(props: { readonly rows?: number | undefined; readonly chart?: boolean | undefined; readonly class?: string | undefined }): JSX.Element {
  return <UiSkeleton rows={props.rows} chart={props.chart} class={["skeleton", props.class].filter(Boolean).join(" ")} />;
}

export function Notice(props: { readonly tone?: "info" | "warn" | undefined; readonly children: JSX.Element }): JSX.Element {
  const legacyTone = props.tone === "warn" ? "notice-warn" : "notice-info";
  return <UiNotice tone={props.tone} class={`notice ${legacyTone}`}>{props.children}</UiNotice>;
}

export function Segmented<T extends string>(props: { readonly label: string; readonly value: T; readonly options: readonly [T, string][]; readonly onChange: (value: T) => void }): JSX.Element {
  return <UiSegmented label={props.label} value={props.value} options={props.options} onChange={props.onChange} class="segmented" />;
}

export function Pagination(props: {
  readonly page: number;
  readonly pages: number;
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly onChange: (page: number) => void;
}): JSX.Element {
  return <UiPagination {...props} class="pagination" />;
}

export function Meter(props: { readonly value: number | undefined; readonly warn: number; readonly bad: number }): JSX.Element {
  return <UiMeter value={props.value} warn={props.warn} bad={props.bad} class="meter" />;
}

export interface PagedList<T> {
  readonly visible: () => readonly T[];
  readonly hidden: () => number;
  readonly more: () => void;
  readonly reveal: (index: number) => void;
}

export function createPagedList<T>(items: () => readonly T[], page: number): PagedList<T> {
  const [shown, setShown] = createSignal(page);
  return {
    visible: () => items().slice(0, shown()),
    hidden: () => Math.max(0, items().length - shown()),
    more: () => setShown(value => value + page),
    reveal: index => setShown(value => Math.max(value, index + 1))
  };
}

export function ShowMore(props: { readonly hidden: number; readonly noun: string; readonly onMore: () => void }): JSX.Element {
  return (
    <Show when={props.hidden > 0}>
      <button type="button" class="list-more" onClick={() => props.onMore()}>Show {props.hidden} more {props.noun}</button>
    </Show>
  );
}
