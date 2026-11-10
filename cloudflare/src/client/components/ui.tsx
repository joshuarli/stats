import {
  Badge,
  CollapsiblePanel as UiCollapsiblePanel,
  ErrorState as UiErrorState,
  Notice as UiNotice,
  Segmented as UiSegmented,
  type Tone as UiTone
} from "@laputa-systems/ui-dashboard";
import { createSignal, Show, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { errorMessage } from "../format";
import { HEALTH_GLYPH, HEALTH_LABEL, type Health } from "../health";

export type Tone = UiTone;

export function EntityCell(props: {
  readonly marker: JSX.Element;
  readonly name: string;
  readonly href: string;
  readonly id: string;
  readonly note?: string | undefined;
  readonly onHover?: ((hovered: boolean) => void) | undefined;
  readonly onNavigate?: (() => void) | undefined;
  readonly onLinkMount?: ((link: HTMLAnchorElement) => void) | undefined;
}): JSX.Element {
  const hover = (hovered: boolean) => () => props.onHover?.(hovered);
  return (
    <div class="entity-cell">
      {props.marker}
      <div>
        <a ref={element => props.onLinkMount?.(element)} class="entity-name" href={props.href} onClick={event => { if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) props.onNavigate?.(); }} onMouseEnter={hover(true)} onFocus={hover(true)} onMouseLeave={hover(false)} onBlur={hover(false)}>{props.name}</a>
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
            <span class={props.labelled === true && health() !== "ok" ? "health-text" : "ui-sr-only"}>{HEALTH_LABEL[health()]}</span>
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

export function ErrorState(props: { readonly error: unknown; readonly retry?: (() => void) | undefined; readonly compact?: boolean | undefined }): JSX.Element {
  return (
    <UiErrorState
      title="Telemetry could not be loaded"
      detail={errorMessage(props.error)}
      retry={props.retry}
      compact={props.compact}
    />
  );
}

export function Notice(props: { readonly tone?: "info" | "warn" | undefined; readonly children: JSX.Element }): JSX.Element {
  const legacyTone = props.tone === "warn" ? "notice-warn" : "notice-info";
  return <UiNotice tone={props.tone} class={`notice ${legacyTone}`}>{props.children}</UiNotice>;
}

export function Segmented<T extends string>(props: { readonly label: string; readonly value: T; readonly options: readonly [T, string][]; readonly onChange: (value: T) => void }): JSX.Element {
  return <UiSegmented label={props.label} value={props.value} options={props.options} onChange={props.onChange} class="segmented" />;
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
