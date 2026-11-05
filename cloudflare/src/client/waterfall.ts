export interface Axis {
  readonly from: number;
  readonly to: number;
  readonly format: (value: number) => string;
}

export interface Placement {
  readonly left: number;
  readonly width: number;
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

const TICK_TARGET = 4;
const MAX_TICKS = 40;

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const scaled = raw / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}

export function axisTicks(from: number, to: number): number[] {
  if (!(to > from)) return [from];
  const step = niceStep((to - from) / TICK_TARGET);
  const first = Math.ceil(from / step - 1e-9) + 0;
  const ticks: number[] = [];
  for (let index = first; ticks.length < MAX_TICKS && index * step <= to + step * 1e-9; index += 1) ticks.push(index * step);
  return ticks;
}

export function place(start: number, end: number, axis: Axis): Placement | null {
  const span = axis.to - axis.from;
  const left = ((start - axis.from) / span) * 100;
  const right = ((end - axis.from) / span) * 100;
  if (right < 0 || left > 100) return null;
  const visibleLeft = Math.max(0, left);
  return { left: visibleLeft, width: Math.max(0, Math.min(100, right) - visibleLeft), clippedStart: left < 0, clippedEnd: right > 100 };
}
