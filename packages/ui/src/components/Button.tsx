import type { JSX } from "@solidjs/web";

export interface ButtonProps {
  readonly variant?: "default" | "small" | "icon" | undefined;
  readonly type?: "button" | "submit" | "reset" | undefined;
  readonly disabled?: boolean | undefined;
  readonly ariaLabel?: string | undefined;
  readonly class?: string | undefined;
  readonly onClick?: ((event: MouseEvent) => void) | undefined;
  readonly children?: JSX.Element;
}

export function Button(props: ButtonProps): JSX.Element {
  const classes = () => [
    "ui-btn",
    props.variant === "small" ? "ui-btn-small" : props.variant === "icon" ? "ui-btn-icon" : undefined,
    props.class
  ].filter(Boolean).join(" ");

  return (
    <button
      type={props.type ?? "button"}
      class={classes()}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export interface IconButtonProps {
  readonly ariaLabel: string;
  readonly disabled?: boolean | undefined;
  readonly class?: string | undefined;
  readonly onClick?: ((event: MouseEvent) => void) | undefined;
  readonly children: JSX.Element;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  const classes = () => ["ui-icon-btn", props.class].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      class={classes()}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
