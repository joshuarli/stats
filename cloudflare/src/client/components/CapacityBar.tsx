import type { JSX } from "@solidjs/web";
import { bytes, percent } from "../format";
import { healthOf, LIMITS } from "../health";

export function CapacityBar(props: { readonly total: number; readonly available: number }): JSX.Element {
  const used = () => Math.max(0, props.total - props.available);
  const ratio = () => (props.total > 0 ? Math.min(100, Math.max(0, (used() / props.total) * 100)) : 0);
  const tone = () => ({ critical: "bad", elevated: "warn", ok: "ok", unknown: "ok" })[healthOf(ratio(), LIMITS.filesystemUsedPercent) ?? "unknown"];
  return (
    <div class="capacity">
      <div class="capacity-track" aria-hidden="true">
        <span class={`capacity-fill tone-${tone()}`} style={`width:${ratio().toFixed(1)}%`} />
      </div>
      <div class="capacity-label">
        <strong>{percent(ratio())}</strong>
        <span title={`${bytes(props.available)} free of ${bytes(props.total)}`}>{bytes(props.available)} free</span>
      </div>
    </div>
  );
}
