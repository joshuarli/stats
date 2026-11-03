import { createSignal, For, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { MonitorCell } from "../pages/host/monitors";
import { HealthMark, jumpTo } from "./ui";

export interface SectionLink {
  readonly label: string;
  readonly anchor: string;
}

export function SectionBar(props: { readonly cells: readonly MonitorCell[]; readonly more: readonly SectionLink[] }): JSX.Element {
  const [visible, setVisible] = createSignal(false);
  let sentinel: HTMLDivElement | undefined;

  onSettled(() => {
    const topbar = document.querySelector<HTMLElement>(".topbar");
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      const offset = topbar?.offsetHeight ?? 0;
      root.style.setProperty("--topbar-h", `${offset}px`);
      setVisible((sentinel?.getBoundingClientRect().top ?? 0) < offset);
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

  return (
    <>
      <div class="section-sentinel" aria-hidden="true" ref={(element) => { sentinel = element; }} />
      <nav class={visible() ? "section-bar visible" : "section-bar"} aria-label="Sections">
        <div class="section-bar-items">
          <For each={props.cells}>
            {(cell) => (
              <button class={cell.value === undefined ? "section-link quiet" : "section-link"} type="button" onClick={() => jumpTo(cell.anchor)}>
                {cell.label}
                <HealthMark health={cell.state} showOk />
              </button>
            )}
          </For>
          <span class="section-divider" aria-hidden="true" />
          <For each={props.more}>
            {(link) => <button class="section-link" type="button" onClick={() => jumpTo(link.anchor)}>{link.label}</button>}
          </For>
        </div>
      </nav>
    </>
  );
}
