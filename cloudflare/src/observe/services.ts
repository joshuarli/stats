export const OBSERVED_SERVICES = ["stats", "usr-memories", "nanoshop-storied", "nanoshop-fieldhouse", "nanoshop-tidewater"] as const;

export type ObservedService = typeof OBSERVED_SERVICES[number];

export const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

export function isObservedService(name: string): name is ObservedService {
  return (OBSERVED_SERVICES as readonly string[]).includes(name);
}

export function localServices(value: string | undefined): readonly string[] {
  if (value === undefined || value === "") return [];
  return value.split(",").filter(name => SERVICE_NAME.test(name));
}

export interface ScriptNamed {
  readonly scriptName?: string | null;
}

export function groupByService<T extends ScriptNamed>(items: readonly T[], admit: (name: string) => boolean = isObservedService): { readonly byService: ReadonlyMap<string, readonly T[]>; readonly unknown: readonly T[] } {
  const byService = new Map<string, T[]>();
  const unknown: T[] = [];
  for (const item of items) {
    const service = item.scriptName ?? "";
    if (!admit(service)) { unknown.push(item); continue; }
    const group = byService.get(service);
    if (group === undefined) byService.set(service, [item]); else group.push(item);
  }
  return { byService, unknown };
}
