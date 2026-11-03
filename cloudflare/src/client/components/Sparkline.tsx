import { createMemo, createUniqueId, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Health } from "../health";
import type { Cells, Times } from "../columns";
import { sparkGeometry, type TimeWindow } from "../chart-data";

export interface SparkTrack {
  readonly values: Cells;
  readonly class?: string | undefined;
}

export function Sparkline(props: {
  readonly series: readonly SparkTrack[];
  readonly label: string;
  readonly zeroBased?: boolean | undefined;
  readonly health?: Health | undefined;
  readonly class?: string | undefined;
  readonly times?: Times | undefined;
  readonly window?: TimeWindow | undefined;
}): JSX.Element {
  const id = createUniqueId();
  const geometry = createMemo(() => sparkGeometry(props.series.map(track => track.values), props.times, props.window, props.zeroBased === true));
  return (
    <svg class={`sparkline${props.health === undefined || props.health === "ok" ? "" : ` health-${props.health}`}${props.class === undefined ? "" : ` ${props.class}`}`} viewBox="0 0 160 40" role="img" aria-label={props.label} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" class="spark-fill-start" />
          <stop offset="100%" class="spark-fill-end" />
        </linearGradient>
      </defs>
      {geometry() === null ? null : (
        <>
          <Show when={geometry()!.area}>
            {(area) => <path class="spark-area" d={area()} fill={`url(#spark-${id})`} />}
          </Show>
          <For each={props.series}>
            {(track, position) => <path class={`spark-line${track.class === undefined ? "" : ` ${track.class}`}`} d={geometry()!.paths[position()] ?? ""} />}
          </For>
          <Show when={geometry()!.dot}>
            {(dot) => <circle class="spark-dot" cx={dot().x.toFixed(2)} cy={dot().y.toFixed(2)} r="2.2" />}
          </Show>
        </>
      )}
    </svg>
  );
}
