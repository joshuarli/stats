import { For, Show, isPending, latest } from "solid-js";
import type { JSX } from "@solidjs/web";
import { duration } from "../chart-data";
import { dateTime } from "../format";
import { rangeLabels, ranges, useTelemetry } from "../state";
import { Icon } from "./Icon";

export function TimeBar(): JSX.Element {
  const { range, setRange, view, canZoomOut, live, zoomOut, resetZoom, pan, toggleLive, requestRefresh } = useTelemetry();
  return (
    <div class="timebar">
      <div class={isPending(range) ? "segmented pending" : "segmented"} role="group" aria-label="Time range">
        <For each={ranges}>
          {(option) => (
            <button class="segment" type="button" aria-pressed={latest(range) === option && view() === null ? "true" : "false"} onClick={() => { setRange(option); }}>
              {option}
            </button>
          )}
        </For>
      </div>
      <div class="pan">
        <button class="icon-button" type="button" aria-label="Pan back" disabled={view() === null} onClick={() => pan(-1)}><Icon name="chevronLeft" size={13} /></button>
        <button class="icon-button" type="button" aria-label="Pan forward" disabled={view() === null} onClick={() => pan(1)}><Icon name="chevronRight" size={13} /></button>
      </div>
      <output class={view() === null ? "window" : "window zoomed"} aria-label="Visible time window">
        <Show when={view()} fallback={rangeLabels[range()]}>
          {(window) => (
            <>
              <span>{dateTime(window().fromMs)}</span>
              <Icon name="arrowRight" size={12} />
              <span>{dateTime(window().toMs)}</span>
              <em>{duration(window().toMs - window().fromMs)}</em>
            </>
          )}
        </Show>
      </output>
      <Show when={view() !== null}>
        <button class="btn" type="button" disabled={!canZoomOut()} onClick={zoomOut}>Zoom out<kbd>z</kbd></button>
        <button class="btn" type="button" onClick={resetZoom}>Reset<kbd>esc</kbd></button>
      </Show>
      <button class={live() && view() === null ? "btn live on" : "btn live"} type="button" aria-pressed={live() && view() === null ? "true" : "false"} onClick={toggleLive}>
        <span class="live-dot" aria-hidden="true" />
        {view() === null ? "Live" : "Back to live"}<kbd>l</kbd>
      </button>
      <button class="icon-button" type="button" aria-label="Refresh" onClick={requestRefresh}><Icon name="refresh" size={14} /></button>
    </div>
  );
}
