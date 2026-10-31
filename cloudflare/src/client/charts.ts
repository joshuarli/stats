import { percent } from "./format";

export interface Series {
  readonly label: string;
  readonly color: number;
  readonly points: { readonly atMs: number; readonly value?: number }[];
}

export interface ChartOptions {
  readonly title: string;
  readonly series: Series[];
  readonly format?: (value: number | undefined) => string;
  readonly min?: number;
  readonly max?: number;
}

const SVG = "http://www.w3.org/2000/svg";

function element<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function section(title: string): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  const heading = document.createElement("h2");
  heading.textContent = title;
  card.appendChild(heading);
  return card;
}

export function unavailable(message = "unavailable"): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = "unavailable";
  paragraph.textContent = message;
  return paragraph;
}

export function chart(options: ChartOptions): HTMLElement {
  const card = section(options.title);
  const points = options.series.flatMap(series => series.points).filter(point => point.value !== undefined && Number.isFinite(point.value));
  if (points.length === 0) {
    card.appendChild(unavailable("unavailable"));
    return card;
  }
  const times = points.map(point => point.atMs);
  const values = points.map(point => point.value!);
  const from = Math.min(...times);
  const to = Math.max(...times);
  let low = options.min ?? Math.min(...values);
  let high = options.max ?? Math.max(...values);
  if (low === high) {
    low -= 1;
    high += 1;
  }
  const pad = (high - low) * 0.08;
  low -= pad;
  high += pad;
  const width = 640;
  const height = 180;
  const left = 52;
  const right = 12;
  const top = 12;
  const bottom = 26;
  const x = (time: number) => left + ((time - from) / Math.max(1, to - from)) * (width - left - right);
  const y = (value: number) => top + (1 - (value - low) / (high - low)) * (height - top - bottom);
  const readable = options.format ?? (value => percent(value));
  const svg = element("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", tabindex: "0", "aria-label": `${options.title}; latest ${readable(values.at(-1))}` });
  for (const fraction of [0, 0.5, 1]) {
    const value = low + (high - low) * fraction;
    const line = element("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: "grid" });
    svg.appendChild(line);
    const label = element("text", { x: left - 6, y: y(value) + 4, class: "axis", "text-anchor": "end" });
    label.textContent = readable(value);
    svg.appendChild(label);
  }
  for (const series of options.series) {
    let path = "";
    let drawing = false;
    for (const point of series.points) {
      if (point.value === undefined || !Number.isFinite(point.value)) {
        drawing = false;
        continue;
      }
      path += `${drawing ? "L" : "M"}${x(point.atMs).toFixed(2)},${y(point.value).toFixed(2)} `;
      drawing = true;
    }
    if (path.length > 0) {
      const line = element("path", { d: path.trim(), class: `line series-${series.color}` });
      const title = element("title");
      title.textContent = series.label;
      line.appendChild(title);
      svg.appendChild(line);
    }
  }
  const start = element("text", { x: left, y: height - 6, class: "axis" });
  start.textContent = new Date(from).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const end = element("text", { x: width - right, y: height - 6, class: "axis", "text-anchor": "end" });
  end.textContent = new Date(to).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  svg.appendChild(start);
  svg.appendChild(end);
  const readout = document.createElement("output");
  readout.className = "readout";
  readout.textContent = `latest ${readable(values.at(-1))}`;
  const select = (time: number) => {
    readout.textContent = new Date(time).toLocaleString() + " · " + options.series.map(series => `${series.label} ${readable(series.points.reduce((best, point) => Math.abs(point.atMs - time) < Math.abs(best.atMs - time) ? point : best, series.points[0]!).value)}`).join(" · ");
  };
  svg.addEventListener("pointermove", event => {
    const rect = svg.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    select(from + ratio * (to - from));
  });
  const ordered = [...new Set(points.map(point => point.atMs))].sort((leftTime, rightTime) => leftTime - rightTime);
  let index = ordered.length - 1;
  svg.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    index = Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
    select(ordered[index]!);
  });
  card.appendChild(svg);
  card.appendChild(readout);
  if (options.series.length > 1) {
    const legend = document.createElement("ul");
    legend.className = "legend";
    for (const series of options.series) {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = `swatch series-${series.color}`;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(series.label));
      legend.appendChild(item);
    }
    card.appendChild(legend);
  }
  return card;
}

export function sparkline(points: { atMs: number; value?: number }[], label: string): SVGSVGElement {
  const svg = element("svg", { viewBox: "0 0 180 40", role: "img", "aria-label": label, class: "spark" });
  const values = points.filter(point => point.value !== undefined && Number.isFinite(point.value));
  if (values.length === 0) return svg;
  const low = Math.min(...values.map(point => point.value!));
  const high = Math.max(...values.map(point => point.value!));
  const span = high - low || 1;
  const path = values.map((point, index) => `${index === 0 ? "M" : "L"}${(index / Math.max(1, values.length - 1)) * 180},${36 - ((point.value! - low) / span) * 32}`).join(" ");
  svg.appendChild(element("path", { d: path, class: "line series-0" }));
  return svg;
}

export function capacity(total: number, available: number): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "capacity";
  const used = Math.max(0, total - available);
  const progress = document.createElement("progress");
  progress.max = Math.max(1, total);
  progress.value = used;
  progress.setAttribute("aria-label", `${((used / Math.max(1, total)) * 100).toFixed(1)}% used`);
  const label = document.createElement("span");
  label.textContent = `${((used / Math.max(1, total)) * 100).toFixed(1)}% used`;
  wrapper.appendChild(progress);
  wrapper.appendChild(label);
  return wrapper;
}
