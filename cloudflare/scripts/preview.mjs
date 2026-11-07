import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_CONTENT_TYPE } from "../src/binary/history.ts";
import { encodeHistory } from "../test/support/history.ts";
import { buildScenario, scenarioComparison, scenarioStore as scenarioStoreFor } from "../test/ui/observe-scenario.ts";
import { handleApi } from "../src/observe/http/api.ts";

const cloudflare = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const assets = join(cloudflare, ".cloudflare", "output", "v0", "workers", "default", "assets");
const captures = join(cloudflare, "test", "ui", "captures");
const port = Number(process.env.PREVIEW_PORT ?? 4174);
const previewScale = process.env.PREVIEW_SCALE ?? "default";
if (!["default", "large"].includes(previewScale)) throw new Error("PREVIEW_SCALE must be default or large");
const hour = 3_600_000;
const day = 24 * hour;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const timeKeys = new Set(["atMs", "fromMs", "toMs", "lastReceivedAtMs", "createdAtMs", "reportedAtMs", "lastRunAtMs", "lastSuccessAtMs", "lastAttemptAtMs", "readyAtMs", "firstAtMs", "lastAtMs", "newestAtMs", "oldestAtMs"]);

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
      if (project.id !== capture.projectId || projectsById.has(project.id)) continue;
      projectsById.set(project.id, capture);
      projects.push(shift(project, shiftFor(capture)));
    }
  } catch {}
}

if (previewScale === "large") {
  const baseHosts = [...hosts];
  while (hosts.length < 24 && baseHosts.length > 0) {
    const idx = hosts.length + 1;
    const template = baseHosts[(idx - 1) % baseHosts.length];
    const baseCapture = hostsById.get(template.hostId);
    const syntheticHostId = `h_${idx.toString(16).padStart(32, "0")}`;
    hostsById.set(syntheticHostId, { ...baseCapture, hostId: syntheticHostId });
    hosts.push({
      ...template,
      hostId: syntheticHostId,
      name: `${template.name}-${idx}`
    });
  }
  const baseProjects = projects.filter(entry => projectsById.has(entry.id));
  while (projects.length < 12 && baseProjects.length > 0) {
    const idx = projects.length + 1;
    const template = baseProjects[(idx - 1) % baseProjects.length];
    const baseCapture = projectsById.get(template.id);
    const syntheticId = `${template.id}-${idx}`;
    projectsById.set(syntheticId, { ...baseCapture, projectId: syntheticId });
    projects.push({
      ...template,
      id: syntheticId,
      name: `${template.name} ${idx}`,
      worker: template.worker === "" ? "" : `${template.worker}-${idx}`
    });
  }
}

const services = hosts.length === 0 ? [] : [{
  name: "web",
  hostIds: [hosts[0].hostId],
  healthUrl: "https://web.ts.net/health",
  unit: "web.service",
  createdAtMs: hosts[0].createdAtMs
}];

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

function sliceHistory(body, fromMs, toMs) {
  const { range: _range, ...rest } = body;
  if (Array.isArray(body.runs)) return { ...rest, fromMs, toMs, runs: body.runs.filter(run => run.atMs >= fromMs && run.atMs <= toMs) };
  const length = body.series[0]?.values.length ?? 0;
  const first = Math.max(0, Math.ceil((fromMs - body.fromMs) / body.stepMs));
  const last = Math.min(length - 1, Math.floor((toMs - body.fromMs) / body.stepMs));
  return { ...rest, fromMs: body.fromMs + first * body.stepMs, toMs, series: body.series.map(entry => ({ ...entry, values: entry.values.slice(first, last + 1) })) };
}

async function history(capture, kind, url) {
  const withIdentity = body => {
    if (body === undefined) return undefined;
    if (typeof body.hostId === "string" && typeof capture.hostId === "string") return { ...body, hostId: capture.hostId };
    if (typeof body.projectId === "string" && typeof capture.projectId === "string") return { ...body, projectId: capture.projectId };
    return body;
  };
  const range = url.searchParams.get("range");
  if (range !== null) {
    const chosen = await captureFile(capture, `${kind}-${range}.json`) ?? await closest(capture, kind, range);
    return chosen === undefined ? undefined : withIdentity(shift(chosen, shiftFor(capture)));
  }
  const fromMs = Number(url.searchParams.get("from"));
  const toMs = Number(url.searchParams.get("to"));
  for (const candidate of ["1h", "6h", "24h", "7d", "30d"]) {
    const found = await captureFile(capture, `${kind}-${candidate}.json`);
    if (found === undefined) continue;
    const shifted = shift(found, shiftFor(capture));
    if (shifted.fromMs <= fromMs) return withIdentity(sliceHistory(shifted, fromMs, toMs));
  }
  const reference = await closest(capture, kind, rangeForSpan(toMs - fromMs));
  return reference === undefined ? undefined : withIdentity(emptyHistory(reference, fromMs, toMs));
}

function frame(request, response, body) {
  const encoded = encodeHistory(body);
  const etag = `W/"${createHash("sha256").update(encoded).digest("hex").slice(0, 16)}"`;
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { ETag: etag, "Cache-Control": "no-store", Vary: "Accept-Encoding" });
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": HISTORY_CONTENT_TYPE, ETag: etag, "Cache-Control": "no-store", Vary: "Accept-Encoding" });
  response.end(encoded);
}

function json(response, body, status = 200) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(encoded);
}

const observeSource = process.env.PREVIEW_OBSERVE ?? "scenario";
if (!["scenario", "capture"].includes(observeSource)) throw new Error("PREVIEW_OBSERVE must be scenario or capture");
const scenario = observeSource === "scenario" ? await buildScenario(previewNow) : undefined;
const scenarioStore = scenario === undefined ? undefined : scenarioStoreFor(scenario, previewNow);

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function observe(request, response, servicePath, url) {
  const [, service, route] = /^([a-z][a-z0-9-]{0,31})\/(.*)$/u.exec(servicePath) ?? [];
  if (service !== "stats") return json(response, { error: { code: "not_found", message: "preview serves only the stats service" } }, 404);
  if (scenarioStore !== undefined) {
    const body = request.method === "POST" ? await readBody(request) : undefined;
    const headers = { "content-type": request.headers["content-type"] ?? "" };
    const answer = await handleApi(new Request(`https://observe/${route}${url.search}`, { method: request.method, headers, body }), `/${route}`, scenarioStore, service);
    const payload = Buffer.from(await answer.arrayBuffer());
    response.writeHead(answer.status, { "Content-Type": answer.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" });
    return response.end(payload);
  }
  const capture = projectsById.get("stats");
  const missing = () => json(response, { error: { code: "not_found", message: "no observe capture for that request" } }, 404);
  if (capture === undefined) return missing();
  if (request.method === "POST" && /^issues\/[0-9a-f]{64}\/state$/u.test(route)) return response.writeHead(204).end();
  const trace = /^traces\/([0-9a-f]{32})$/u.exec(route);
  const occurrences = /^issues\/([0-9a-f]{64})\/occurrences$/u.exec(route);
  const file = route === "health" ? "observe-health.json" : route === "issues" ? "observe-issues.json" : route === "traces" ? "observe-traces.json"
    : trace !== null ? `observe-trace-${trace[1]}.json` : occurrences !== null ? `observe-occurrences-${occurrences[1]}.json` : undefined;
  const body = file === undefined ? undefined : await captureFile(capture, file);
  if (body === undefined) return missing();
  const shifted = shift(body, shiftFor(capture));
  if (route === "traces") {
    const failed = url.searchParams.get("failed");
    const label = url.searchParams.get("label");
    return json(response, { ...shifted, items: shifted.items.filter(item => (failed === null || String(item.failed) === failed) && (label === null || item.label === label)) });
  }
  if (route === "issues") return json(response, { ...shifted, items: shifted.items.filter(item => item.state === (url.searchParams.get("state") ?? "open")) });
  return json(response, shifted);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    if (path === "/api/v1/hosts") return json(response, { hosts });
    if (path === "/api/v1/projects") return json(response, projects);
    if (path === "/api/v1/services") return json(response, { services });
    const serviceDeploys = /^\/api\/v1\/services\/([^/]+)\/deployments$/u.exec(path);
    if (serviceDeploys !== null) {
      const svcName = decodeURIComponent(serviceDeploys[1]);
      if (!services.some(entry => entry.name === svcName)) return json(response, { error: { code: "not_found", message: "unknown service" } }, 404);
      return json(response, { projectId: svcName, worker: svcName, enabled: true, sync: null, versions: [], deployments: [], markers: [] });
    }
    const deployed = /^\/api\/v1\/projects\/([^/]+)\/deployments(?:\/([^/]+)\/comparison)?$/u.exec(path);
    if (deployed !== null && scenario !== undefined && deployed[1] === "stats") {
      if (deployed[2] === undefined) return json(response, scenario.deployments);
      const window = url.searchParams.get("window") ?? "1h";
      const body = ["1h", "6h", "24h"].includes(window) ? scenarioComparison(scenario, deployed[2], window) : null;
      return body === null ? json(response, { error: { code: "not_found", message: "no comparison in the scenario" } }, 404) : json(response, body);
    }
    if (deployed !== null) {
      const targetProjectId = decodeURIComponent(deployed[1]);
      const capture = projectsById.get(targetProjectId);
      const window = url.searchParams.get("window") ?? "1h";
      const file = deployed[2] === undefined ? "deployments.json" : `comparison-${window}.json`;
      const body = capture === undefined || !["1h", "6h", "24h"].includes(window) ? undefined : await captureFile(capture, file);
      if (body === undefined) return json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404);
      return json(response, shift(deployed[2] === undefined ? { ...body, projectId: targetProjectId } : { ...body, deploymentId: deployed[2] }, shiftFor(capture)));
    }
    if (path.startsWith("/api/observe/")) return observe(request, response, path.slice("/api/observe/".length), url);
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
        return frame(request, response, { hostId: capture.hostId, histories });
      }
      const body = await history(capture, url.searchParams.get("kind") ?? "summary", url);
      return body === undefined ? json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404) : frame(request, response, body);
    }
    const project = /^\/api\/v1\/projects\/([^/]+)\/history$/u.exec(path);
    if (project !== null) {
      const targetProjectId = decodeURIComponent(project[1]);
      const capture = projectsById.get(targetProjectId);
      if (capture === undefined) return json(response, { error: { code: "not_found", message: "unknown project" } }, 404);
      const kinds = url.searchParams.get("kinds");
      if (kinds !== null) {
        const histories = {};
        for (const kind of kinds.split(",")) {
          const body = await history(capture, kind, url);
          if (body !== undefined) histories[kind] = body;
          else if (kind !== "worker" && kind !== "collector") {
            const base = await history(capture, "worker", url);
            if (base === undefined) return json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404);
            histories[kind] = emptyHistory({ ...base, kind, projectId: targetProjectId }, base.fromMs, base.toMs);
          } else return json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404);
        }
        return frame(request, response, { projectId: targetProjectId, histories });
      }
      const body = await history(capture, url.searchParams.get("kind") ?? "worker", url);
      return body === undefined ? json(response, { error: { code: "not_found", message: "no capture for that request" } }, 404) : frame(request, response, body);
    }

    const relative = path === "/" ? "/index.html" : path;
    const file = normalize(join(assets, relative));
    if (file !== assets && !file.startsWith(assets + sep)) return response.writeHead(403).end();
    let body = await readFile(file);
    if (relative === "/index.html") body = Buffer.from(body.toString("utf8").replace("<head>", `<head><script>Date.now = () => ${previewNow};</script>`));
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  const firstHost = hosts.find(host => capturesFound.some(capture => capture.hostId === host.hostId)) ?? hosts[0];
  console.log(`preview on http://127.0.0.1:${port}/ (${capturesFound.map(capture => capture.name).join(", ")} at ${new Date(previewNow).toISOString()})`);
  console.log(scenario === undefined ? "observe: production capture" : `observe: fault-injection scenario, ${scenario.invocations} invocations (PREVIEW_OBSERVE=capture for the production capture)`);
  if (firstHost !== undefined) console.log(`host:    http://127.0.0.1:${port}/#/host/${firstHost.hostId}`);
  if (projects[0] !== undefined) console.log(`project: http://127.0.0.1:${port}/#/project/${projects[0].id}`);
});
