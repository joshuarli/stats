import { createMemo, createUniqueId } from "solid-js";
import type { JSX } from "@solidjs/web";

export interface SparkPoint {
  readonly atMs: number;
  readonly value?: number | undefined;
}

export function Sparkline(props: { readonly points: readonly SparkPoint[]; readonly label: string; readonly color?: number | undefined; readonly class?: string | undefined }): JSX.Element {
  const id = createUniqueId();
  const geometry = createMemo(() => {
    const points = props.points.filter((point): point is { readonly atMs: number; readonly value: number } => point.value !== undefined && Number.isFinite(point.value));
    if (points.length === 0) return null;
    const low = Math.min(...points.map(point => point.value));
    const high = Math.max(...points.map(point => point.value));
    const span = high - low || 1;
    const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${((index / Math.max(1, points.length - 1)) * 160).toFixed(2)},${(36 - ((point.value - low) / span) * 30).toFixed(2)}`).join(" ");
    const area = `${path} L160,40 L0,40 Z`;
    const last = points.at(-1);
    const lastY = last === undefined ? 36 : 36 - ((last.value - low) / span) * 30;
    return { path, area, lastY };
  });
  const color = props.color ?? 0;
  return (
    <svg class={`sparkline series-${color}${props.class === undefined ? "" : ` ${props.class}`}`} viewBox="0 0 160 40" role="img" aria-label={props.label} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" class="spark-fill-start" />
          <stop offset="100%" class="spark-fill-end" />
        </linearGradient>
      </defs>
      {geometry() === null ? null : (
        <>
          <path class="spark-area" d={geometry()!.area} fill={`url(#spark-${id})`} />
          <path class="spark-line" d={geometry()!.path} />
          <circle class="spark-dot" cx="160" cy={geometry()!.lastY.toFixed(2)} r="2.2" />
        </>
      )}
    </svg>
  );
}
