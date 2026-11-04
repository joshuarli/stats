export const OBSERVED_SERVICES = ["stats", "usr-memories"] as const;

export type ObservedService = typeof OBSERVED_SERVICES[number];

export function isObservedService(name: string): name is ObservedService {
  return (OBSERVED_SERVICES as readonly string[]).includes(name);
}
