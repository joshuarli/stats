import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

export interface NavItem {
  readonly href: string;
  readonly label: JSX.Element;
  readonly current?: boolean | undefined;
}

export interface NavGroup {
  readonly label: string;
  readonly heading?: boolean | undefined;
  readonly items: readonly NavItem[];
}

export interface ShellBrand {
  readonly href: string;
  readonly name: string;
  readonly mark?: JSX.Element | undefined;
}

export interface ShellProps {
  readonly brand: ShellBrand;
  readonly nav: readonly NavGroup[];
  readonly foot?: JSX.Element | undefined;
  readonly mainId?: string | undefined;
  readonly children: JSX.Element;
}

export function groupId(index: number): string {
  return `ui-side-group-${index}`;
}

export function SideNav(props: { readonly group: NavGroup; readonly index: number }): JSX.Element {
  return (
    <nav
      class="ui-side-nav"
      aria-label={props.group.heading === true ? undefined : props.group.label}
      aria-labelledby={props.group.heading === true ? groupId(props.index) : undefined}
    >
      <Show when={props.group.heading === true}>
        <span class="ui-side-group" id={groupId(props.index)}>{props.group.label}</span>
      </Show>
      <For each={props.group.items}>
        {(item) => (
          <a href={item.href} aria-current={item.current === true ? "page" : undefined}>{item.label}</a>
        )}
      </For>
    </nav>
  );
}

export function Shell(props: ShellProps): JSX.Element {
  return (
    <div class="ui-shell">
      <aside class="ui-side">
        <div class="ui-side-top">
          <a class="ui-side-brand" href={props.brand.href}>
            {props.brand.mark}
            {props.brand.name}
          </a>
        </div>
        <div class="ui-side-body">
          <For each={props.nav}>
            {(group) => <SideNav group={group} index={props.nav.indexOf(group)} />}
          </For>
          <Show when={props.foot !== undefined}>
            <div class="ui-side-foot">{props.foot}</div>
          </Show>
        </div>
      </aside>
      <main class="ui-main" id={props.mainId ?? "main"} tabindex="-1">{props.children}</main>
    </div>
  );
}
