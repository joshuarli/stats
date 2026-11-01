import { For, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, type IconName } from "./Icon";
import { errorMessage } from "../format";

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
}>): JSX.Element {
  return (
    <section class={props.class === undefined ? "widget" : `widget ${props.class}`}>
      <header class="widget-head">
        <div class="widget-title">
          <h2>{props.title}</h2>
          {props.subtitle === undefined ? null : <p>{props.subtitle}</p>}
        </div>
        {props.meta === undefined ? null : <div class="widget-meta">{props.meta}</div>}
      </header>
      <div class={props.bodyClass === undefined ? "widget-body" : `widget-body ${props.bodyClass}`}>{props.children}</div>
    </section>
  );
}

export function MetricTile(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
  readonly tone?: Tone | undefined;
  readonly icon: IconName;
  readonly spark?: JSX.Element | undefined;
  readonly meter?: number | undefined;
}): JSX.Element {
  return (
    <article class={`metric metric-${props.tone ?? "neutral"}`}>
      <div class="metric-head">
        <span class="metric-icon"><Icon name={props.icon} size={15} /></span>
        <span class="metric-label">{props.label}</span>
      </div>
      <div class="metric-value">{props.value}</div>
      {props.detail === undefined ? null : <div class="metric-detail">{props.detail}</div>}
      {props.meter === undefined ? null : (
        <div class="meter" aria-hidden="true">
          <span style={`width:${Math.min(100, Math.max(0, props.meter)).toFixed(1)}%`} />
        </div>
      )}
      {props.spark === undefined ? null : <div class="metric-spark">{props.spark}</div>}
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

export function KeyValue(props: { readonly items: readonly { readonly label: string; readonly value: string }[] }): JSX.Element {
  return (
    <dl class="key-values">
      <For each={props.items}>
        {(item) => (
          <div>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}
