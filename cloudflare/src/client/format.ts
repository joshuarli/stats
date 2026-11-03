const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const unavailableText = "—";

export function isFiniteNumber(value: number | null | undefined): value is number {
  return value !== undefined && value !== null && Number.isFinite(value);
}

export function percent(value: number | undefined): string {
  return isFiniteNumber(value) ? `${number.format(value)}%` : unavailableText;
}

export function percentUsed(total: number | undefined, available: number | undefined): number | undefined {
  if (!isFiniteNumber(total) || !isFiniteNumber(available) || total <= 0) return undefined;
  return Math.min(100, Math.max(0, ((total - available) / total) * 100));
}

export function bytes(value: number | undefined): string {
  if (!isFiniteNumber(value)) return unavailableText;
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = value;
  let unit = 0;
  while (Math.abs(scaled) >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${number.format(scaled)} ${units[unit]}`;
}

export function rate(value: number | undefined): string {
  return isFiniteNumber(value) ? `${bytes(value)}/s` : unavailableText;
}

export function watts(value: number | undefined): string {
  return isFiniteNumber(value) ? `${number.format(value)} W` : unavailableText;
}

export function microseconds(value: number | undefined): string {
  if (!isFiniteNumber(value)) return unavailableText;
  if (value >= 1_000_000) return `${number.format(value / 1_000_000)} s`;
  if (value >= 1_000) return `${number.format(value / 1_000)} ms`;
  return `${number.format(value)} µs`;
}

export function count(value: number | undefined): string {
  return isFiniteNumber(value) ? number.format(value) : unavailableText;
}

export function dollars(value: number | undefined): string {
  if (!isFiniteNumber(value)) return unavailableText;
  if (value >= 0.01 || value === 0) return `$${value.toFixed(2)}`;
  return value < 0.0001 ? "<$0.0001" : `$${value.toPrecision(2)}`;
}

export function dollarsPrecise(value: number | undefined): string {
  if (!isFiniteNumber(value)) return unavailableText;
  if (value === 0) return "$0";
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 8 })}`;
}

export function milliseconds(value: number | undefined): string {
  return isFiniteNumber(value) ? `${count(value)} ms` : count(value);
}

export function minutes(value: number | undefined): string {
  return isFiniteNumber(value) ? `${count(value)} min` : count(value);
}

export function age(receivedAtMs: number | null | undefined, now = Date.now()): string {
  if (!isFiniteNumber(receivedAtMs)) return "never";
  const seconds = Math.max(0, Math.round((now - receivedAtMs) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function dateTime(ms: number | undefined): string {
  if (!isFiniteNumber(ms)) return unavailableText;
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

export function axisTime(ms: number, spanMs: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(spanMs <= 900_000 ? { second: "2-digit" as const } : {}), hourCycle: "h23" });
  return spanMs <= 129_600_000 ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function clock(ms: number | undefined): string {
  if (!isFiniteNumber(ms)) return unavailableText;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "The telemetry service could not be reached.";
}
