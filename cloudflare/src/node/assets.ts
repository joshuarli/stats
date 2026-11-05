import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILT_ASSETS = fileURLToPath(new URL("../../.cloudflare/output/v0/workers/default/assets", import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

export type AssetReader = (request: Request) => Promise<Response>;

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function openAssets(directory: string): Promise<AssetReader> {
  const root = await realpath(directory);
  await stat(join(root, "index.html"));
  return async request => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return notFound();
    }
    if (path.includes("\0") || path.split("/").includes("..")) return notFound();
    const relative = path === "/" ? "/index.html" : path;
    let file: string;
    try {
      file = await realpath(join(root, relative));
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return notFound();
    } catch {
      return notFound();
    }
    const body = await readFile(file);
    return new Response(request.method === "HEAD" ? null : body, { headers: { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Content-Length": String(body.byteLength) } });
  };
}
