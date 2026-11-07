import { PageHeader as UiPageHeader } from "@joshuarli/ui";
import type { ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";

export function PageHeader(props: ParentProps<{
  readonly title: string;
  readonly titleExtra?: JSX.Element | undefined;
  readonly mark?: JSX.Element | undefined;
}>): JSX.Element {
  return (
    <UiPageHeader
      title={props.title}
      titleExtra={props.titleExtra}
      mark={props.mark}
      class="page-header"
    >
      {props.children}
    </UiPageHeader>
  );
}
