(() => {
  const state = window.liveProjectBench;
  if (!state) return { done: true, ok: false, error: "initial-document probe missing" };
  const failed = state.events.find(event => event.outcome !== "ok");
  if (failed) return { done: true, ok: false, error: `journey ${failed.outcome}` };
  const event = state.events.find(event => event.source === "navigation" && event.outcome === "ok");
  if (!event || state.reads.some(read => !read.settled)) return { done: false };
  const read = state.reads.find(read => read.trace === event.trace), data = read?.data, dom = event.dom;
  if (!data || !dom) return { done: true, ok: false, error: "completed navigation has no matching response and DOM" };
  const totals = data.totals, http = totals?.requests > 0;
  const count = http ? totals.requests : totals?.events ?? 0;
  const failures = http ? totals.status5xx : (totals?.failed ?? 0) - (totals?.cancelled ?? 0);
  const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const healthMs = event.work.health_us / 1000, chartsMs = event.durationMs;
  const navigation = performance.getEntriesByType("navigation")[0];
  const checks = {
    source: event.source === "navigation" && event.cache === false,
    initialDocument: Math.abs(event.at - event.durationMs) < 5,
    documentNavigation: navigation?.type === "navigate",
    status: read.status === 200 && state.reads.every(read => read.status === 200 && !read.error && !read.bodyError),
    health: Number.isFinite(healthMs) && healthMs > 0 && healthMs <= chartsMs + 1,
    complete: dom.charts === 3 && count > 0 && data.buckets.length > 0,
    window: dom.fromMs === data.fromMs && dom.toMs === data.toMs && data.toMs === read.toMs && data.fromMs >= read.fromMs,
    counts: dom.counts[0] === format.format(count) && dom.counts[1] === format.format(failures) && dom.counts[3] === format.format(data.openIssues),
    settled: state.reads.every(read => read.settled)
  };
  const resources = performance.getEntriesByType("resource");
  return { done: true, ok: Object.values(checks).every(Boolean), checks, healthMs, chartsMs, timeOrigin: performance.timeOrigin,
    range: event.range, work: event.work, window: { fromMs: data.fromMs, toMs: data.toMs, events: totals.events, buckets: data.buckets.length },
    document: { type: navigation.type, responseStart: navigation.responseStart, responseEnd: navigation.responseEnd, transferSize: navigation.transferSize, encodedBodySize: navigation.encodedBodySize },
    resources: { count: resources.length, transferSize: resources.reduce((sum, resource) => sum + resource.transferSize, 0), encodedBodySize: resources.reduce((sum, resource) => sum + resource.encodedBodySize, 0) },
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, browser: navigator.userAgent },
    ...(Object.values(checks).some(value => !value) ? { error: `validation: ${JSON.stringify(checks)}` } : {}) };
})();
