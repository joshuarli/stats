import { Installation } from "./installation";

export { Installation };

function internal(request: Request, path: string): Request {
  const url = new URL(request.url);
  return new Request(`https://installation${path}${url.search}`, request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return Response.json({ ok: true, service: "niceforge-telemetry" });
    const stub = env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
    if (path === "/ingest/v1/batches") return stub.fetch(internal(request, "/ingest"));
    if (path.startsWith("/api/v1/")) return new Response("Unauthorized", { status: 401 });
    if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
