import { createMemo, createUniqueId } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Health } from "../health";
import type { Cells } from "../columns";
import type { VizColor } from "./TimeChart";

export function Sparkline(props: { readonly values: Cells; readonly label: string; readonly color?: number | undefined; readonly hue?: VizColor | undefined; readonly zeroBased?: boolean | undefined; readonly health?: Health | undefined; readonly class?: string | undefined }): JSX.Element {
  const id = createUniqueId();
  const geometry = createMemo(() => {
    const values = props.values.filter((value): value is number => value !== null && Number.isFinite(value));
    if (values.length === 0) return null;
    const low = props.zeroBased === true ? Math.min(0, ...values) : Math.min(...values);
    const high = Math.max(...values);
    const span = high - low || 1;
    const path = values.map((value, index) => `${index === 0 ? "M" : "L"}${((index / Math.max(1, values.length - 1)) * 160).toFixed(2)},${(36 - ((value - low) / span) * 30).toFixed(2)}`).join(" ");
    const area = `${path} L160,40 L0,40 Z`;
    const last = values.at(-1);
    const lastY = last === undefined ? 36 : 36 - ((last - low) / span) * 30;
    return { path, area, lastY };
  });
  const color = props.color ?? 0;
  return (
    <svg class={`sparkline ${props.hue === undefined ? `series-${color}` : `viz-${props.hue}`}${props.health === undefined || props.health === "ok" ? "" : ` health-${props.health}`}${props.class === undefined ? "" : ` ${props.class}`}`} viewBox="0 0 160 40" role="img" aria-label={props.label} preserveAspectRatio="none">
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
