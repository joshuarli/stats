import type { JSX } from "@solidjs/web";
import { bytes, percent } from "../format";

export function CapacityBar(props: { readonly total: number; readonly available: number }): JSX.Element {
  const used = () => Math.max(0, props.total - props.available);
  const ratio = () => (props.total > 0 ? Math.min(100, Math.max(0, (used() / props.total) * 100)) : 0);
  const tone = () => (ratio() >= 90 ? "bad" : ratio() >= 75 ? "warn" : "ok");
  return (
    <div class="capacity">
      <div class="capacity-track" aria-hidden="true">
        <span class={`capacity-fill tone-${tone()}`} style={`width:${ratio().toFixed(1)}%`} />
      </div>
      <div class="capacity-label">
        <strong>{percent(ratio())}</strong>
        <span>{bytes(props.available)} free of {bytes(props.total)}</span>
      </div>
    </div>
  );
}
