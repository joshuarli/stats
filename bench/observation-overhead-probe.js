(() => {
  const samples = [], reads = [], journeys = [], expected = new Map();
  const delivery = { attempted: 0, failed: 0, pending: 0, dropped: 0 };
  const original = window.fetch;
  window.fetch = async (...args) => {
    const url = new URL(typeof args[0] === "string" ? args[0] : args[0].url, location.href);
    const started = performance.now();
    const ui = url.pathname === "/api/v1/ui-journeys";
    if (ui) {
      delivery.attempted++; delivery.pending++;
      if (typeof args[1]?.body === "string") delivery.dropped = Math.max(delivery.dropped, JSON.parse(args[1].body).dropped ?? 0);
    }
    let response;
    try { response = await original(...args); if (ui && response.status !== 202) delivery.failed++; }
    catch (error) { if (ui) delivery.failed++; throw error; }
    finally { if (ui) delivery.pending--; }
    if (url.pathname.endsWith("/external/telemetry/summary")) {
      const entry = { started, headersMs: performance.now() - started, status: response.status, serverTiming: response.headers.get("server-timing") };
      reads.push(entry);
      entry.done = response.clone().text().then(async body => {
        const data = JSON.parse(body);
        entry.bodyMs = performance.now() - started;
        entry.data = data;
        const canonical = JSON.stringify(data, (_, item) => item && !Array.isArray(item) && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
        entry.sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      }).catch(error => { entry.bodyError = error.name; });
    }
    return response;
  };
  window.addEventListener("stats:project-journey", event => {
    const overview = document.querySelector(".native-overview[aria-busy=false]");
    journeys.push({ ...event.detail, at: performance.now(), dom: overview ? { fromMs: Number(overview.dataset.fromMs), toMs: Number(overview.dataset.toMs), charts: overview.querySelectorAll("canvas").length, counts: [...overview.querySelectorAll(".native-summary-item strong")].map(element => element.textContent) } : null });
  });
  const wait = async (condition, label) => {
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) { const value = condition(); if (value) return value; await new Promise(done => setTimeout(done, 25)); }
    throw new Error(`dashboard deadline: ${label}`);
  };
  const range = name => {
    const button = [...document.querySelectorAll('[aria-label="Time range"] button')].find(element => element.textContent === name);
    if (!button) throw new Error(`missing range ${name}`);
    button.click();
  };
  const phase = async (name, action, cached) => {
    const previous = journeys.length, requests = reads.length, started = performance.now();
    const context = { range: name, cached, started, readStart: requests, journeyStart: previous };
    window.observationStudy.lastPhase = context;
    action();
    const event = await wait(() => journeys.slice(previous).find(item => item.range === name), name);
    context.event = { range: event.range, source: event.source, cache: event.cache, outcome: event.outcome, at: event.at, dom: event.dom };
    if (event.outcome !== "ok" || event.cache !== cached || !event.dom || event.dom.charts !== 3) throw new Error(`incomplete ${name} journey`);
    if (cached) {
      if (reads.length !== requests) throw new Error("cached selection fetched");
      if (JSON.stringify(event.dom) !== JSON.stringify(expected.get(name))) throw new Error("cached selection changed the rendered summary");
    } else {
      const read = await wait(() => reads.slice(requests).find(item => item.started >= started), "summary response");
      await read.done;
      const data = read.data, dom = event.dom;
      if (read.status !== 200 || !data || !data.buckets.length || !data.operations.length || data.fromMs !== dom.fromMs || data.toMs !== dom.toMs) throw new Error("summary or rendered window changed");
      const http = data.totals.requests > 0, fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
      if (dom.counts[0] !== fmt.format(http ? data.totals.requests : data.totals.events) || dom.counts[1] !== fmt.format(http ? data.totals.status5xx : data.totals.failed - data.totals.cancelled) || dom.counts[3] !== fmt.format(data.openIssues)) throw new Error("rendered totals changed");
      expected.set(name, dom);
      samples.push({ range: name, cached, journeyMs: event.durationMs, clickToCompleteMs: event.at - started, latencyMs: read.bodyMs, serverTiming: read.serverTiming, status: read.status, fromMs: data.fromMs, toMs: data.toMs, events: data.totals.events, sha256: read.sha256 });
      return;
    }
    samples.push({ range: name, cached, journeyMs: event.durationMs, clickToCompleteMs: event.at - started });
  };
  window.observationStudy = { status: { done: false }, delivery, run: async count => {
    samples.length = 0; reads.length = 0; journeys.length = 0;
    Object.assign(delivery, { attempted: 0, failed: 0, pending: 0, dropped: 0 });
    try {
      for (let cycle = 0; cycle < count; cycle++) {
        const projects = document.querySelector('nav[aria-label="Primary"] a[href*="#/projects"]');
        if (!projects) throw new Error("projects navigation missing");
        projects.click();
        await wait(() => document.querySelector('table[aria-label="Projects"] a[href*="#/project/stats"]'), "projects list");
        range("1h");
        await phase("1h", () => document.querySelector('table[aria-label="Projects"] a[href*="#/project/stats"]').click(), false);
        for (const name of ["6h", "24h", "7d"]) await phase(name, () => range(name), false);
        for (const name of ["1h", "6h", "24h", "7d"]) await phase(name, () => range(name), true);
      }
      return { ok: true, samples, reads: reads.length, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, browser: navigator.userAgent } };
    } catch (error) {
      const phase = window.observationStudy.lastPhase;
      const failedReads = reads.slice(phase?.readStart ?? 0).map(read => ({ started: read.started, status: read.status, bodyMs: read.bodyMs, bodyError: read.bodyError, fromMs: read.data?.fromMs, toMs: read.data?.toMs, sha256: read.sha256 }));
      const events = journeys.slice(phase?.journeyStart ?? 0).map(event => ({ range: event.range, source: event.source, cache: event.cache, outcome: event.outcome, at: event.at, dom: event.dom }));
      return { ok: false, error: String(error), failedPhase: { ...phase, reads: failedReads, events }, samples, reads: reads.length };
    }
  } };
})();
