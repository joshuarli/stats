import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs, promisify } from "node:util";
import { openAssets } from "../cloudflare/src/node/assets.ts";

const execute = promisify(execFile);
const { values } = parseArgs({ options: { assets: { type: "string" }, origin: { type: "string" }, output: { type: "string" }, cycles: { type: "string", default: "200" } } });
assert.ok(values.assets && values.origin && values.output);
const cycles = Number(values.cycles);
assert.ok(Number.isSafeInteger(cycles) && cycles >= 5 && cycles <= 1000);
const origin = new URL(values.origin);
assert.equal(origin.protocol, "https:");
const ranges = { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
const fixtures = new Map(), requests = new Map(), failures = [];
const toMs = Date.now(), checkpoints = [];
const assets = await openAssets(values.assets);
const hash = body => createHash("sha256").update(body).digest("hex");
const liveIndex = await fetch(origin);
assert.equal(liveIndex.status, 200);
assert.equal(hash(await liveIndex.text()), hash(readFileSync(`${values.assets}/index.html`)), "assets differ from production");
for (const path of ["/api/v1/capabilities", "/api/v1/services", "/api/v1/hosts", "/api/v1/services/stats/deployments"]) {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200);
  fixtures.set(path, await response.text());
}
for (const [range, duration] of Object.entries(ranges)) {
  const response = await fetch(new URL(`/api/observe/stats/external/telemetry/summary?from=${toMs - duration}&to=${toMs}`, origin));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Stats-Ui-Observations"), "1", "production journey delivery must be enabled");
  const data = await response.json();
  assert.ok(data.totals?.events > 0 && data.buckets.length > 0);
  fixtures.set(range, JSON.stringify(data));
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
    if (url.pathname === "/api/v1/ui-journeys" && request.method === "POST") { request.resume(); response.writeHead(202, { "content-type": "application/json" }).end('{"admitted":true}'); return; }
    let body = fixtures.get(url.pathname);
    if (url.pathname === "/api/observe/stats/external/telemetry/summary") {
      const duration = Number(url.searchParams.get("to")) - Number(url.searchParams.get("from"));
      const range = Object.keys(ranges).find(name => Math.abs(ranges[name] - duration) < 1000) ?? (duration <= ranges["7d"] ? "7d" : undefined);
      assert.ok(range, `unexpected range ${duration}`);
      body = fixtures.get(range);
    }
    if (body !== undefined) { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "Stats-Ui-Observations": "1" }).end(body); return; }
    assert.ok(!url.pathname.startsWith("/api/"), `unexpected API ${url.pathname}`);
    const result = await assets(new Request(url));
    response.writeHead(result.status, Object.fromEntries(result.headers)).end(Buffer.from(await result.arrayBuffer()));
  } catch (error) { failures.push(String(error)); if (!response.headersSent) response.writeHead(500).end(); else response.destroy(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const local = `http://127.0.0.1:${server.address().port}`;
const session = (await execute("agent-browser", ["session", "id", "--scope", "worktree", "--prefix", "stats-retention"])).stdout.trim();
const browser = async args => (await execute("agent-browser", ["--session", session, ...args], { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
const decoded = value => { const result = JSON.parse(value); return typeof result === "string" ? JSON.parse(result) : result; };
let socket, sequence = 0, attached;
const pending = new Map();
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000);
    pending.set(id, result => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function retained(cycle) {
  await cdp("HeapProfiler.collectGarbage", {}, attached);
  const heap = await cdp("Runtime.getHeapUsage", {}, attached);
  const dom = await cdp("Memory.getDOMCounters", {}, attached);
  checkpoints.push({ cycle, ...heap, ...dom });
}
try {
  await browser(["open", `${local}/#/projects`]);
  const endpoint = await browser(["get", "cdp-url"]);
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } });
  const targets = await cdp("Target.getTargets");
  const target = targets.targetInfos.find(target => target.type === "page" && target.url.startsWith(local));
  assert.ok(target);
  attached = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await browser(["eval", `window.retention={cycles:0,error:null,done:false};window.retentionCycle=async()=>{const until=async test=>{for(let n=0;n<1000;n++){if(test())return;await new Promise(done=>setTimeout(done,10));}throw Error('UI completion timed out')}; const link=[...document.querySelectorAll('a')].find(link=>link.textContent==='stats');if(!link)throw Error('stats link missing');link.click();await until(()=>document.querySelector('.native-overview[aria-busy=false]')&&document.querySelectorAll('.native-overview canvas').length===3);for(const range of ['1h','6h','24h','7d','30d']){const button=[...document.querySelectorAll('button')].find(button=>button.textContent===range);button.click();await until(()=>document.querySelector('.native-overview[aria-busy=false]')&&document.querySelectorAll('.native-overview canvas').length===3);await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));}const back=[...document.querySelectorAll('a')].find(link=>link.getAttribute('href')?.startsWith('#/projects'));if(!back)throw Error('projects link missing');back.click();await until(()=>!document.querySelector('.native-overview')&&[...document.querySelectorAll('a')].some(link=>link.textContent==='stats'));window.retention.cycles++;};'installed'`]);
  const batch = async count => {
    await browser(["eval", `window.retention.done=false;(async()=>{try{for(let i=0;i<${count};i++)await window.retentionCycle()}catch(error){window.retention.error=String(error)}finally{window.retention.done=true}})();'started'`]);
    const deadline = Date.now() + 180000;
    let state;
    do { await new Promise(done => setTimeout(done, 200)); state = decoded(await browser(["eval", "JSON.stringify(window.retention)"])); } while (!state.done && Date.now() < deadline);
    assert.ok(state.done && state.error === null, state.error ?? "batch timeout");
  };
  await batch(20);
  await retained(0);
  for (let completed = 0; completed < cycles;) { const count = Math.min(20, cycles - completed); await batch(count); completed += count; await retained(completed); }
  const completed = decoded(await browser(["eval", "JSON.stringify(window.retention)"]));
  assert.equal(completed.cycles, 20 + cycles);
  assert.ok(requests.get("/api/v1/ui-journeys") > 0, "journey transport must run during the retention workload");
  assert.equal(failures.length, 0, JSON.stringify([...new Set(failures)]));
  const growthBytes = checkpoints.at(-1).usedSize - checkpoints[0].usedSize;
  const report = { source: "production assets with frozen nonempty production summary replay over loopback; no production query or latency acceptance", entrySha256: hash(readFileSync(`${values.assets}/index.html`)), fixtureSha256: Object.fromEntries([...fixtures].map(([key, value]) => [key, hash(value)])), cycles, warmupCycles: 20, rangesPerCycle: 5, journeyTransport: "enabled; local server admits with 202", collection: "CDP HeapProfiler.collectGarbage then Runtime.getHeapUsage and Memory.getDOMCounters, measured while project unmounted", browser: await cdp("Browser.getVersion"), checkpoints, growthBytes, pass: growthBytes < 5 * 1024 * 1024 && failures.length === 0 && cycles >= 200, requests: Object.fromEntries(requests), failures };
  writeFileSync(values.output, JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ cycles, growthBytes, pass: report.pass, failures }));
  assert.ok(report.pass || cycles < 200);
} finally {
  socket?.close();
  try { await browser(["close"]); } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}
