import { createEffect, createSignal, createUniqueId, Show, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, type IconName } from "./Icon";
import { errorMessage } from "../format";
import { HEALTH_GLYPH, HEALTH_LABEL, type Health } from "../health";

export type Tone = "ok" | "warn" | "bad" | "neutral" | "info" | "accent";

export function Badge(props: { readonly tone: Tone; readonly children: JSX.Element; readonly dot?: boolean }): JSX.Element {
  return (
    <span class={`badge badge-${props.tone}`}>
      {props.dot === true ? <span class="badge-dot" aria-hidden="true" /> : null}
      {props.children}
    </span>
  );
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
  const parsed: unknown = JSON.parse(raw);
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
  const [expanded, setExpanded] = createSignal(false);
  createEffect(expanded, open => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });
  const collapsed = () => props.id !== undefined && collapsedWidgets().has(props.id);
  const toggleCollapsed = () => {
    const id = props.id;
    if (id === undefined) return;
    storeCollapsed(collapsed() ? new Set([...collapsedWidgets()].filter(entry => entry !== id)) : new Set([...collapsedWidgets(), id]));
  };
  const classes = () => ["widget", props.class, expanded() ? "expanded" : undefined, collapsed() ? "collapsed" : undefined].filter(Boolean).join(" ");
  return (
    <>
      <Show when={expanded()}>
        <button class="veil" type="button" aria-label="Close expanded chart" tabindex="-1" onClick={() => setExpanded(false)} />
      </Show>
      <section class={classes()} id={props.id}>
        <header class="widget-head">
          <div class="widget-title">
            <h2>{props.title}</h2>
          </div>
          <div class="widget-meta">
            {props.meta}
            <Show when={props.id !== undefined}>
              <button class="icon-button collapse" type="button" aria-label={`${collapsed() ? "Show" : "Hide"} ${props.title}`} aria-expanded={collapsed() ? "false" : "true"} onClick={toggleCollapsed}>
                <Icon name={collapsed() ? "chevronRight" : "sortDown"} size={14} />
              </button>
            </Show>
            <Show when={props.expandable === true && !collapsed()}>
              <button class="icon-button expand" type="button" aria-label={`${expanded() ? "Collapse" : "Expand"} ${props.title}`} aria-pressed={expanded() ? "true" : "false"} onClick={() => setExpanded(value => !value)}>
                <Icon name="expand" size={12} />
              </button>
            </Show>
          </div>
        </header>
        <Show when={!collapsed()}>
          <div class={props.bodyClass === undefined ? "widget-body" : `widget-body ${props.bodyClass}`}>{props.children}</div>
        </Show>
      </section>
    </>
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

export function HoverCard(props: { readonly label: string; readonly children: JSX.Element; readonly align?: "start" | "end" | undefined }): JSX.Element {
  const id = createUniqueId();
  return (
    <span class="hover-card">
      <button class="icon-button" type="button" aria-label={props.label} aria-describedby={id}>
        <Icon name="info" size={14} />
      </button>
      <div id={id} class={props.align === "end" ? "hover-card-panel align-end" : "hover-card-panel"} role="tooltip" aria-label={props.label}>
        {props.children}
      </div>
    </span>
  );
}

const VALUE_WITH_UNIT = /^(-?\d[\d.,]*)(\s*[^\d\s.,].*)$/u;

export function MetricValue(props: { readonly text: string }): JSX.Element {
  const match = VALUE_WITH_UNIT.exec(props.text);
  return match === null ? props.text : <>{match[1]}<span class="tile-unit">{match[2]}</span></>;
}

export function Tile(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
  readonly spark?: JSX.Element | undefined;
  readonly health?: Health | undefined;
}): JSX.Element {
  return (
    <article class="tile">
      <div class="tile-label"><span>{props.label}</span><HealthMark health={props.health} /></div>
      <div class="tile-value"><MetricValue text={props.value} /></div>
      {props.detail === undefined ? null : <div class="tile-detail">{props.detail}</div>}
      {props.spark === undefined ? null : <div class="tile-spark">{props.spark}</div>}
    </article>
  );
}

export function EmptyState(props: { readonly title: string; readonly detail?: string | undefined; readonly icon?: IconName | undefined; readonly action?: JSX.Element | undefined }): JSX.Element {
  return (
    <div class="empty-state">
      <span class="empty-icon"><Icon name={props.icon ?? "activity"} size={22} /></span>
      <p class="empty-title">{props.title}</p>
      {props.detail === undefined ? null : <p class="empty-detail">{props.detail}</p>}
      {props.action === undefined ? null : <div class="empty-action">{props.action}</div>}
    </div>
  );
}

export function ErrorState(props: { readonly error: unknown; readonly retry?: (() => void) | undefined; readonly compact?: boolean | undefined }): JSX.Element {
  return (
    <div class={props.compact === true ? "error-state compact" : "error-state"} role="alert">
      <span class="error-icon"><Icon name="alert" size={18} /></span>
      <div>
        <p class="error-title">Telemetry could not be loaded</p>
        <p class="error-detail">{errorMessage(props.error)}</p>
      </div>
      {props.retry === undefined ? null : (
        <button class="btn btn-secondary btn-small" type="button" onClick={props.retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Skeleton(props: { readonly rows?: number | undefined; readonly chart?: boolean | undefined }): JSX.Element {
  return (
    <div class="skeleton" aria-hidden="true">
      {Array.from({ length: props.rows ?? 3 }, () => <span class="skeleton-line" />)}
      {props.chart === true ? <span class="skeleton-chart" /> : null}
    </div>
  );
}

export function Notice(props: { readonly tone?: "info" | "warn" | undefined; readonly children: JSX.Element }): JSX.Element {
  return (
    <div class={`notice notice-${props.tone ?? "info"}`}>
      <Icon name={props.tone === "warn" ? "alert" : "info"} size={15} />
      <span>{props.children}</span>
    </div>
  );
}

export function Pagination(props: {
  readonly page: number;
  readonly pages: number;
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly onChange: (page: number) => void;
}): JSX.Element {
  return (
    <div class="pagination">
      <span class="pagination-label">
        Showing <strong>{props.from}</strong>–<strong>{props.to}</strong> of <strong>{props.total}</strong>
      </span>
      <div class="pagination-actions">
        <button
          class="btn btn-icon"
          type="button"
          aria-label="Previous page"
          disabled={props.page <= 1}
          onClick={() => props.onChange(props.page - 1)}
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <span class="pagination-page">
          Page {props.page} of {props.pages}
        </span>
        <button
          class="btn btn-icon"
          type="button"
          aria-label="Next page"
          disabled={props.page >= props.pages}
          onClick={() => props.onChange(props.page + 1)}
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </div>
  );
}

export function Meter(props: { readonly value: number | undefined; readonly warn: number; readonly bad: number }): JSX.Element {
  const clamped = () => props.value === undefined || !Number.isFinite(props.value) ? 0 : Math.min(100, Math.max(0, props.value));
  const tone = () => props.value === undefined ? "tone-neutral" : props.value >= props.bad ? "tone-bad" : props.value >= props.warn ? "tone-warn" : "tone-neutral";
  return (
    <div class="meter" aria-hidden="true">
      <span class={tone()} style={`width:${clamped().toFixed(1)}%`} />
    </div>
  );
}
