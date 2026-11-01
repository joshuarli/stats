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

export function microseconds(value: number | undefined): string {
  if (!isFiniteNumber(value)) return unavailableText;
  if (value >= 1_000_000) return `${number.format(value / 1_000_000)} s`;
  if (value >= 1_000) return `${number.format(value / 1_000)} ms`;
  return `${number.format(value)} µs`;
}

export function count(value: number | undefined): string {
  return isFiniteNumber(value) ? number.format(value) : unavailableText;
}

export function uptime(ms: number | undefined): string {
  if (!isFiniteNumber(ms) || ms < 0) return unavailableText;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
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

export function timestamp(ms: number | undefined): string {
  if (!isFiniteNumber(ms)) return unavailableText;
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function clock(ms: number | undefined): string {
  if (!isFiniteNumber(ms)) return unavailableText;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortTime(ms: number | undefined): string {
  if (!isFiniteNumber(ms)) return unavailableText;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "The telemetry service could not be reached.";
}
