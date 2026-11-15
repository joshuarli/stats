(() => {
  const state = { reads: 0, pending: 0, expected: {}, records: [], events: [] };
  window.rangeBench = state;
  const original = window.fetch;
  window.fetch = async (...args) => {
    if (!String(args[0]).includes("telemetry/summary")) return original(...args);
    state.reads++; state.pending++;
    try { return await original(...args); } finally { state.pending--; }
  };
  window.addEventListener("stats:project-journey", event => { if (state.events.length < 12000) state.events.push(event.detail); });
  state.step = async (name, warming = false) => {
    if (document.visibilityState !== "visible") throw new Error("benchmark tab is hidden");
    const reads = state.reads, started = performance.now();
    [...document.querySelectorAll("button")].find(button => button.textContent === name).click();
    if (warming) {
      let ready = false;
      for (let attempt = 0; attempt < 1200; attempt++) {
        await new Promise(done => setTimeout(done, 50));
        if (state.pending === 0 && document.querySelector(".native-overview[aria-busy=false]") && document.querySelectorAll(".native-overview canvas").length === 3) { ready = true; break; }
      }
      if (!ready) throw new Error("warmup did not complete");
    }
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0))));
    const ms = performance.now() - started, pill = document.querySelector(".project-pills button")?.textContent;
    if (!pill || !document.querySelector(".native-overview[aria-busy=false]") || document.querySelectorAll(".native-overview canvas").length !== 3) throw new Error("overview incomplete");
    const overview = document.querySelector(".native-overview"), windowKey = `${overview.dataset.fromMs}:${overview.dataset.toMs}`;
    if (warming) state.expected[name] = { pill, windowKey };
    else {
      if (pill !== state.expected[name].pill || windowKey !== state.expected[name].windowKey || state.reads !== reads) throw new Error("cache output changed or fetched");
      state.records.push({ range: name, ms });
    }
  };
  state.warm = async () => { for (const name of ["1h", "6h", "24h", "7d", "30d"]) await state.step(name, true); return { reads: state.reads, expected: state.expected }; };
  state.run = async count => {
    const before = state.records.length;
    for (let n = 0; n < count; n++) await state.step(["1h", "6h", "24h", "7d", "30d"][n % 5]);
    return { records: state.records.slice(before), reads: state.reads, heapBytes: performance.memory?.usedJSHeapSize, graphs: document.querySelectorAll(".native-overview canvas").length };
  };
  return "installed";
})();
