import { verifyAccess } from "./access";
import { bearerToken } from "./auth";
import { Installation } from "./installation";
import { MAX_BODY_BYTES } from "./limits";
import { runCollector } from "./projects/collector";

export { Installation };

const SECURITY: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "no-store"
};

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return secure(Response.json({ ok: true, service: "stats" }));
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
      if (!/^\/(hosts|admin\/hosts)(\/[A-Za-z0-9:_-]+)*$/u.test(suffix)) return error(404, "not_found", "unknown API route");
      return secure(await stub.fetch(internal(request, suffix)));
    }
    if (request.method !== "GET" && request.method !== "HEAD") return error(405, "invalid_request", "method not allowed");
    const access = await verifyAccess(request, env);
    if (!access.ok) return error(access.status, access.status === 503 ? "unavailable" : "unauthorized", access.message);
    return secure(await env.ASSETS.fetch(request));
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runCollector({
      analytics: env.ANALYTICS_SQL,
      store: env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")),
      projectsJson: env.PROJECTS,
      now: controller.scheduledTime
    });
  }
} satisfies ExportedHandler<Env>;
