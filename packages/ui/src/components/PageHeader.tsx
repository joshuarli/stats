import type { JSX } from "@solidjs/web";
import type { ParentProps } from "solid-js";

export interface PageHeaderProps extends ParentProps {
  readonly title: string;
  readonly titleExtra?: JSX.Element | undefined;
  readonly mark?: JSX.Element | undefined;
  readonly class?: string | undefined;
}

export function PageHeader(props: PageHeaderProps): JSX.Element {
  const classes = () => ["ui-page-header", props.class].filter(Boolean).join(" ");
  return (
    <header class={classes()}>
      {props.mark === undefined ? null : <span class="ui-page-mark">{props.mark}</span>}
      <h1>{props.title}</h1>
      {props.titleExtra}
      {props.children}
    </header>
  );
}
