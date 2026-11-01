import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { percent, shortTime, timestamp } from "../format";

export interface ChartPoint {
  readonly atMs: number;
  readonly value?: number | undefined;
}

export interface ChartSeries {
  readonly label: string;
  readonly color: number;
  readonly points: readonly ChartPoint[];
  readonly dash?: "solid" | "dashed" | "dotted" | undefined;
}

export interface TimeChartProps {
  readonly label: string;
  readonly series: readonly ChartSeries[];
  readonly format?: (value: number | undefined) => string;
  readonly min?: number;
  readonly max?: number;
  readonly height?: number;
  readonly latest?: number | null;
}

interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly from: number;
  readonly to: number;
  readonly low: number;
  readonly high: number;
}

function finitePoints(series: readonly ChartSeries[]): Array<{ readonly atMs: number; readonly value: number }> {
  return series.flatMap(entry => entry.points).filter((point): point is { readonly atMs: number; readonly value: number } => point.value !== undefined && Number.isFinite(point.value));
}

function seriesPath(points: readonly ChartPoint[], x: (time: number) => number, y: (value: number) => number): string {
  let path = "";
  let drawing = false;
  for (const point of points) {
    if (point.value === undefined || !Number.isFinite(point.value)) {
      drawing = false;
      continue;
    }
    path += `${drawing ? "L" : "M"}${x(point.atMs).toFixed(2)},${y(point.value).toFixed(2)} `;
    drawing = true;
  }
  return path.trim();
}

function nearest(points: readonly ChartPoint[], time: number): number | undefined {
  let best: ChartPoint | undefined;
  for (const point of points) {
    if (point.value === undefined || !Number.isFinite(point.value)) continue;
    if (best === undefined || Math.abs(point.atMs - time) < Math.abs(best.atMs - time)) best = point;
  }
  return best?.value;
}

export function TimeChart(props: TimeChartProps): JSX.Element {
  const id = createUniqueId();
  const [hover, setHover] = createSignal<number | null>(null);
  const format = (value: number | undefined) => (props.format ?? percent)(value);

  const ordered = createMemo(() => [...new Set(finitePoints(props.series).map(point => point.atMs))].sort((left, right) => left - right));

  const geometry = createMemo<Geometry | null>(() => {
    const points = finitePoints(props.series);
    if (points.length === 0) return null;
    const from = Math.min(...points.map(point => point.atMs));
    const to = Math.max(...points.map(point => point.atMs));
    let low = props.min ?? Math.min(...points.map(point => point.value));
    let high = props.max ?? Math.max(...points.map(point => point.value));
    if (low === high) {
      low -= 1;
      high += 1;
    }
    const padding = (high - low) * 0.08;
    if (props.min === undefined) low -= padding;
    if (props.max === undefined) high += padding;
    return {
      width: 760,
      height: props.height ?? 230,
      left: 54,
      right: 16,
      top: 14,
      bottom: 28,
      from,
      to,
      low,
      high
    };
  });

  const x = (time: number) => {
    const box = geometry();
    if (box === null) return 0;
    return box.left + ((time - box.from) / Math.max(1, box.to - box.from)) * (box.width - box.left - box.right);
  };

  const y = (value: number) => {
    const box = geometry();
    if (box === null) return 0;
    return box.top + (1 - (value - box.low) / (box.high - box.low)) * (box.height - box.top - box.bottom);
  };

  const hoveredTime = createMemo(() => {
    const index = hover();
    if (index === null) return null;
    return ordered()[index] ?? null;
  });

  const latest = createMemo(() => {
    if (props.latest === null) return undefined;
    if (props.latest !== undefined) return props.latest;
    const points = props.series.at(0)?.points ?? [];
    return points.at(-1)?.value;
  });

  const readout = createMemo(() => {
    const time = hoveredTime();
    if (time === null) return `Latest ${format(latest())}`;
    const values = props.series.map(series => `${series.label} ${format(nearest(series.points, time))}`).join(" · ");
    return `${timestamp(time)} · ${values}`;
  });

  const selectIndex = (index: number) => {
    const times = ordered();
    if (times.length === 0) return;
    setHover(Math.max(0, Math.min(times.length - 1, index)));
  };

  const onPointerMove = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
    const times = ordered();
    if (times.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    selectIndex(Math.round(ratio * (times.length - 1)));
  };

  const onKeyDown = (event: KeyboardEvent & { currentTarget: SVGSVGElement }) => {
    const times = ordered();
    if (times.length === 0) return;
    const current = hover() ?? times.length - 1;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectIndex(current - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      selectIndex(current + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectIndex(times.length - 1);
    }
  };

  return (
    <Show when={geometry()} fallback={<div class="chart-empty">No samples in this range.</div>}>
      {(box) => (
        <div class="chart">
          <svg
            class="chart-svg"
            viewBox={`0 0 ${box().width} ${box().height}`}
            role="img"
            tabindex="0"
            aria-label={`${props.label}; latest ${format(latest())}`}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
            onFocus={() => selectIndex(hover() ?? ordered().length - 1)}
            onKeyDown={onKeyDown}
          >
            <defs>
              <For each={props.series}>
                {(series) => (
                  <linearGradient id={`area-${id}-${series.color}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" class={`area-start series-${series.color}`} />
                    <stop offset="100%" class={`area-end series-${series.color}`} />
                  </linearGradient>
                )}
              </For>
            </defs>
            <For each={[0, 1 / 3, 2 / 3, 1]}>
              {(fraction) => {
                const value = () => box().low + (box().high - box().low) * fraction;
                return (
                  <>
                    <line class="chart-gridline" x1={box().left} x2={box().width - box().right} y1={y(value())} y2={y(value())} />
                    <text class="chart-axis" x={box().left - 8} y={y(value()) + 4} text-anchor="end">{format(value())}</text>
                  </>
                );
              }}
            </For>
            <For each={props.series}>
              {(series) => {
                const path = seriesPath(series.points, x, y);
                return (
                  <>
                    <Show when={path.length > 0}>
                      <Show when={props.series.length === 1}>
                        <path class={`chart-area series-${series.color}`} d={`${path} L${x(box().to).toFixed(2)},${box().height - box().bottom} L${x(box().from).toFixed(2)},${box().height - box().bottom} Z`} fill={`url(#area-${id}-${series.color})`} />
                      </Show>
                      <path class={`chart-line series-${series.color}${series.dash === undefined ? "" : ` dash-${series.dash}`}`} d={path}>
                        <title>{series.label}</title>
                      </path>
                    </Show>
                  </>
                );
              }}
            </For>
            <text class="chart-axis" x={box().left} y={box().height - 6}>{shortTime(box().from)}</text>
            <text class="chart-axis" x={box().width - box().right} y={box().height - 6} text-anchor="end">{shortTime(box().to)}</text>
            <Show when={hoveredTime() !== null}>
              <>
                <line class="chart-crosshair" x1={x(hoveredTime() ?? box().from)} x2={x(hoveredTime() ?? box().from)} y1={box().top} y2={box().height - box().bottom} />
                <For each={props.series}>
                  {(series) => {
                    const value = () => nearest(series.points, hoveredTime() ?? box().from);
                    return value() === undefined ? null : <circle class={`chart-dot series-${series.color}`} cx={x(hoveredTime() ?? box().from)} cy={y(value() ?? 0)} r="3" />;
                  }}
                </For>
              </>
            </Show>
          </svg>
          <output class="chart-readout">{readout()}</output>
          <Show when={props.series.length > 1}>
            <ul class="chart-legend">
              <For each={props.series}>
                {(series) => (
                  <li>
                    <span class={`legend-swatch series-${series.color}`} />
                    <span>{series.label}</span>
                    <strong>{format(series.points.at(-1)?.value)}</strong>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      )}
    </Show>
  );
}
