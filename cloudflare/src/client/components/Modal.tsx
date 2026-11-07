import { Modal as UiModal } from "@joshuarli/ui";
import type { ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";

export function Modal(props: ParentProps<{
  readonly title: JSX.Element;
  readonly label: string;
  readonly size?: "wide" | "compact" | undefined;
  readonly onClose: () => void;
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
}>): JSX.Element {
  return (
    <UiModal
      title={props.title}
      label={props.label}
      size={props.size}
      onClose={props.onClose}
      onBack={props.onBack}
      backLabel={props.backLabel}
      class="modal"
    >
      {props.children}
    </UiModal>
  );
}
