import { createSignal, For, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { MonitorCell } from "../pages/host/monitors";
import { HealthMark, jumpTo } from "./ui";

export interface SectionLink {
  readonly label: string;
  readonly anchor: string;
}

const LANDING_GAP_PX = 52;

export function SectionBar(props: { readonly cells: readonly MonitorCell[]; readonly more: readonly SectionLink[] }): JSX.Element {
  const [visible, setVisible] = createSignal(false);
  const [active, setActive] = createSignal<string | null>(null);
  let sentinel: HTMLDivElement | undefined;
  let items: HTMLDivElement | undefined;

  const anchors = () => [...props.cells.map(cell => cell.anchor), ...props.more.map(link => link.anchor)];

  onSettled(() => {
    const topbar = document.querySelector<HTMLElement>(".topbar");
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      const offset = topbar?.offsetHeight ?? 0;
      root.style.setProperty("--topbar-h", `${offset}px`);
      const shown = (sentinel?.getBoundingClientRect().top ?? 0) < offset;
      setVisible(shown);
      let nearest: string | null = null;
      let nearestTop = Number.NEGATIVE_INFINITY;
      if (shown) {
        for (const anchor of anchors()) {
          const top = document.getElementById(anchor)?.getBoundingClientRect().top;
          if (top !== undefined && top <= offset + LANDING_GAP_PX && top > nearestTop) {
            nearest = anchor;
            nearestTop = top;
          }
        }
      }
      setActive(nearest);
      const current = items?.querySelector<HTMLElement>('[aria-current="location"]');
      if (current !== null && current !== undefined && items !== undefined) items.scrollTo({ left: current.offsetLeft - (items.clientWidth - current.offsetWidth) / 2 });
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
      root.style.removeProperty("--topbar-h");
    };
  });

  const here = (anchor: string) => (active() === anchor ? "location" : undefined);

  return (
    <>
      <div class="section-sentinel" aria-hidden="true" ref={(element) => { sentinel = element; }} />
      <nav class={visible() ? "section-bar visible" : "section-bar"} aria-label="Sections">
        <div class="section-bar-items" ref={(element) => { items = element; }}>
          <For each={props.cells}>
            {(cell) => (
              <button class={cell.value === undefined ? "section-link quiet" : "section-link"} type="button" aria-current={here(cell.anchor)} onClick={() => jumpTo(cell.anchor)}>
                {cell.label}
                <HealthMark health={cell.state} showOk />
              </button>
            )}
          </For>
          <span class="section-divider" aria-hidden="true" />
          <For each={props.more}>
            {(link) => <button class="section-link" type="button" aria-current={here(link.anchor)} onClick={() => jumpTo(link.anchor)}>{link.label}</button>}
          </For>
        </div>
      </nav>
    </>
  );
}
