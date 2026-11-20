import { decodeBatch } from "./codec.ts";
import type { MetricStoreCore } from "./store-core.ts";

export async function handleMetricRequest(request: Request, store: MetricStoreCore): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/batches") {
    let batch;
    try {
      batch = decodeBatch(await request.text());
    } catch {
      return Response.json({ error: { code: "invalid_batch", message: "invalid batch" } }, { status: 400 });
    }
    try {
      return Response.json(store.ingest(batch, Date.now()));
    } catch (error) {
      if (error instanceof Error && (error.message === "capacity" || error.message === "rate_limit")) {
        return Response.json({ error: { code: error.message, message: error.message } }, { status: error.message === "capacity" ? 503 : 429 });
      }
      throw error;
    }
  }
  if (request.method === "GET" && url.pathname === "/sources") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    const release = url.searchParams.get("release");
    if (!url.searchParams.has("from") || !url.searchParams.has("to") || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || (release !== "runtime" && release !== "app")) {
      return Response.json({ error: { code: "invalid_request", message: "invalid window" } }, { status: 400 });
    }
    return Response.json({ sources: store.sources(from, to, release, Date.now()) });
  }
  return new Response(null, { status: 404 });
}
