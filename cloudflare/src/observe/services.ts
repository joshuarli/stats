export const OBSERVED_SERVICES = ["stats", "usr-memories", "nanoshop-storied", "nanoshop-fieldhouse", "nanoshop-tidewater"] as const;

export type ObservedService = typeof OBSERVED_SERVICES[number];

export function isObservedService(name: string): name is ObservedService {
  return (OBSERVED_SERVICES as readonly string[]).includes(name);
}

export interface ScriptNamed {
  readonly scriptName?: string | null;
}

export function groupByService<T extends ScriptNamed>(items: readonly T[]): { readonly byService: ReadonlyMap<ObservedService, readonly T[]>; readonly unknown: readonly T[] } {
  const byService = new Map<ObservedService, T[]>();
  const unknown: T[] = [];
  for (const item of items) {
    const service = item.scriptName ?? "";
    if (!isObservedService(service)) { unknown.push(item); continue; }
    const group = byService.get(service);
    if (group === undefined) byService.set(service, [item]); else group.push(item);
  }
  return { byService, unknown };
}
