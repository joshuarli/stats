import type { ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";

export function PageHeader(props: ParentProps<{ readonly title: string; readonly titleExtra?: JSX.Element | undefined; readonly hint?: string | undefined }>): JSX.Element {
  return (
    <header class="page-header">
      <h1>{props.title}</h1>
      {props.titleExtra}
      {props.children}
      {props.hint === undefined ? null : <p class="page-hint">{props.hint}</p>}
    </header>
  );
}
