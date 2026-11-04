import { verifyAccess } from "./access";
import { bearerToken } from "./auth";
import { HISTORY_CONTENT_TYPE } from "./binary/history";
import { Installation } from "./deployments/installation";
import { collectDeployments } from "./deployments/collector";
import { parseProjects } from "./projects/config";
import { MAX_BODY_BYTES } from "./limits";
import { runCollector } from "./projects/collector";
import { markInvocation } from "./observe/mark";
import { reportError } from "./observe/report";
import { readLimitedText } from "./body";

export { Installation };

const SECURITY: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
};

const ASSET_CACHE = "private, max-age=31536000, immutable";

function secure(response: Response, cacheControl = "no-store"): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY)) headers.set(name, value);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function acceptedCoding(header: string | null): "br" | "gzip" | null {
  if (header === null) return null;
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [coding = "", ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith("q="));
    weights.set(coding.trim(), quality === undefined ? 1 : Number(quality.slice(2)));
  }
  const allows = (coding: string) => (weights.get(coding) ?? weights.get("*") ?? 0) > 0;
  return allows("br") ? "br" : allows("gzip") ? "gzip" : null;
}

function negotiated(request: Request, response: Response): Response {
  if (response.status !== 200 && response.status !== 304) return response;
  const headers = new Headers(response.headers);
  headers.append("Vary", "Accept-Encoding");
  const coding = response.status === 200 && headers.get("Content-Type") === HISTORY_CONTENT_TYPE ? acceptedCoding(request.headers.get("Accept-Encoding")) : null;
  if (coding !== null) headers.set("Content-Encoding", coding);
  return new Response(response.status === 304 ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}

function error(status: number, code: string, message: string): Response {
  return secure(Response.json({ error: { code, message } }, { status }));
}

function logIngestRejection(code: string): void {
  console.error(JSON.stringify({ event: "ingest_rejected", code }));
}

function internal(request: Request, path: string): Request {
  const url = new URL(request.url);
  return new Request(`https://installation${path}${url.search}`, request);
}

const OBSERVE_PREFIX = "/api/observe";
const MAX_OBSERVE_BODY_BYTES = 256;

async function observe(request: Request, env: Env, path: string): Promise<Response> {
  const access = await verifyAccess(request, env);
  if (!access.ok) return error(access.status, access.status === 503 ? "unavailable" : "unauthorized", access.message);
  const url = new URL(request.url);
  const target = `https://observe${path.slice(OBSERVE_PREFIX.length)}${url.search}`;
  if (request.method === "GET") return secure(await env.OBSERVE.fetch(target));
  if (request.method !== "POST") return error(405, "invalid_request", "method not allowed");
  if (request.headers.get("Origin") !== url.origin) return error(403, "forbidden", "cross-origin request");
  const body = await readLimitedText(request, MAX_OBSERVE_BODY_BYTES);
  if (body === null) return error(413, "too_large", "body exceeds the cap");
  return secure(await env.OBSERVE.fetch(target, { method: "POST", headers: { "Content-Type": request.headers.get("Content-Type") ?? "" }, body }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    markInvocation();
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return secure(Response.json({ ok: true, service: "stats" }));
    if (path.startsWith(`${OBSERVE_PREFIX}/`)) return observe(request, env, path);
    if (path === "/ingest/v1/batches") {
      if (request.method === "POST") {
        if (bearerToken(request.headers.get("authorization")) === null) {
          logIngestRejection("unauthorized");
          return error(401, "unauthorized", "a host bearer token is required");
        }
        const declared = request.headers.get("content-length");
        if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
          logIngestRejection("too_large");
          return error(413, "too_large", "batch exceeds the body cap");
        }
      }
      const stub = env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
      return secure(await stub.fetch(internal(request, "/ingest")));
    }
    const stub = env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
    if (path.startsWith("/api/v1/")) {
      const access = await verifyAccess(request, env);
      if (!access.ok) return error(access.status, access.status === 503 ? "unavailable" : "unauthorized", access.message);
      const suffix = path.slice("/api/v1".length);
      if (!/^\/(hosts|admin\/hosts|projects)(\/[A-Za-z0-9:_-]+)*$/u.test(suffix)) return error(404, "not_found", "unknown API route");
      const response = await stub.fetch(internal(request, suffix));
      return secure(suffix.endsWith("/history") ? negotiated(request, response) : response);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return error(405, "invalid_request", "method not allowed");
    const access = await verifyAccess(request, env);
    if (!access.ok) return error(access.status, access.status === 503 ? "unavailable" : "unauthorized", access.message);
    return secure(await env.ASSETS.fetch(request), path.startsWith("/assets/") ? ASSET_CACHE : "no-store");
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    markInvocation();
    const store = env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
    const [metrics] = await Promise.allSettled([
      runCollector({ analytics: env.ANALYTICS_SQL, store, projectsJson: env.PROJECTS, now: controller.scheduledTime, probeFetch: (url, init) => fetch(url, init) }),
      (async () => {
        try {
          await collectDeployments({
            projects: parseProjects(env.PROJECTS),
            ...(env.DEPLOYMENTS_ACCOUNT_ID === undefined ? {} : { account: env.DEPLOYMENTS_ACCOUNT_ID }),
            ...(env.DEPLOYMENTS_API_TOKEN === undefined ? {} : { token: env.DEPLOYMENTS_API_TOKEN }),
            now: controller.scheduledTime, store, fetch: (url, init) => fetch(url, init)
          });
        } catch (error) {
          reportError("deployments.collect", error);
          console.error(JSON.stringify({ event: "deployment_collection_failed" }));
        }
      })()
    ]);
    if (metrics.status === "rejected") throw metrics.reason;
  }
} satisfies ExportedHandler<Env>;
