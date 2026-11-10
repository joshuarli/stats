function classifyPath(pathWithSearch) {
  const pathname = pathWithSearch.split("?")[0] ?? pathWithSearch;
  if (pathname.startsWith("/api/observe/")) return "observe";
  if (/^\/api\/v1\/(?:hosts|projects)\/[^/]+\/history$/u.test(pathname)) return "history";
  if (pathname.startsWith("/api/")) return "json";
  return "asset";
}

export function createNetworkTracker(page, activeBase) {
  let active = 0;
  let records = [];
  const pending = new Map();

  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== new URL(activeBase).origin) return;
    active += 1;
    pending.set(request, { path: url.pathname + url.search, method: request.method() });
  });

  const finish = async (request, failed) => {
    const info = pending.get(request);
    if (!info) return;
    pending.delete(request);
    let status = 0;
    let bytes = 0;
    try {
      const response = await request.response();
      if (response) {
        status = response.status();
        if (failed && status < 400) status = 0;
        if (status !== 304 && !failed) {
          const body = await response.body();
          bytes = body.byteLength;
        }
      }
    } catch {
      if (status < 400) status = 0;
    }
    records.push({
      path: info.path,
      kind: classifyPath(info.path),
      status,
      bytes
    });
    active = Math.max(0, active - 1);
  };

  page.on("requestfinished", request => { void finish(request, false); });
  page.on("requestfailed", request => { void finish(request, true); });

  return {
    reset() {
      records = [];
    },
    snapshot() {
      return [...records];
    },
    async waitForQuiet(quietMs = 180, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      let quietSince = active === 0 ? Date.now() : null;
      while (Date.now() < deadline) {
        if (active === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= quietMs) return;
        } else {
          quietSince = null;
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      throw new Error(`Network did not become idle within ${timeoutMs} ms (${active} requests active)`);
    }
  };
}

export function summarizeNetwork(records) {
  const byClass = { asset: 0, json: 0, history: 0, observe: 0 };
  let jsBytes = 0;
  let cssBytes = 0;
  let apiBytes = 0;
  let historyBytes = 0;
  let observeBytes = 0;
  let jsonBytes = 0;
  for (const record of records) {
    byClass[record.kind] = (byClass[record.kind] ?? 0) + 1;
    if (record.kind === "asset") {
      const pathname = record.path.split("?")[0] ?? "";
      if (pathname.endsWith(".js")) jsBytes += record.bytes;
      else if (pathname.endsWith(".css")) cssBytes += record.bytes;
    } else {
      apiBytes += record.bytes;
      if (record.kind === "history") historyBytes += record.bytes;
      else if (record.kind === "observe") observeBytes += record.bytes;
      else jsonBytes += record.bytes;
    }
  }
  const requestList = records.map(record => record.path);
  const apiRequestList = records.filter(record => record.kind !== "asset").map(record => record.path);
  const failedRequests = records.filter(record => record.status === 0 || record.status >= 400).map(record => ({ path: record.path, status: record.status }));
  return {
    requests: records.length,
    apiRequests: apiRequestList.length,
    byClass,
    jsBytes,
    jsKb: +(jsBytes / 1024).toFixed(1),
    cssBytes,
    cssKb: +(cssBytes / 1024).toFixed(1),
    apiBytes,
    apiKb: +(apiBytes / 1024).toFixed(1),
    historyBytes,
    observeBytes,
    jsonBytes,
    requestList,
    apiRequestList,
    failedRequests
  };
}

