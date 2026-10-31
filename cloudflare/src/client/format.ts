const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function percent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unavailable" : `${number.format(value)}%`;
}

export function bytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = value;
  let unit = 0;
  while (Math.abs(scaled) >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${number.format(scaled)} ${units[unit]}`;
}

export function rate(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unavailable";
  return `${bytes(value)}/s`;
}

export function microseconds(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unavailable";
  if (value >= 1_000_000) return `${number.format(value / 1_000_000)} s`;
  if (value >= 1_000) return `${number.format(value / 1_000)} ms`;
  return `${number.format(value)} µs`;
}

export function count(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unavailable" : number.format(value);
}

export function uptime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "unavailable";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function age(receivedAtMs: number | null | undefined, now = Date.now()): string {
  if (receivedAtMs === null || receivedAtMs === undefined || !Number.isFinite(receivedAtMs)) return "never";
  const seconds = Math.max(0, Math.round((now - receivedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function timestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
