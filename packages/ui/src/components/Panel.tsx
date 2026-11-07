import { createEffect, createSignal, Show, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "./Icon";

export interface PanelProps {
  readonly title: string | JSX.Element;
  readonly meta?: JSX.Element | undefined;
  readonly class?: string | undefined;
  readonly bodyClass?: string | undefined;
  readonly flush?: boolean | undefined;
  readonly id?: string | undefined;
  readonly children: JSX.Element;
}

export function Panel(props: PanelProps): JSX.Element {
  const classes = () => ["ui-panel", props.class].filter(Boolean).join(" ");
  const bodyClasses = () => [
    "ui-panel-body",
    props.flush === true ? "ui-panel-flush" : undefined,
    props.bodyClass
  ].filter(Boolean).join(" ");

  return (
    <section class={classes()} id={props.id}>
      <header class="ui-panel-head">
        <div class="ui-panel-title">
          {typeof props.title === "string" ? <h2>{props.title}</h2> : props.title}
        </div>
        <Show when={props.meta !== undefined}>
          <div class="ui-panel-meta">{props.meta}</div>
        </Show>
      </header>
      <div class={bodyClasses()}>{props.children}</div>
    </section>
  );
}

export interface CollapsiblePanelProps extends ParentProps {
  readonly title: string | JSX.Element;
  readonly meta?: JSX.Element | undefined;
  readonly class?: string | undefined;
  readonly bodyClass?: string | undefined;
  readonly slotClass?: string | undefined;
  readonly flush?: boolean | undefined;
  readonly id?: string | undefined;
  readonly expandable?: boolean | undefined;
  readonly expanded?: boolean | undefined;
  readonly onToggleExpanded?: (() => void) | undefined;
  readonly collapsible?: boolean | undefined;
  readonly collapsed?: boolean | undefined;
  readonly onToggleCollapsed?: (() => void) | undefined;
}

export function CollapsiblePanel(props: CollapsiblePanelProps): JSX.Element {
  const [localExpanded, setLocalExpanded] = createSignal(false);
  const [slotHeight, setSlotHeight] = createSignal(0);
  let section: HTMLElement | undefined;

  const isExpanded = () => props.expanded ?? localExpanded();
  const isCollapsed = () => props.collapsed ?? false;

  const toggleExpanded = () => {
    if (props.onToggleExpanded !== undefined) {
      props.onToggleExpanded();
      return;
    }
    if (!localExpanded()) {
      setSlotHeight(section?.getBoundingClientRect().height ?? 0);
    }
    setLocalExpanded(open => !open);
  };

  createEffect(isExpanded, open => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (props.onToggleExpanded !== undefined) {
        props.onToggleExpanded();
      } else {
        setLocalExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const titleString = () => (typeof props.title === "string" ? props.title : "");
  const classes = () => [
    "ui-panel",
    props.class,
    isExpanded() ? "ui-panel-expanded expanded" : undefined,
    isCollapsed() ? "ui-panel-collapsed collapsed" : undefined
  ].filter(Boolean).join(" ");

  const bodyClasses = () => [
    "ui-panel-body widget-body",
    props.flush === true ? "ui-panel-flush flush" : undefined,
    props.bodyClass
  ].filter(Boolean).join(" ");

  return (
    <>
      <Show when={isExpanded()}>
        <button
          class="ui-panel-veil veil"
          type="button"
          aria-label="Close expanded panel"
          tabindex="-1"
          onClick={toggleExpanded}
        />
      </Show>
      <Show when={isExpanded()}>
        <div
          class={["ui-panel-slot widget-slot", props.slotClass].filter(Boolean).join(" ")}
          style={`height:${slotHeight()}px`}
          aria-hidden="true"
        />
      </Show>
      <section class={classes()} id={props.id} ref={(element) => { section = element; }}>
        <header class="ui-panel-head widget-head">
          <div class="ui-panel-title widget-title">
            {typeof props.title === "string" ? <h2>{props.title}</h2> : props.title}
          </div>
          <div class="ui-panel-meta widget-meta">
            {props.meta}
            <Show when={props.expandable === true}>
              <button
                class="ui-icon-btn icon-button ui-panel-expand expand"
                type="button"
                aria-label={`${isExpanded() ? "Collapse" : "Expand"} ${titleString()}`}
                aria-pressed={isExpanded() ? "true" : "false"}
                disabled={isCollapsed()}
                onClick={toggleExpanded}
              >
                <Icon name="expand" size={12} />
              </button>
            </Show>
            <Show when={props.collapsible === true || props.onToggleCollapsed !== undefined}>
              <button
                class="ui-icon-btn icon-button ui-panel-collapse collapse"
                type="button"
                aria-label={`${isCollapsed() ? "Show" : "Hide"} ${titleString()}`}
                aria-expanded={isCollapsed() ? "false" : "true"}
                onClick={() => props.onToggleCollapsed?.()}
              >
                <Icon name={isCollapsed() ? "chevronRight" : "sortDown"} size={14} />
              </button>
            </Show>
          </div>
        </header>
        <Show when={!isCollapsed()}>
          <div class={bodyClasses()}>{props.children}</div>
        </Show>
      </section>
    </>
  );
}
