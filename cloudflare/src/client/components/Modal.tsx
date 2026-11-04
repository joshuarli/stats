import { Show, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "./Icon";

export function Modal(props: ParentProps<{
  readonly title: JSX.Element;
  readonly label: string;
  readonly size?: "wide" | "compact" | undefined;
  readonly onClose: () => void;
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
}>): JSX.Element {
  const open = (dialog: HTMLDialogElement) => {
    const show = () => {
      if (!dialog.isConnected) { requestAnimationFrame(show); return; }
      if (!dialog.open) dialog.showModal();
    };
    show();
  };
  return (
    <dialog
      class={props.size === "compact" ? "modal compact" : "modal"}
      aria-label={props.label}
      ref={open}
      closedby="any"
      onClose={() => props.onClose()}
    >
      <header class="modal-head">
        <Show when={props.onBack}>{back => (
          <button type="button" class="btn btn-small modal-back" onClick={() => back()()}>
            <Icon name="chevronLeft" size={12} /> {props.backLabel ?? "Back"}
          </button>
        )}</Show>
        <h2 class="modal-title">{props.title}</h2>
        <button type="button" class="icon-button modal-close" aria-label="Close" onClick={event => event.currentTarget.closest("dialog")?.close()}>×</button>
      </header>
      <div class="modal-body">{props.children}</div>
    </dialog>
  );
}
