import { createEffect, createSignal, Show, type ParentProps } from "solid-js";
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

export function Widget(props: ParentProps<{
  readonly title: string;
  readonly subtitle?: string | undefined;
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
  const classes = () => ["widget", props.class, expanded() ? "expanded" : undefined].filter(Boolean).join(" ");
  return (
    <>
      <Show when={expanded()}>
        <button class="veil" type="button" aria-label="Close expanded chart" tabindex="-1" onClick={() => setExpanded(false)} />
      </Show>
      <section class={classes()} id={props.id}>
        <header class="widget-head">
          <div class="widget-title">
            <h2>{props.title}</h2>
            {props.subtitle === undefined ? null : <p>{props.subtitle}</p>}
          </div>
          <div class="widget-meta">
            {props.meta}
            <Show when={props.expandable === true}>
              <button class="icon-button expand" type="button" aria-label={`${expanded() ? "Collapse" : "Expand"} ${props.title}`} aria-pressed={expanded() ? "true" : "false"} onClick={() => setExpanded(value => !value)}>
                <Icon name="expand" size={12} />
              </button>
            </Show>
          </div>
        </header>
        <div class={props.bodyClass === undefined ? "widget-body" : `widget-body ${props.bodyClass}`}>{props.children}</div>
      </section>
    </>
  );
}

export function HealthMark(props: { readonly health: Health | undefined; readonly showOk?: boolean | undefined; readonly word?: boolean | undefined }): JSX.Element {
  return props.health === undefined || (props.health === "ok" && props.showOk !== true) ? null : (
    <span class={`health health-${props.health}`}>
      <span class="health-icon" aria-hidden="true">{HEALTH_GLYPH[props.health]}</span>
      <span class={props.word === false ? "sr-only" : "health-word"}>{HEALTH_LABEL[props.health]}</span>
    </span>
  );
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
      <div class="tile-value">{props.value}</div>
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
