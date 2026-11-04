import { createMemo, createUniqueId, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Health, Limits } from "../health";
import type { Cells, Times } from "../columns";
import { sparkGeometry, sparkToneStops, type SparkTone, type TimeWindow } from "../chart-data";

export interface SparkTrack {
  readonly values: Cells;
  readonly class?: string | undefined;
  readonly mirror?: boolean | undefined;
}

const TONE_CLASS: Readonly<Record<SparkTone, string>> = {
  base: "spark-stop-base",
  elevated: "spark-stop-elevated",
  critical: "spark-stop-critical"
};

export function Sparkline(props: {
  readonly series: readonly SparkTrack[];
  readonly label: string;
  readonly zeroBased?: boolean | undefined;
  readonly health?: Health | undefined;
  readonly limits?: Limits | undefined;
  readonly class?: string | undefined;
  readonly times?: Times | undefined;
  readonly window?: TimeWindow | undefined;
}): JSX.Element {
  const id = createUniqueId();
  const mirrored = createMemo(() => props.series.some(track => track.mirror === true));
  const tracks = createMemo(() => props.series.map(track => ({
    ...track,
    values: track.mirror === true ? track.values.map(value => (value === null ? null : -value)) : track.values
  })));
  const geometry = createMemo(() => sparkGeometry(tracks().map(track => track.values), props.times, props.window, props.zeroBased === true || mirrored(), mirrored()));
  return (
    <svg class={`sparkline${props.health === undefined || props.health === "ok" ? "" : ` health-${props.health}`}${props.class === undefined ? "" : ` ${props.class}`}`} viewBox="0 0 160 40" role="img" aria-label={props.label} preserveAspectRatio="none">
      <Show when={geometry()}>
        {(shape) => (
          <>
            <defs>
              <For each={tracks()}>
                {(track, position) => (
                  <>
                    <linearGradient id={`spark-fill-${id}-${position()}`} class={track.class} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" class="spark-fill-start" />
                      <stop offset="100%" class="spark-fill-end" />
                    </linearGradient>
                    <Show when={mirrored() ? undefined : props.limits}>
                      {(limits) => (
                        <linearGradient id={`spark-stroke-${id}-${position()}`} class={track.class} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="40">
                          <For each={sparkToneStops(shape(), limits())}>
                            {stop => <stop offset={`${(stop.offset * 100).toFixed(2)}%`} class={TONE_CLASS[stop.tone]} />}
                          </For>
                        </linearGradient>
                      )}
                    </Show>
                  </>
                )}
              </For>
              <pattern id={`spark-gap-${id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect class="spark-gap-fill" width="6" height="6" />
                <line class="spark-gap-line" x1="0" y1="0" x2="0" y2="6" />
              </pattern>
            </defs>
            <For each={shape().gaps}>
              {(gap) => <rect class="spark-gap" x={gap.x0.toFixed(2)} y="0" width={Math.max(0, gap.x1 - gap.x0).toFixed(2)} height="40" fill={`url(#spark-gap-${id})`} />}
            </For>
            <For each={shape().areas}>
              {(area, position) => <Show when={area}>{(path) => <path d={path()} fill={`url(#spark-fill-${id}-${position()})`} />}</Show>}
            </For>
            <For each={tracks()}>
              {(track, position) => (
                <path
                  class={`spark-line${track.class === undefined ? "" : ` ${track.class}`}`}
                  d={shape().paths[position()] ?? ""}
                  style={props.limits === undefined || mirrored() ? undefined : `stroke:url(#spark-stroke-${id}-${position()})`}
                />
              )}
            </For>
            <Show when={shape().dot}>
              {(dot) => <circle class={`spark-dot${props.series[0]?.class === undefined ? "" : ` ${props.series[0].class}`}`} cx={dot().x.toFixed(2)} cy={dot().y.toFixed(2)} r="2.2" />}
            </Show>
          </>
        )}
      </Show>
    </svg>
  );
}
