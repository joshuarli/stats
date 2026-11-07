import { Show, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "./Icon";

export interface ModalProps extends ParentProps {
  readonly title: JSX.Element | string;
  readonly label: string;
  readonly size?: "wide" | "compact" | undefined;
  readonly class?: string | undefined;
  readonly onClose: () => void;
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
}

export function Modal(props: ModalProps): JSX.Element {
  const open = (dialog: HTMLDialogElement) => {
    const show = () => {
      if (!dialog.isConnected) {
        requestAnimationFrame(show);
        return;
      }
      if (!dialog.open) dialog.showModal();
    };
    show();
  };

  const classes = () => [
    "ui-modal",
    props.size === "compact" ? "ui-modal-compact" : undefined,
    props.class
  ].filter(Boolean).join(" ");

  return (
    <dialog
      class={classes()}
      aria-label={props.label}
      ref={open}
      closedby="any"
      onClose={() => props.onClose()}
    >
      <header class="ui-modal-head modal-head">
        <Show when={props.onBack}>{back => (
          <button type="button" class="ui-btn ui-btn-small ui-modal-back modal-back" onClick={() => back()()}>
            <Icon name="chevronLeft" size={12} /> {props.backLabel ?? "Back"}
          </button>
        )}</Show>
        <h2 class="ui-modal-title modal-title">{props.title}</h2>
        <button
          type="button"
          class="ui-icon-btn ui-modal-close modal-close"
          aria-label="Close"
          onClick={event => event.currentTarget.closest("dialog")?.close()}
        >
          ×
        </button>
      </header>
      <div class="ui-modal-body modal-body">{props.children}</div>
    </dialog>
  );
}
