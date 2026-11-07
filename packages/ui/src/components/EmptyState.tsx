import type { JSX } from "@solidjs/web";
import { Icon, type IconName } from "./Icon";

export interface EmptyStateProps {
  readonly title: string;
  readonly detail?: string | JSX.Element | undefined;
  readonly icon?: IconName | JSX.Element | undefined;
  readonly action?: JSX.Element | undefined;
  readonly class?: string | undefined;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const classes = () => ["ui-empty-state", props.class].filter(Boolean).join(" ");
  const renderIcon = () => {
    if (props.icon === undefined) return <Icon name="activity" size={22} />;
    if (typeof props.icon === "string") return <Icon name={props.icon as IconName} size={22} />;
    return props.icon;
  };

  return (
    <div class={classes()}>
      <span class="ui-empty-icon">{renderIcon()}</span>
      <p class="ui-empty-title">{props.title}</p>
      {props.detail === undefined ? null : <p class="ui-empty-detail">{props.detail}</p>}
      {props.action === undefined ? null : <div class="ui-empty-action">{props.action}</div>}
    </div>
  );
}
