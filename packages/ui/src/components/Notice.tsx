import type { JSX } from "@solidjs/web";
import { Icon, type IconName } from "./Icon";

export interface NoticeProps {
  readonly tone?: "info" | "warn" | "bad" | "ok" | undefined;
  readonly icon?: IconName | JSX.Element | undefined;
  readonly class?: string | undefined;
  readonly children: JSX.Element;
}

export function Notice(props: NoticeProps): JSX.Element {
  const tone = () => props.tone ?? "info";
  const classes = () => ["ui-notice", `ui-notice-${tone()}`, props.class].filter(Boolean).join(" ");

  const defaultIcon = (): IconName => {
    switch (tone()) {
      case "warn":
        return "alert";
      case "bad":
        return "alert";
      case "ok":
        return "check";
      default:
        return "info";
    }
  };

  const renderIcon = () => {
    if (props.icon === undefined) return <Icon name={defaultIcon()} size={15} />;
    if (typeof props.icon === "string") return <Icon name={props.icon as IconName} size={15} />;
    return props.icon;
  };

  return (
    <div class={classes()}>
      {renderIcon()}
      <span>{props.children}</span>
    </div>
  );
}
