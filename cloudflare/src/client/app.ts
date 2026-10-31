import { age, bytes, count, microseconds, percent, rate, timestamp, uptime } from "./format";
import { capacity, chart, sparkline, unavailable } from "./charts";
import { getBlock, getDisks, getFilesystems, getHosts, getLatest, getNets, getSummary, type BlockPoint, type DiskPoint, type FilesystemPoint, type Host, type NetPoint, type Psi, type Series, type SummaryPoint } from "./api";

const ranges = ["1h", "6h", "24h", "7d", "90d"] as const;
type Range = typeof ranges[number];
const app = document.getElementById("app")!;
let selectedRange: Range = "1h";
let generation = 0;

function node<K extends keyof HTMLElementTagNameMap>(name: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(name);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function begin(): number {
  generation += 1;
  app.replaceChildren();
  return generation;
}

function message(text: string, action?: HTMLElement): void {
  const box = node("div", "notice");
  box.appendChild(node("p", "", text));
  if (action !== undefined) box.appendChild(action);
  app.appendChild(box);
}

function chip(text: string, className: string): HTMLElement {
  return node("span", `chip ${className}`, text);
}

function card(title: string, body: HTMLElement): HTMLElement {
  const section = node("section", "card");
  section.appendChild(node("h2", "", title));
  section.appendChild(body);
  return section;
}

function table(headers: string[], rows: Node[][]): HTMLElement {
  const wrapper = node("div", "table-wrap");
  const table = node("table");
  const head = node("thead");
  const headRow = node("tr");
  for (const header of headers) headRow.appendChild(node("th", "", header));
  head.appendChild(headRow);
  const body = node("tbody");
  for (const row of rows) {
    const tr = node("tr");
    for (const cell of row) {
      const td = node("td");
      td.appendChild(cell);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(head);
  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

function pageHeader(title: string, subtitle: string, back?: boolean): HTMLElement {
  const header = node("header", "page-head");
  if (back === true) {
    const link = node("a", "back", "← Fleet");
    link.href = "#/";
    header.appendChild(link);
  }
  const text = node("div");
  text.appendChild(node("h1", "", title));
  text.appendChild(node("p", "muted", subtitle));
  header.appendChild(text);
  return header;
}

function statusFor(host: Host | undefined, latestAt: number | null): { label: string; className: string } {
  if (host === undefined) return { label: "unknown", className: "warn" };
  if (host.revoked) return { label: "revoked", className: "bad" };
  if (host.online) return { label: "online", className: "ok" };
  return { label: latestAt === null ? "no samples" : "stale", className: "warn" };
}

function summaryPoints(history: { points?: SummaryPoint[] } | null): SummaryPoint[] {
  return history?.points ?? [];
}

async function fleet(): Promise<void> {
  const mine = begin();
  let hosts: Host[];
  try {
    hosts = (await getHosts()).hosts;
  } catch (error) {
    message(error instanceof Error ? error.message : "Could not load hosts.");
    return;
  }
  if (mine !== generation) return;
  const page = node("main");
  page.appendChild(pageHeader("Fleet", "Host counters from the last accepted samples. Missing values stay unavailable."));
  const refresh = node("button", "btn", "Refresh");
  refresh.type = "button";
  refresh.addEventListener("click", () => void fleet());
  page.appendChild(refresh);
  if (hosts.length === 0) {
    page.appendChild(node("p", "notice", "No telemetry hosts are provisioned."));
    app.appendChild(page);
    return;
  }
  const visible = hosts.slice(0, 12);
  const rows = await Promise.all(visible.map(async host => {
    const [latest, summary, disks, nets] = await Promise.all([
      getLatest(host.hostId).catch(() => null),
      getSummary(host.hostId, "1h").catch(() => null),
      getDisks(host.hostId, "1h").catch(() => null),
      getNets(host.hostId, "1h").catch(() => null)
    ]);
    return { host, latest, summary, disks, nets };
  }));
  if (mine !== generation) return;
  const tableRows = rows.map(({ host, latest, summary, disks, nets }) => {
    const points = summaryPoints(summary);
    const last = points.at(-1);
    const status = statusFor(host, latest?.receivedAtMs ?? host.lastReceivedAtMs);
    const link = node("a", "", host.name);
    link.href = `#/host/${host.hostId}`;
    const cpu = last?.cpu === undefined ? undefined : last.cpu.user + last.cpu.system;
    const diskLast = disks?.series?.map(series => series.points.at(-1)).filter(point => point !== undefined);
    const netLast = nets?.series?.map(series => series.points.at(-1)).filter(point => point !== undefined);
    const diskRead = diskLast?.length ? diskLast.reduce((total, point) => total + point.readBytesPerSec, 0) : undefined;
    const diskWrite = diskLast?.length ? diskLast.reduce((total, point) => total + point.writeBytesPerSec, 0) : undefined;
    const netIn = netLast?.length ? netLast.reduce((total, point) => total + point.rxBytesPerSec, 0) : undefined;
    const netOut = netLast?.length ? netLast.reduce((total, point) => total + point.txBytesPerSec, 0) : undefined;
    const memory = last?.mem === undefined ? "unavailable" : `${bytes(last.mem.available)} free of ${bytes(last.mem.total)}`;
    const trend = sparkline(points.map(point => ({ atMs: point.atMs, value: point.cpu === undefined ? undefined : point.cpu.user + point.cpu.system })), `${host.name} CPU trend`);
    return [
      link,
      chip(status.label, status.className),
      node("span", "", percent(cpu)),
      node("span", "", memory),
      node("span", "", last?.load === undefined ? "unavailable" : count(last.load.one)),
      node("span", "", diskRead === undefined ? "unavailable" : `${rate(diskRead)} read · ${rate(diskWrite)} write`),
      node("span", "", netIn === undefined ? "unavailable" : `${rate(netIn)} in · ${rate(netOut)} out`),
      node("span", "", last?.psi?.cpu?.some10 === undefined ? "unavailable" : percent(last.psi.cpu.some10)),
      trend
    ];
  });
  page.appendChild(table(["Host", "Status", "CPU", "Memory", "Load", "Disk", "Network", "PSI some", "CPU trend"], tableRows));
  app.appendChild(page);
}

function seriesPoints(points: SummaryPoint[], pick: (point: SummaryPoint) => number | undefined): { atMs: number; value?: number }[] {
  return points.map(point => ({ atMs: point.atMs, value: pick(point) }));
}

function psiSeries(points: SummaryPoint[], pick: (psi: Psi) => number | undefined): { atMs: number; value?: number }[] {
  return points.map(point => ({ atMs: point.atMs, value: point.psi === undefined ? undefined : pick(point.psi) }));
}

function diskTable(series: Series<DiskPoint>[] | undefined): HTMLElement {
  if (series === undefined || series.length === 0) return card("Disks", unavailable("unavailable"));
  const rows = series.map(entry => {
    const point = entry.points.at(-1);
    if (point === undefined) return [node("span", "", entry.name ?? entry.id), node("span", "", "unavailable")];
    return [
      node("span", "", entry.name ?? entry.id),
      node("span", "", `${rate(point.readBytesPerSec)} read · ${rate(point.writeBytesPerSec)} write`),
      node("span", "", `${count(point.readsPerSec)} read IOPS · ${count(point.writesPerSec)} write IOPS`),
      node("span", "", percent(point.busyPct)),
      sparkline(entry.points.map(point => ({ atMs: point.atMs, value: point.readBytesPerSec })), `${entry.id} read rate`)
    ];
  });
  return card("Disks", table(["Device", "Bytes", "IOPS", "Busy", "Trend"], rows));
}

function netTable(series: Series<NetPoint>[] | undefined): HTMLElement {
  if (series === undefined || series.length === 0) return card("Network", unavailable("unavailable"));
  const rows = series.map(entry => {
    const point = entry.points.at(-1);
    if (point === undefined) return [node("span", "", entry.name ?? entry.id), node("span", "", "unavailable")];
    return [
      node("span", "", entry.name ?? entry.id),
      node("span", "", `${rate(point.rxBytesPerSec)} in · ${rate(point.txBytesPerSec)} out`),
      node("span", "", `${count(point.rxPacketsPerSec)} pkt/s in · ${count(point.txPacketsPerSec)} pkt/s out`),
      node("span", "", `${count(point.rxDropsPerSec + point.txDropsPerSec)} drops/s`),
      sparkline(entry.points.map(point => ({ atMs: point.atMs, value: point.rxBytesPerSec })), `${entry.id} receive rate`)
    ];
  });
  return card("Network", table(["Interface", "Bytes", "Packets", "Drops", "Trend"], rows));
}

function filesystemTable(series: Series<FilesystemPoint>[] | undefined): HTMLElement {
  if (series === undefined || series.length === 0) return card("Filesystems", unavailable("unavailable"));
  const rows = series.map(entry => {
    const last = entry.points.at(-1);
    const body = node("div");
    if (last === undefined) body.textContent = "unavailable";
    else {
      body.appendChild(capacity(last.total, last.available));
      body.appendChild(node("span", "muted", `${bytes(last.available)} free of ${bytes(last.total)}`));
    }
    return [node("span", "", entry.id), body];
  });
  return card("Filesystems", table(["Mount", "Capacity"], rows));
}

function blockChart(series: Series<BlockPoint>[] | undefined): HTMLElement {
  const points = series?.flatMap(entry => entry.points) ?? [];
  if (points.length === 0) return card("Block latency", unavailable("unavailable"));
  const last = points.at(-1);
  const latency = chart({ title: "Block latency", series: [
    { label: "p95", color: 0, points: points.map(point => ({ atMs: point.atMs, value: point.p95Us })) },
    { label: "p99", color: 1, points: points.map(point => ({ atMs: point.atMs, value: point.p99Us })) },
    { label: "max", color: 2, points: points.map(point => ({ atMs: point.atMs, value: point.maxUs })) }
  ], format: microseconds, min: 0 });
  if (last !== undefined) latency.appendChild(node("p", "muted", `${count(last.count)} completions · p50 ${microseconds(last.p50Us)}`));
  return latency;
}

async function hostView(hostId: string): Promise<void> {
  const mine = begin();
  let hosts: Host[];
  try {
    hosts = (await getHosts()).hosts;
  } catch (error) {
    message(error instanceof Error ? error.message : "Could not load hosts.");
    return;
  }
  const host = hosts.find(candidate => candidate.hostId === hostId);
  const [latest, summary, disks, nets, filesystems, block] = await Promise.all([
    getLatest(hostId).catch(() => null),
    getSummary(hostId, selectedRange).catch(() => null),
    getDisks(hostId, selectedRange).catch(() => null),
    getNets(hostId, selectedRange).catch(() => null),
    getFilesystems(hostId, selectedRange).catch(() => null),
    getBlock(hostId, selectedRange).catch(() => null)
  ]);
  if (mine !== generation) return;
  const page = node("main");
  const status = statusFor(host, latest?.receivedAtMs ?? host.lastReceivedAtMs);
  page.appendChild(pageHeader(host?.name ?? hostId, `${status.label} · last sample ${age(latest?.receivedAtMs ?? host?.lastReceivedAtMs)}`, true));
  const statusLine = node("div", "toolbar");
  statusLine.appendChild(chip(status.label, status.className));
  if (latest !== null) {
    statusLine.appendChild(node("span", "muted", `uptime ${uptime(latest.sample.uptimeMs === undefined ? undefined : Number(latest.sample.uptimeMs))}`));
    statusLine.appendChild(node("span", "muted", `CPUs ${count(latest.sample.cpuCount)}`));
    statusLine.appendChild(node("span", "muted", `sample ${timestamp(Number(latest.sample.atMs))}`));
  }
  page.appendChild(statusLine);

  const buttons = node("div", "ranges");
  for (const range of ranges) {
    const button = node("button", "btn range", range);
    button.type = "button";
    button.dataset.range = range;
    button.setAttribute("aria-pressed", String(range === selectedRange));
    button.addEventListener("click", () => {
      selectedRange = range;
      void hostView(hostId);
    });
    buttons.appendChild(button);
  }
  page.appendChild(buttons);

  const points = summaryPoints(summary);
  if (points.length === 0) {
    page.appendChild(node("p", "notice", "No samples were accepted in this range."));
  } else {
    const partial = points.some(point => point.partial);
    if (partial) page.appendChild(node("p", "notice", "Some buckets are partial; gaps are not interpolated."));
    page.appendChild(chart({ title: "CPU", series: [
      { label: "user", color: 0, points: seriesPoints(points, point => point.cpu?.user) },
      { label: "system", color: 1, points: seriesPoints(points, point => point.cpu?.system) },
      { label: "iowait", color: 2, points: seriesPoints(points, point => point.cpu?.iowait) }
    ], format: percent, min: 0, max: 100 }));
    page.appendChild(chart({ title: "Load", series: [
      { label: "1 min", color: 0, points: seriesPoints(points, point => point.load?.one) },
      { label: "5 min", color: 1, points: seriesPoints(points, point => point.load?.five) },
      { label: "15 min", color: 3, points: seriesPoints(points, point => point.load?.fifteen) }
    ], format: value => count(value) }));
    const last = points.at(-1);
    const memory = card("Available memory", last?.mem === undefined ? unavailable("unavailable") : node("p", "", `${bytes(last.mem.available)} of ${bytes(last.mem.total)}`));
    page.appendChild(memory);
    page.appendChild(chart({ title: "Available memory over time", series: [{ label: "available", color: 3, points: seriesPoints(points, point => point.mem?.available) }], format: bytes }));
    page.appendChild(chart({ title: "Pressure", series: [
      { label: "CPU some10", color: 0, points: psiSeries(points, psi => psi.cpu?.some10) },
      { label: "Memory some10", color: 1, points: psiSeries(points, psi => psi.memory?.some10) },
      { label: "I/O some10", color: 2, points: psiSeries(points, psi => psi.io?.some10) }
    ], format: percent }));
    page.appendChild(diskTable(disks?.series));
    page.appendChild(netTable(nets?.series));
    page.appendChild(filesystemTable(filesystems?.series));
    page.appendChild(blockChart(block?.series));
  }
  app.appendChild(page);
}

async function route(): Promise<void> {
  const hash = window.location.hash.replace(/^#\/?/u, "");
  if (hash.startsWith("host/")) {
    const id = decodeURIComponent(hash.slice("host/".length));
    if (/^h_[0-9a-f]{32}$/u.test(id)) {
      await hostView(id);
      return;
    }
  }
  await fleet();
}

window.addEventListener("hashchange", () => void route());
void route();
