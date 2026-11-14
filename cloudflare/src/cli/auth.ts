export const DEFAULT_ORIGIN = "https://stats.17166969.xyz";

export type Target = "orange" | "node";

export const TARGETS: readonly Target[] = ["orange", "node"];

export interface Deployment {
  readonly origin: string;
  readonly target: Target;
}

const DEPLOYMENTS: readonly Deployment[] = [
  { origin: DEFAULT_ORIGIN, target: "orange" }
];

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function isTailnetHost(hostname: string): boolean {
  return hostname.endsWith(".ts.net") || !hostname.includes(".") && !hostname.includes(":") && !isLoopback(hostname);
}

function parseTarget(value: string): Target {
  if (value === "orange" || value === "node") return value;
  throw new TypeError(`STATSCTL_TARGET must be orange or node, not ${value}`);
}

export function deploymentOf(origin: string, env: NodeJS.ProcessEnv): Deployment {
  const override = env["STATSCTL_TARGET"];
  if (override !== undefined && override !== "") return { origin, target: parseTarget(override) };
  const known = DEPLOYMENTS.find(deployment => deployment.origin === origin);
  if (known !== undefined) return known;
  const { hostname } = new URL(origin);
  if (isLoopback(hostname)) return { origin, target: "orange" };
  if (isTailnetHost(hostname)) return { origin, target: "node" };
  throw new TypeError(`${origin} is not a known Stats deployment; set STATSCTL_TARGET to orange or node`);
}

export function resolveOrigin(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const raw = flag ?? env["STATS_URL"] ?? DEFAULT_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`origin is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (isLoopback(url.hostname) || isTailnetHost(url.hostname)))) throw new TypeError("origin must be https, or http on loopback or the tailnet");
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new TypeError("origin must be a bare scheme, host, and port");
  return url.origin;
}
