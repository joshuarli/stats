import type { JSX } from "@solidjs/web";

export type Tone = "ok" | "warn" | "bad" | "neutral" | "info" | "accent";

export interface BadgeProps {
  readonly tone: Tone;
  readonly children: JSX.Element;
  readonly dot?: boolean | undefined;
  readonly class?: string | undefined;
}

export function Badge(props: BadgeProps): JSX.Element {
  const classes = () => ["ui-badge", `ui-badge-${props.tone}`, props.class].filter(Boolean).join(" ");
  return (
    <span class={classes()}>
      {props.dot === true ? <span class="ui-badge-dot badge-dot" aria-hidden="true" /> : null}
      {props.children}
    </span>
  );
}
