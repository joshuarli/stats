#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const USAGE = "usage: node cloudflare/scripts/bench-bundle.mjs [--assets DIR] [--json] [--out PATH] [--compare PATH]";
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value\n${USAGE}`);
  return value;
}

if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultAssetsDir = resolve(scriptDir, "..", ".cloudflare", "output", "v0", "workers", "default", "assets");
const assetsRoot = resolve(option("--assets", defaultAssetsDir));
const outPath = option("--out", null);
const comparePath = option("--compare", null);

const indexHtmlPath = join(assetsRoot, "index.html");
const chunksDir = join(assetsRoot, "assets");
const indexHtml = readFileSync(indexHtmlPath, "utf8");

const entryFiles = new Set(
  [...indexHtml.matchAll(/<script\b[^>]*\bsrc="\/assets\/([^"]+)"/gu)].map(match => match[1])
);
const modulepreloadFiles = new Set(
  [...indexHtml.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/assets\/([^"]+)"/gu)].map(match => match[1])
);
const stylesheetFiles = new Set(
  [...indexHtml.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\/assets\/([^"]+)"/gu)].map(match => match[1])
);

function compressSizes(buffer) {
  return {
    raw: buffer.byteLength,
    gzip: gzipSync(buffer, { level: 9 }).byteLength,
    gzip6: gzipSync(buffer, { level: 6 }).byteLength,
    brotli: brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
    brotli5: brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).byteLength
  };
}

function stemOf(filename) {
  return filename.replace(/-[A-Za-z0-9_-]{8}\.(?:js|css)$/u, "");
}

function detectMarkers(text) {
  const markers = [];
  if (text.includes("uPlot") || text.includes("chart-plot")) markers.push("uplot");
  if (text.includes("issue-list") || text.includes("No open issues in the last 7 days")) markers.push("observe-issues");
  if (text.includes("route-explorer") || text.includes("heatmap-plot")) markers.push("observe-requests");
  if (text.includes("skeleton-signals") || text.includes("Rows read per run")) markers.push("project-signals");
  if (text.includes("projects-trends")) markers.push("projects-trends");
  return markers;
}

function parsePreloadMap(text) {
  const tableMatch = text.match(/m\.f=\[(.*?)\]/u);
  if (!tableMatch) return new Map();
  let table = [];
  try {
    table = JSON.parse(`[${tableMatch[1]}]`).map(item => String(item).replace(/^assets\//u, ""));
  } catch {
    return new Map();
  }
  const map = new Map();
  const pattern = /import\(["\x60]\.\/([^"\x60]+\.js)["\x60]\)(?:(?!__vite__mapDeps).){0,120}?__vite__mapDeps\(\[([0-9,]*)\]\)/gu;
  for (const match of text.matchAll(pattern)) {
    const target = match[1];
    const indices = match[2].length === 0 ? [] : match[2].split(",").map(Number);
    map.set(target, indices.map(index => table[index]).filter(Boolean));
  }
  return map;
}

const allFiles = readdirSync(chunksDir)
  .filter(name => name.endsWith(".js") || name.endsWith(".css"))
  .sort();

const chunkByFile = new Map();
for (const file of allFiles) {
  const fullPath = join(chunksDir, file);
  const buffer = readFileSync(fullPath);
  const ext = extname(file);
  const type = ext === ".js" ? "js" : "css";
  const sizes = compressSizes(buffer);
  const role = entryFiles.has(file)
    ? "entry"
    : modulepreloadFiles.has(file)
      ? "modulepreload"
      : stylesheetFiles.has(file)
        ? "stylesheet"
        : "lazy";
  if (type === "js") {
    const text = buffer.toString("utf8");
    const staticImports = [...new Set([...text.matchAll(/(?:from|import)\s*["\x60]\.\/([^"\x60]+\.js)["\x60]/gu)].map(match => match[1]))];
    const dynamicImports = [...new Set([...text.matchAll(/import\(["\x60]\.\/([^"\x60]+\.js)["\x60]\)/gu)].map(match => match[1]))];
    const preloadDeps = parsePreloadMap(text);
    const markers = detectMarkers(text);
    chunkByFile.set(file, {
      file,
      stem: stemOf(file),
      type,
      role,
      ...sizes,
      staticImports,
      dynamicImports,
      preloadDeps: Object.fromEntries(preloadDeps),
      markers
    });
  } else {
    chunkByFile.set(file, {
      file,
      stem: stemOf(file),
      type,
      role,
      ...sizes,
      staticImports: [],
      dynamicImports: [],
      preloadDeps: {},
      markers: []
    });
  }
}

function sumBytes(files) {
  let raw = 0;
  let gzip = 0;
  let gzip6 = 0;
  let brotli = 0;
  let brotli5 = 0;
  for (const file of files) {
    const chunk = chunkByFile.get(file);
    if (!chunk) continue;
    raw += chunk.raw;
    gzip += chunk.gzip;
    gzip6 += chunk.gzip6;
    brotli += chunk.brotli;
    brotli5 += chunk.brotli5;
  }
  return { raw, gzip, gzip6, brotli, brotli5 };
}

function findJsByStem(stem) {
  for (const chunk of chunkByFile.values()) {
    if (chunk.type === "js" && chunk.stem === stem) return chunk.file;
  }
  return null;
}

function resolveRouteGraph(seedJsFiles, includeDynamic = false) {
  const jsSeen = new Set();
  const cssSeen = new Set(stylesheetFiles);
  for (const parent of chunkByFile.values()) {
    if (parent.type !== "js") continue;
    for (const seed of seedJsFiles) {
      const deps = parent.preloadDeps[seed];
      if (!deps) continue;
      for (const dep of deps) {
        if (dep.endsWith(".css") && chunkByFile.has(dep)) cssSeen.add(dep);
      }
    }
  }
  const queue = [...seedJsFiles.filter(Boolean)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || jsSeen.has(current) || !chunkByFile.has(current)) continue;
    const chunk = chunkByFile.get(current);
    if (chunk.type !== "js") continue;
    jsSeen.add(current);
    for (const next of chunk.staticImports) {
      if (!jsSeen.has(next)) queue.push(next);
    }
    if (includeDynamic && chunk.role !== "entry") {
      for (const next of chunk.dynamicImports) {
        if (!jsSeen.has(next)) queue.push(next);
        const deps = chunk.preloadDeps[next] ?? [];
        for (const dep of deps) {
          if (dep.endsWith(".css") && chunkByFile.has(dep)) cssSeen.add(dep);
          else if (dep.endsWith(".js") && !jsSeen.has(dep)) queue.push(dep);
        }
      }
      for (const parent of chunkByFile.values()) {
        if (parent.type !== "js") continue;
        for (const next of chunk.dynamicImports) {
          const deps = parent.preloadDeps[next] ?? [];
          for (const dep of deps) {
            if (dep.endsWith(".css") && chunkByFile.has(dep)) cssSeen.add(dep);
            else if (dep.endsWith(".js") && !jsSeen.has(dep)) queue.push(dep);
          }
        }
      }
    }
  }
  const jsChunks = [...jsSeen];
  const cssChunks = [...cssSeen];
  const markers = [...new Set(jsChunks.flatMap(file => chunkByFile.get(file)?.markers ?? []))];
  return {
    jsChunks,
    jsStems: jsChunks.map(file => chunkByFile.get(file)?.stem ?? file),
    cssChunks,
    cssStems: cssChunks.map(file => chunkByFile.get(file)?.stem ?? file),
    js: sumBytes(jsChunks),
    css: sumBytes(cssChunks),
    markers
  };
}

const fleetSeeds = [...entryFiles, ...modulepreloadFiles];
const routeSpecs = [
  ["fleet", fleetSeeds, false],
  ["host", [...fleetSeeds, findJsByStem("HostPage")], false],
  ["projects", [...fleetSeeds, findJsByStem("ProjectsPage")], false],
  ["projectsExpanded", [...fleetSeeds, findJsByStem("ProjectsPage")], true],
  ["project", [...fleetSeeds, findJsByStem("ProjectPage")], false],
  ["projectOpen", [...fleetSeeds, findJsByStem("ProjectPage")], true],
  ["services", [...fleetSeeds, findJsByStem("ServicesPage")], false],
  ["service", [...fleetSeeds, findJsByStem("ServicePage")], false]
];

const routes = Object.fromEntries(
  routeSpecs.map(([name, seeds, includeDynamic]) => [name, resolveRouteGraph(seeds, includeDynamic)])
);

const jsFiles = allFiles.filter(file => file.endsWith(".js"));
const cssFiles = allFiles.filter(file => file.endsWith(".css"));
const totals = {
  js: sumBytes(jsFiles),
  css: sumBytes(cssFiles),
  all: sumBytes(allFiles)
};

const markerOwners = {};
for (const chunk of chunkByFile.values()) {
  for (const marker of chunk.markers) {
    markerOwners[marker] ??= [];
    markerOwners[marker].push(chunk.file);
  }
}
const duplicatedMarkers = Object.fromEntries(
  Object.entries(markerOwners).filter(([marker, owners]) => marker !== "observe-core" && owners.length > 1)
);

const report = {
  generatedAt: new Date().toISOString(),
  assetsRoot,
  compressionNote: "gzip is level 9 and brotli is quality 11; gzip6 and brotli5 are also recorded. Worker and Node server bundles are excluded.",
  totals,
  chunks: [...chunkByFile.values()],
  markerOwners,
  duplicatedMarkers,
  routes
};

if (comparePath !== null) {
  const baseline = JSON.parse(readFileSync(resolve(comparePath), "utf8"));
  const routeComparisons = {};
  const gates = [];
  const limits = {
    projects: 0.80,
    project: 0.85,
    fleet: 1.05,
    host: 1.05,
    services: 1.05,
    service: 1.05,
    projectOpen: 1.05
  };
  for (const [routeName, maxRatio] of Object.entries(limits)) {
    const baseRoute = baseline.routes?.[routeName] ?? (routeName === "projectOpen" ? baseline.routes?.project : undefined);
    const currentRoute = routes[routeName];
    if (!baseRoute || !currentRoute) continue;
    const baseGzip = baseRoute.js.gzip;
    const currentGzip = currentRoute.js.gzip;
    const ratio = +(currentGzip / baseGzip).toFixed(4);
    const deltaGzip = currentGzip - baseGzip;
    const pass = currentGzip <= Math.floor(baseGzip * maxRatio);
    routeComparisons[routeName] = {
      baselineGzip: baseGzip,
      currentGzip,
      deltaGzip,
      ratio,
      maxRatio,
      pass
    };
    gates.push({
      gate: `${routeName} initial JS gzip <= ${Math.round(maxRatio * 100)}% of baseline`,
      pass,
      detail: `${currentGzip} vs ${baseGzip} (${(ratio * 100).toFixed(1)}%)`
    });
  }
  for (const routeName of ["fleet", "projects", "project"]) {
    const hasUplot = routes[routeName]?.markers.includes("uplot") ?? false;
    gates.push({
      gate: `${routeName} initial graph excludes uPlot`,
      pass: !hasUplot,
      detail: `markers: ${(routes[routeName]?.markers ?? []).join(", ") || "none"}`
    });
  }
  const fleetObserve = (routes.fleet?.markers ?? []).some(marker => marker.startsWith("observe-") || marker.startsWith("project"));
  gates.push({
    gate: "fleet initial graph excludes observe and project modules",
    pass: !fleetObserve,
    detail: `markers: ${(routes.fleet?.markers ?? []).join(", ") || "none"}`
  });
  const noDuplicateMarkers = Object.keys(duplicatedMarkers).length === 0;
  gates.push({
    gate: "no large feature module duplicated across chunks",
    pass: noDuplicateMarkers,
    detail: noDuplicateMarkers ? "none" : JSON.stringify(duplicatedMarkers)
  });

  report.comparison = {
    baselinePath: resolve(comparePath),
    totalJsGzipDelta: totals.js.gzip - (baseline.totals?.js?.gzip ?? 0),
    totalCssGzipDelta: totals.css.gzip - (baseline.totals?.css?.gzip ?? 0),
    routes: routeComparisons,
    gates,
    pass: gates.every(entry => entry.pass)
  };
}

if (outPath !== null) {
  const resolvedOut = resolve(outPath);
  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
if (report.comparison && !report.comparison.pass) {
  process.exit(1);
}
