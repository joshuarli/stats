import { createEffect, createSignal, createUniqueId, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, Modal } from "@laputa-systems/ui-dashboard";

const TIP_WIDTH = 280;
const EDGE = 8;

type TipPlace = { readonly left: number; readonly top: number | null; readonly bottom: number | null };

function placeTip(anchor: DOMRect): TipPlace {
  const left = Math.min(Math.max(EDGE, anchor.left), window.innerWidth - TIP_WIDTH - EDGE);
  return anchor.top > window.innerHeight / 2
    ? { left, top: null, bottom: window.innerHeight - anchor.top + EDGE }
    : { left, top: anchor.bottom + EDGE, bottom: null };
}

function InfoModal(props: { readonly title: string; readonly onClose: () => void; readonly children: JSX.Element }): JSX.Element {
  return (
    <Modal title={props.title} label={props.title} size="compact" onClose={props.onClose}>
      <div class="info-body">{props.children}</div>
    </Modal>
  );
}

export function Info(props: { readonly title: string; readonly children: JSX.Element }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button class="info-button" type="button" aria-label={`About ${props.title}`} onClick={() => setOpen(true)}>
        <Icon name="info" size={12} />
      </button>
      <Show when={open()}>
        <InfoModal title={props.title} onClose={() => setOpen(false)}>{props.children}</InfoModal>
      </Show>
    </>
  );
}

export function Term(props: { readonly hint: string; readonly children: string }): JSX.Element {
  const id = createUniqueId();
  const [tip, setTip] = createSignal<TipPlace | null>(null);
  const [open, setOpen] = createSignal(false);
  const hide = () => setTip(null);
  const show = (event: { readonly currentTarget: HTMLButtonElement }) => setTip(placeTip(event.currentTarget.getBoundingClientRect()));
  createEffect(tip, place => {
    if (place === null) return;
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", hide, { capture: true });
  });
  return (
    <>
      <button
        class="term"
        type="button"
        aria-describedby={id}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={event => { if (event.currentTarget.matches(":focus-visible")) show(event); }}
        onBlur={hide}
        onClick={() => { hide(); setOpen(true); }}
      >
        {props.children}
      </button>
      <span id={id} class="sr-only">{props.hint}</span>
      <Show when={tip()}>{place => (
        <span class="term-tip" aria-hidden="true" style={`left:${place().left}px;${place().top === null ? `bottom:${place().bottom}px` : `top:${place().top}px`}`}>{props.hint}</span>
      )}</Show>
      <Show when={open()}>
        <InfoModal title={props.children} onClose={() => setOpen(false)}><p>{props.hint}</p></InfoModal>
      </Show>
    </>
  );
}
