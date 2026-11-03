import type { ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";

export function PageHeader(props: ParentProps<{
  readonly title: string;
  readonly titleExtra?: JSX.Element | undefined;
  readonly mark?: JSX.Element | undefined;
}>): JSX.Element {
  return (
    <header class="page-header">
      {props.mark === undefined ? null : <span class="page-mark">{props.mark}</span>}
      <h1>{props.title}</h1>
      {props.titleExtra}
      {props.children}
    </header>
  );
}
