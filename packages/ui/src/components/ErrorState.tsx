import type { JSX } from "@solidjs/web";
import { Icon, type IconName } from "./Icon";

export interface ErrorStateProps {
  readonly title?: string | undefined;
  readonly detail?: string | JSX.Element | undefined;
  readonly retry?: (() => void) | undefined;
  readonly retryLabel?: string | undefined;
  readonly compact?: boolean | undefined;
  readonly icon?: IconName | JSX.Element | undefined;
  readonly class?: string | undefined;
}

export function ErrorState(props: ErrorStateProps): JSX.Element {
  const classes = () => [
    "ui-error-state",
    props.compact === true ? "ui-error-state-compact" : undefined,
    props.class
  ].filter(Boolean).join(" ");

  const renderIcon = () => {
    if (props.icon === undefined) return <Icon name="alert" size={18} />;
    if (typeof props.icon === "string") return <Icon name={props.icon as IconName} size={18} />;
    return props.icon;
  };

  return (
    <div class={classes()} role="alert">
      <span class="ui-error-icon">{renderIcon()}</span>
      <div class="ui-error-content">
        <p class="ui-error-title">{props.title ?? "An error occurred"}</p>
        {props.detail === undefined ? null : <p class="ui-error-detail">{props.detail}</p>}
      </div>
      {props.retry === undefined ? null : (
        <button class="ui-btn ui-btn-small" type="button" onClick={props.retry}>
          {props.retryLabel ?? "Retry"}
        </button>
      )}
    </div>
  );
}
