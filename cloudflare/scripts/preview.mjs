import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_CONTENT_TYPE } from "../src/binary/history.ts";
import { encodeHistory } from "../test/support/history.ts";

const cloudflare = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const assets = join(cloudflare, ".cloudflare", "output", "v0", "workers", "default", "assets");
const captures = join(cloudflare, "test", "ui", "captures");
const port = Number(process.env.PREVIEW_PORT ?? 4174);
const hour = 3_600_000;
const day = 24 * hour;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const timeKeys = new Set(["atMs", "fromMs", "toMs", "lastReceivedAtMs", "createdAtMs", "reportedAtMs", "lastRunAtMs", "lastSuccessAtMs", "lastAttemptAtMs", "readyAtMs"]);

function shift(value, delta) {
  if (Array.isArray(value)) return value.map(entry => shift(entry, delta));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, timeKeys.has(key) && typeof entry === "number" ? entry + delta : shift(entry, delta)]));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadCaptures() {
  const found = [];
  for (const entry of await readdir(captures, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = await readJson(join(captures, entry.name, "capture.json"));
      found.push({ name: entry.name, directory: join(captures, entry.name), capturedAtMs: meta.capturedAtMs, hostId: meta.hostId, projectId: meta.projectId });
    } catch {
      continue;
    }
  }
  if (found.length === 0) throw new Error(`no captures under ${captures}; run cloudflare/scripts/capture-project.sh first`);
  return found;
}

const capturesFound = await loadCaptures();
const previewNow = Math.max(...capturesFound.map(capture => capture.capturedAtMs));
const shiftFor = capture => previewNow - capture.capturedAtMs;

const hostsById = new Map();
const projectsById = new Map();
const hosts = [];
const projects = [];
for (const capture of capturesFound) {
  try {
    for (const host of (await readJson(join(capture.directory, "hosts.json"))).hosts) {
      if (host.hostId !== capture.hostId || hostsById.has(host.hostId)) continue;
      hostsById.set(host.hostId, capture);
      hosts.push(shift(host, shiftFor(capture)));
    }
  } catch {}
  try {
    for (const project of await readJson(join(capture.directory, "projects.json"))) {
      if (projectsById.has(project.id)) continue;
      projectsById.set(project.id, capture);
      projects.push(shift(project, shiftFor(capture)));
    }
  } catch {}
}

async function captureFile(capture, name) {
  try {
    return await readJson(join(capture.directory, name));
  } catch {
    return undefined;
  }
}

async function closest(capture, kind, range) {
  const wanted = await captureFile(capture, `${kind}-${range}.json`);
  if (wanted !== undefined) return wanted;
  for (const fallback of ["1h", "6h", "24h", "7d", "30d"]) {
    const found = await captureFile(capture, `${kind}-${fallback}.json`);
    if (found !== undefined) return found;
  }
  return undefined;
}

function rangeForSpan(span) {
  if (span <= hour) return "1h";
  if (span <= 6 * hour) return "6h";
  if (span <= day) return "24h";
  if (span <= 7 * day) return "7d";
  return "30d";
}

function emptyHistory(base, fromMs, toMs) {
  return {
    ...base,
    fromMs,
    toMs,
    ...(Array.isArray(base.points) ? { points: [] } : {}),
    ...(Array.isArray(base.series) ? { series: [] } : {}),
    ...(Array.isArray(base.runs) ? { runs: [] } : {})
  };
}

async function history(capture, kind, url) {
  const range = url.searchParams.get("range");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const fromMs = from === null ? undefined : Number(from);
  const toMs = to === null ? undefined : Number(to);
  if (fromMs !== undefined && toMs !== undefined && toMs < previewNow - day / 2) {
    const reference = await captureFile(capture, `${kind}-1h.json`) ?? await closest(capture, kind, rangeForSpan(toMs - fromMs));
    return reference === undefined ? undefined : emptyHistory(reference, fromMs, toMs);
  }
  const chosen = range !== null
    ? await captureFile(capture, `${kind}-${range}.json`) ?? await closest(capture, kind, range)
    : await closest(capture, kind, fromMs !== undefined && toMs !== undefined ? rangeForSpan(toMs - fromMs) : "1h");
  return chosen === undefined ? undefined : shift(chosen, shiftFor(capture));
}

function frame(response, body) {
  response.writeHead(200, { "Content-Type": HISTORY_CONTENT_TYPE, "Cache-Control": "no-store" });
  response.end(encodeHistory(body));
}

function json(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    if (path === "/api/v1/hosts") return json(response, { hosts });
    if (path === "/api/v1/projects") return json(response, projects);
    const deployed = /^\/api\/v1\/projects\/([^/]+)\/deployments(?:\/([^/]+)\/comparison)?$/u.exec(path);
    if (deployed !== null) {
      const capture = projectsById.get(deployed[1]);
      const window = url.searchParams.get("window") ?? "1h";
      const file = deployed[2] === undefined ? "deployments.json" : `comparison-${window}.json`;
      const body = capture === undefined || !["1h", "6h", "24h"].includes(window) ? undefined : await captureFile(capture, file);
      if (body === undefined) return json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404);
      return json(response, shift(deployed[2] === undefined ? body : { ...body, deploymentId: deployed[2] }, shiftFor(capture)));
    }
    const host = /^\/api\/v1\/hosts\/([^/]+)\/(system|history)$/u.exec(path);
    if (host !== null) {
      const capture = hostsById.get(decodeURIComponent(host[1]));
      if (capture === undefined) return json(response, { error: { code: "not_found", message: "unknown host" } }, 404);
      if (host[2] === "system") {
        const system = await captureFile(capture, "system.json");
        return system === undefined
          ? json(response, { error: { code: "not_found", message: "no system details for host" } }, 404)
          : json(response, shift(system, shiftFor(capture)));
      }
      const kinds = url.searchParams.get("kinds");
      if (kinds !== null) {
        const histories = {};
        for (const kind of kinds.split(",")) {
          const body = await history(capture, kind, url);
          if (body === undefined) return json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404);
          histories[kind] = body;
        }
        return frame(response, { hostId: capture.hostId, histories });
      }
      const body = await history(capture, url.searchParams.get("kind") ?? "summary", url);
      return body === undefined ? json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404) : frame(response, body);
    }
    const project = /^\/api\/v1\/projects\/([^/]+)\/history$/u.exec(path);
    if (project !== null) {
      const capture = projectsById.get(decodeURIComponent(project[1]));
      if (capture === undefined) return json(response, { error: { code: "not_found", message: "unknown project" } }, 404);
      const kinds = url.searchParams.get("kinds");
      if (kinds !== null) {
        const histories = {};
        for (const kind of kinds.split(",")) {
          const body = await history(capture, kind, url);
          if (body === undefined) return json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404);
          histories[kind] = body;
        }
        return frame(response, { projectId: decodeURIComponent(project[1]), histories });
      }
      const body = await history(capture, url.searchParams.get("kind") ?? "worker", url);
      return body === undefined ? json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404) : frame(response, body);
    }

    const relative = path === "/" ? "/index.html" : path;
    const file = normalize(join(assets, relative));
    if (file !== assets && !file.startsWith(assets + sep)) return response.writeHead(403).end();
    let body = await readFile(file);
    if (relative === "/index.html") body = Buffer.from(body.toString("utf8").replace("<head>", `<head><script>Date.now = () => ${previewNow};</script>`));
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, "127.0.0.1", () => {
  const firstHost = hosts.find(host => capturesFound.some(capture => capture.hostId === host.hostId)) ?? hosts[0];
  console.log(`preview on http://127.0.0.1:${port}/ (${capturesFound.map(capture => capture.name).join(", ")} at ${new Date(previewNow).toISOString()})`);
  if (firstHost !== undefined) console.log(`host:    http://127.0.0.1:${port}/#/host/${firstHost.hostId}`);
  if (projects[0] !== undefined) console.log(`project: http://127.0.0.1:${port}/#/project/${projects[0].id}`);
});
