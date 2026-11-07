import type { JSX } from "@solidjs/web";

export interface MeterProps {
  readonly value: number | undefined;
  readonly warn: number;
  readonly bad: number;
  readonly max?: number | undefined;
  readonly class?: string | undefined;
}

export function Meter(props: MeterProps): JSX.Element {
  const max = () => props.max ?? 100;
  const clamped = () => {
    if (props.value === undefined || !Number.isFinite(props.value)) return 0;
    const ratio = (props.value / max()) * 100;
    return Math.min(100, Math.max(0, ratio));
  };

  const tone = () => {
    if (props.value === undefined) return "ui-meter-neutral";
    if (props.value >= props.bad) return "ui-meter-bad";
    if (props.value >= props.warn) return "ui-meter-warn";
    return "ui-meter-neutral";
  };

  const classes = () => ["ui-meter", props.class].filter(Boolean).join(" ");

  return (
    <div class={classes()} aria-hidden="true">
      <span class={`ui-meter-bar ${tone()}`} style={`width:${clamped().toFixed(1)}%`} />
    </div>
  );
}
