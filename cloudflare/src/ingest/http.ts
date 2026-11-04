export const INGEST_MEDIA_TYPE = "application/vnd.stats.ingest.v2";
export const INGEST_PATH = "/ingest/v2/batches";
export const RETIRED_INGEST_PATHS: ReadonlySet<string> = new Set(["/ingest/v1/batches"]);

export function mediaProblem(headers: Headers): string | null {
  const type = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== INGEST_MEDIA_TYPE) return `${INGEST_MEDIA_TYPE} required`;
  const encoding = headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return "content encodings are not accepted";
  return null;
}
