export interface RuntimeCapabilities {
  readonly analyticsCollection: boolean;
  readonly cloudflareDeployments: boolean;
  readonly tailEvents: boolean;
  readonly applicationEvents: boolean;
}

export function decodeCapabilities(value: unknown): RuntimeCapabilities {
  if (typeof value !== "object" || value === null) throw new Error("invalid capabilities");
  const data = value as Record<string, unknown>;
  for (const key of ["analyticsCollection", "cloudflareDeployments", "tailEvents", "applicationEvents"]) {
    if (typeof data[key] !== "boolean") throw new Error("invalid capabilities");
  }
  return { analyticsCollection: data["analyticsCollection"] as boolean, cloudflareDeployments: data["cloudflareDeployments"] as boolean, tailEvents: data["tailEvents"] as boolean, applicationEvents: data["applicationEvents"] as boolean };
}
