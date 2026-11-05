export const HOUR_MS = 3_600_000;
export const FIRST_AT_MS = Math.floor(1_793_510_400_000 / HOUR_MS) * HOUR_MS - 10 * 60_000;
export const SAMPLE_STEP_MS = 15_000;

type Field = Record<string, string>;

function bump(entry: Field, step: number, keys: readonly string[]): Field {
  const next = { ...entry };
  for (const key of keys) next[key] = (BigInt(entry[key]!) + BigInt(step)).toString();
  return next;
}

export function sampleAt(template: Readonly<Record<string, unknown>>, index: number): Record<string, unknown> {
  const cpuTemplate = template["cpu"] as Field;
  const cpu = { ...cpuTemplate, user: bump(cpuTemplate, index * 1000, ["user"])["user"]!, system: bump(cpuTemplate, index * 1000, ["system"])["system"]!, idle: bump(cpuTemplate, index * 2000, ["idle"])["idle"]!, total: bump(cpuTemplate, index * 4000, ["total"])["total"]! };
  const nets = (template["nets"] as Field[]).map(net => bump(net, index * 1500, ["rxBytes", "txBytes"]));
  return {
    ...template,
    seq: String(900_000 + index * 15),
    monoMs: String(900_000_000 + index * SAMPLE_STEP_MS),
    atMs: String(FIRST_AT_MS + index * SAMPLE_STEP_MS),
    cpu,
    nets
  };
}

export function arrivalMs(lastIndex: number): number {
  return FIRST_AT_MS + lastIndex * SAMPLE_STEP_MS + 1000;
}
