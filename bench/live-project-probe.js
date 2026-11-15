(() => {
  const state = { events: [], reads: [], status: { done: true } };
  window.liveProjectBench = state;
  const original = window.fetch;
  window.fetch = (...args) => {
    const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
    if (url.pathname !== '/api/observe/stats/external/telemetry/summary') return original(...args);
    const headers = new Headers(args[1]?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined));
    const read = { at: performance.now(), fromMs: Number(url.searchParams.get('from')), toMs: Number(url.searchParams.get('to')), trace: headers.get('traceparent')?.split('-')[1] };
    state.reads.push(read);
    return original(...args).then(response => {
      read.status = response.status; read.responseAt = performance.now();
      response.clone().json().then(data => { read.data = data; read.bodyAt = performance.now(); }, error => { read.bodyError = error.name; }).finally(() => { read.settled = true; });
      return response;
    }, error => { read.error = error.name; read.responseAt = performance.now(); read.settled = true; throw error; });
  };
  window.addEventListener('stats:project-journey', event => {
    const { source, range, cache, outcome, durationMs, work, trace } = event.detail;
    const overview = document.querySelector('.native-overview[aria-busy="false"]');
    state.events.push({ at: performance.now(), source, range, cache, outcome, durationMs, work, trace: trace.traceId, dom: overview ? { fromMs: Number(overview.dataset.fromMs), toMs: Number(overview.dataset.toMs), charts: overview.querySelectorAll('.native-overview-charts canvas').length, counts: [...overview.querySelectorAll('.native-summary-item strong')].map(item => item.textContent) } : null });
  });
  const wait = async (test, label) => {
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) { const value = test(); if (value) return value; if (document.body.textContent.includes('Telemetry could not be read')) throw new Error('telemetry error shown'); await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`timeout: ${label}`);
  };
  const click = selector => { const element = document.querySelector(selector); if (!element) throw new Error(`missing: ${selector}`); const at = performance.now(); element.click(); return at; };
  const range = name => { const button = [...document.querySelectorAll('[aria-label="Time range"] button')].find(item => item.textContent === name); if (!button) throw new Error(`missing range: ${name}`); const at = performance.now(); button.click(); return at; };
  const phase = async (name, action) => {
    const eventsAt = state.events.length, readsAt = state.reads.length;
    const start = action();
    const result = { name, events: [], reads: [], readStart: readsAt };
    try {
      const event = await wait(() => state.events.slice(eventsAt).find(item => item.range === name && item.outcome === 'ok' && item.at >= start), `${name} final journey`);
      const read = await wait(() => state.reads.slice(readsAt).find(item => item.trace === event.trace && (item.data || item.bodyError || item.error)), `${name} response`);
      const data = read.data, dom = event.dom;
      const totals = data?.totals; const http = (totals?.requests ?? 0) > 0;
      const count = http ? totals.requests : totals?.events ?? 0;
      const failed = http ? totals.status5xx : (totals?.failed ?? 0) - (totals?.cancelled ?? 0);
      const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
      const checks = { cache: event.cache === false, status: read.status === 200, response: !!data, nonbusy: !!dom, charts: dom?.charts === 3, window: !!data && dom?.fromMs === data.fromMs && dom?.toMs === data.toMs, clamped: !!data && data.fromMs >= read.fromMs && data.toMs <= read.toMs && data.fromMs < data.toMs, count: dom?.counts[0] === fmt.format(count), failures: dom?.counts[1] === fmt.format(failed), issues: dom?.counts[3] === fmt.format(data?.openIssues) };
      checks.exactWindow = !!data && data.toMs === read.toMs && (read.toMs - read.fromMs < 604800000 ? data.fromMs === read.fromMs : data.fromMs - read.fromMs <= 12000 + read.responseAt - read.at);
      if (Object.values(checks).some(value => !value)) throw new Error(`validation: ${JSON.stringify(checks)}`);
      result.ok = true; result.clickToCompleteMs = event.at - start; result.journeyMs = event.durationMs; result.work = event.work;
      result.window = { fromMs: data.fromMs, toMs: data.toMs, buckets: data.buckets.length, operations: data.operations.length, countsMatch: true, charts: dom.charts };
    } catch (error) { result.ok = false; result.error = String(error); }
    result.events = state.events.slice(eventsAt).map(({ at, source, range, cache, outcome, durationMs }) => ({ atMs: at - start, source, range, cache, outcome, durationMs }));
    result.readEnd = state.reads.length; result.started = start;
    return result;
  };
  state.run = async target => {
    const result = { target, seed: target === '1h' ? '6h' : '1h' };
    try {
      click('nav[aria-label="Primary"] a[href*="#/projects"]');
      await wait(() => location.hash.startsWith('#/projects') && document.querySelector('table[aria-label="Projects"] a[href*="#/project/stats"]'), 'projects link');
      range(result.seed);
      await wait(() => document.querySelector('[aria-label="Time range"] button[aria-pressed="true"]')?.textContent === result.seed, 'seed range');
      result.seedResult = await phase(result.seed, () => click('table[aria-label="Projects"] a[href*="#/project/stats"]'));
      if (!result.seedResult.ok) throw new Error('seed failed');
      result.targetResult = await phase(target, () => range(target));
      if (!result.targetResult.ok) throw new Error('target failed');
      await wait(() => state.reads.every(read => read.settled), 'summary read teardown');
      result.ok = true;
    } catch (error) { result.ok = false; result.error = String(error); }
    for (const item of [result.seedResult, result.targetResult].filter(Boolean)) {
      item.reads = state.reads.slice(item.readStart, item.readEnd).map(({ at, responseAt, bodyAt, status, error, bodyError, fromMs, toMs, data, settled }) => ({ atMs: at - item.started, settled: settled === true, ...(responseAt === undefined ? {} : { responseAtMs: responseAt - item.started }), ...(bodyAt === undefined ? {} : { bodyAtMs: bodyAt - item.started }), ...(status === undefined ? {} : { status }), ...(error ? { error } : {}), ...(bodyError ? { bodyError } : {}), requested: { fromMs, toMs }, ...(data ? { returned: { fromMs: data.fromMs, toMs: data.toMs } } : {}) }));
      delete item.readStart; delete item.readEnd; delete item.started;
    }
    state.events.length = 0; state.reads.length = 0;
    return result;
  };
})();
