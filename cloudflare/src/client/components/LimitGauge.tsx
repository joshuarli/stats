import type { JSX } from "@solidjs/web";
import type { Health, Limits } from "../health";

const SCALE_PAST_CRITICAL = 1.25;

export function LimitGauge(props: { readonly value: number | undefined; readonly limits: Limits; readonly health: Health | undefined }): JSX.Element {
  const top = () => props.limits.critical * SCALE_PAST_CRITICAL;
  const share = (value: number) => `${Math.min(100, Math.max(0, (value / top()) * 100)).toFixed(1)}%`;
  return (
    <span class="gauge" aria-hidden="true">
      <span class="gauge-zone gauge-elevated" style={`left:${share(props.limits.elevated)};width:${share(props.limits.critical - props.limits.elevated)}`} />
      <span class="gauge-zone gauge-critical" style={`left:${share(props.limits.critical)};right:0`} />
      {props.value === undefined ? null : <span class={`gauge-mark${props.health === undefined || props.health === "ok" ? "" : ` health-${props.health}`}`} style={`left:${share(props.value)}`} />}
    </span>
  );
}
