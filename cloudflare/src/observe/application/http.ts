import { APPLICATION_EVENTS_SERVICE, postApplicationEvent, type ApplicationEventSinkOptions } from "./sink.ts";

function requestOperation(request: Request): string {
  const path = new URL(request.url).pathname;
  const route = path === "/ingest/v2/batches" ? "host-ingest"
    : /^\/ingest\/services\/[^/]+\/deployments$/u.test(path) ? "deploy-mark"
    : /^\/api\/observe\/[a-z][a-z0-9-]{0,31}\/external(?:\/telemetry|\/operations)?$/u.test(path) ? "application-events"
    : path.startsWith("/api/observe/") ? "observe"
    : /^\/api\/v1\/admin(?:\/|$)/u.test(path) ? "admin"
    : /^\/api\/v1\/hosts(?:\/|$)/u.test(path) ? "hosts"
    : /^\/api\/v1\/services(?:\/|$)/u.test(path) ? "services"
    : /^\/api\/v1\/projects(?:\/|$)/u.test(path) ? "projects"
    : path === "/api/v1/capabilities" ? "capabilities"
    : path.startsWith("/api/") ? "api-other"
    : path === "/" || path === "/index.html" ? "dashboard"
    : path.startsWith("/assets/") ? "asset" : "other";
  const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method) ? request.method.toLowerCase() : "other";
  return `http.${method}.${route}`;
}

/** Records response-header wall time using bounded route labels, without URLs, bodies or credentials. */
export async function captureApplicationRequest(request: Request, run: () => Promise<Response>, options: ApplicationEventSinkOptions & { readonly monotonic: () => number }): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" || path.startsWith("/ingest/observe/")) return run();
  const started = options.monotonic();
  const atMs = options.now();
  let status = 500;
  try {
    const response = await run();
    status = response.status;
    return response;
  } finally {
    const durationMs = Math.min(86_400_000, Math.max(0, Math.round(options.monotonic() - started)));
    postApplicationEvent({ schemaVersion: 1, eventId: crypto.randomUUID(), atMs, operation: requestOperation(request), outcome: status >= 500 ? "error" : "ok", durationMs, work: { http_status: status }, release: options.release, service: options.service ?? APPLICATION_EVENTS_SERVICE }, options);
  }
}
