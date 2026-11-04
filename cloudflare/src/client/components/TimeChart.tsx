import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { alignTracks, windowIndexes, windowStats } from "../chart-data";
import type { Track } from "../columns";
import { createUpdateEffect } from "../effect";
import { axisTime, clock, percent } from "../format";
import { episodeText, evaluate, healthOf, markersOf, type Health, type Limits } from "../health";
import { useTelemetry } from "../state";
import { HealthMark } from "./ui";

export type VizColor = "blue" | "aqua" | "violet" | "magenta" | "neutral" | "ghost" | "serious" | "critical" | "ramp-1" | "ramp-2" | "ramp-3" | "ramp-4" | "ramp-5";

export interface ChartSeries {
  readonly label: string;
  readonly color: number | VizColor;
  readonly track: Track;
  readonly dashed?: boolean | undefined;
  readonly scored?: boolean | undefined;
  readonly graded?: boolean | undefined;
  readonly mirror?: boolean | undefined;
  readonly joinGaps?: boolean | undefined;
}

export interface ChartEvent {
  readonly id?: string | undefined;
  readonly atMs: number;
  readonly label: string;
  readonly onSelect?: (() => void) | undefined;
}

const EVENT_HIT_PX = 6;
const CLICK_SLOP_PX = 4;

export interface TimeChartProps {
  readonly label: string;
  readonly series: readonly ChartSeries[] | (() => readonly ChartSeries[]);
  readonly format?: ((value: number | undefined) => string) | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly area?: boolean | undefined;
  readonly limits?: Limits | undefined;
  readonly legend?: boolean | "inline" | undefined;
  readonly compact?: boolean | undefined;
  readonly timeAxis?: boolean | undefined;
  readonly yAxisWidth?: number | undefined;
  readonly events?: readonly ChartEvent[] | undefined;
  readonly highlight?: string | null | undefined;
  readonly stepMs?: number | undefined;
  readonly sortTooltip?: boolean | undefined;
  readonly provisionalFromMs?: number | undefined;
}

const SYNC_KEY = "stats";
const MIN_ZOOM_PX = 8;
const TIME_LABEL_OVERHANG = 16;
const CLEARED_SELECT = { left: 0, top: 0, width: 0, height: 0 } as const;
const SMOOTH_PATHS = uPlot.paths.spline?.();

const colorVariable = (color: number | VizColor): string => (typeof color === "number" ? `--s${color}` : `--viz-${color}`);
const colorClass = (color: number | VizColor): string => (typeof color === "number" ? `series-${color}` : `viz-${color}`);
const MAX_MARKERS = 6;
const LIMIT_VISIBLE_SHARE = 0.5;
const LIMIT_HEADROOM = 1.15;
const LIMIT_LABEL_GAP_PX = 12;

function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
}

function withAlpha(color: string, alpha: number): string | undefined {
  return /^#[0-9a-f]{6}$/iu.test(color) ? `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : undefined;
}

export function TimeChart(props: TimeChartProps): JSX.Element {
  const telemetry = useTelemetry();
  const series = () => (typeof props.series === "function" ? props.series() : props.series);
  const format = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : (props.format ?? percent)(value));
  const aligned = createMemo(() => alignTracks(series().map(entry => entry.track), props.stepMs));
  const hasData = createMemo(() => aligned().columns.some(column => column.some(value => value !== null)));
  const signature = createMemo(() => series().map(entry => `${entry.label}:${entry.color}`).join("|"));
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [cursor, setCursor] = createSignal<number | null>(null);
  const [span, setSpan] = createSignal<readonly [number, number]>([0, -1]);
  let host: HTMLDivElement | undefined;
  let plot: uPlot | undefined;

  const latest = createMemo(() => windowStats(aligned().columns[0] ?? [], 0, aligned().times.length - 1)?.last);
  const settledValue = (position: number): number | undefined => {
    const column = aligned().columns[position] ?? [];
    const from = props.provisionalFromMs;
    if (from === undefined) return windowStats(column, span()[0], span()[1])?.last;
    const times = aligned().times;
    for (let index = Math.min(span()[1], times.length - 1); index >= span()[0]; index -= 1) {
      const value = column[index];
      if ((times[index] ?? 0) < from && value !== null && value !== undefined) return value;
    }
    return undefined;
  };
  const scoredColumns = createMemo(() => series().flatMap((entry, position) => (entry.scored === false ? [] : [aligned().columns[position] ?? []])));
  const evaluation = createMemo(() => evaluate(aligned().times, scoredColumns(), props.limits));
  const episodes = () => evaluation().episodes;
  const episodeAt = (index: number) => episodes().find(entry => index >= entry.startIndex && (entry.endIndex === null || index <= entry.endIndex));
  const healthAt = (value: number | null | undefined): Health | undefined => {
    const limits = props.limits;
    return limits === undefined ? undefined : healthOf(value, limits) ?? undefined;
  };
  const eventNear = (chart: uPlot, left: number): ChartEvent | undefined => {
    let nearest: ChartEvent | undefined;
    let nearestDistance = EVENT_HIT_PX + 1;
    for (const event of props.events ?? []) {
      if (event.onSelect === undefined) continue;
      const distance = Math.abs(chart.valToPos(event.atMs / 1000, "x") - left);
      if (distance < nearestDistance) {
        nearest = event;
        nearestDistance = distance;
      }
    }
    return nearest;
  };
  const shownText = (position: number): string => {
    const index = cursor();
    return format(index === null ? settledValue(position) : aligned().columns[position]?.[index] ?? undefined);
  };
  const sharedValue = (): string | undefined => {
    const total = series().length;
    if (total < 2) return undefined;
    const first = shownText(0);
    for (let position = 1; position < total; position += 1) if (shownText(position) !== first) return undefined;
    return first;
  };

  const mirrored =createMemo(() => series().some(entry => entry.mirror === true));
  const data = (): uPlot.AlignedData => {
    const columns = aligned().columns.map((column, position) => (series()[position]?.mirror === true ? column.map(value => (value === null ? null : -value)) : [...column]));
    return [aligned().times.map(time => time / 1000), ...columns];
  };

  const applyView = () => {
    const times = aligned().times;
    if (plot === undefined || times.length < 2) return;
    const view = telemetry.view();
    plot.setScale("x", view === null ? { min: times[0]! / 1000, max: times.at(-1)! / 1000 } : { min: view.fromMs / 1000, max: view.toMs / 1000 });
    setSpan(windowIndexes(times, view));
  };

  const build = () => {
    const element = host;
    if (element === undefined) return;
    const styles = getComputedStyle(element);
    const token = (name: string) => styles.getPropertyValue(name).trim();
    const dpr = window.devicePixelRatio;
    const axisFont = `11px ${token("--font")}`;
    const colors = series().map(entry => token(colorVariable(entry.color)));
    const axis = (extra: Partial<uPlot.Axis>): uPlot.Axis => ({
      stroke: token("--muted"),
      font: axisFont,
      grid: { stroke: token("--line"), width: 1 },
      ticks: { show: false },
      gap: 6,
      ...extra
    });
    let tooltip: HTMLDivElement | undefined;

    const showTooltip = (chart: uPlot) => {
      const index = chart.cursor.idx;
      const left = chart.cursor.left ?? -1;
      if (tooltip === undefined) return;
      if (index === null || index === undefined || left < 0) {
        tooltip.hidden = true;
        return;
      }
      const rows = series().flatMap((entry, position) => {
        const value = aligned().columns[position]?.[index];
        return chart.series[position + 1]?.show === false || value === null || value === undefined ? [] : [{ entry, value, color: colors[position] ?? "" }];
      });
      if (props.sortTooltip === true) rows.sort((a, b) => b.value - a.value);
      const heading = document.createElement("b");
      const at = aligned().times[index];
      heading.textContent = props.provisionalFromMs !== undefined && at !== undefined && at >= props.provisionalFromMs ? `${clock(at)} · still arriving` : clock(at);
      tooltip.replaceChildren(heading, ...rows.map(({ entry, value, color }) => {
        const line = document.createElement("div");
        const swatch = document.createElement("i");
        swatch.style.background = color;
        const name = document.createElement("span");
        name.textContent = entry.label;
        const amount = document.createElement("em");
        amount.textContent = format(value);
        for (const child of [swatch, name, amount]) line.appendChild(child);
        const health = entry.scored === false ? undefined : healthAt(value);
        if (health === "elevated" || health === "critical") line.classList.add(`health-${health}`);
        return line;
      }));
      const episode = episodeAt(index);
      if (episode !== undefined) {
        const note = document.createElement("div");
        note.className = `chart-tip-episode health-${episode.peak}`;
        note.textContent = episodeText(aligned().times, episode);
        tooltip.appendChild(note);
      }
      tooltip.hidden = false;
      tooltip.style.left = `${left > chart.over.clientWidth * 0.6 ? left - tooltip.offsetWidth - 14 : left + 14}px`;
    };

    const drawProvisional = (chart: uPlot) => {
      const from = props.provisionalFromMs;
      if (from === undefined) return;
      const { left, top, width, height } = chart.bbox;
      const x = Math.max(left, Math.round(chart.valToPos(from / 1000, "x", true)));
      if (x >= left + width) return;
      const context = chart.ctx;
      context.save();
      context.globalAlpha = 0.035;
      context.fillStyle = token("--text");
      context.fillRect(x, top, left + width - x, height);
      context.globalAlpha = 0.45;
      context.strokeStyle = token("--muted");
      context.lineWidth = dpr;
      context.setLineDash([3 * dpr, 3 * dpr]);
      context.beginPath();
      context.moveTo(x, top);
      context.lineTo(x, top + height);
      context.stroke();
      if (left + width - x > 78 * dpr) {
        context.setLineDash([]);
        context.globalAlpha = 1;
        context.font = `${10 * dpr}px ${token("--font")}`;
        context.textAlign = "left";
        context.fillStyle = token("--muted");
        context.fillText("still arriving", x + 5 * dpr, top + height - 6 * dpr);
      }
      context.restore();
    };

    const drawEpisodes = (chart: uPlot) => {
      const found = episodes();
      if (found.length === 0) return;
      const { left, top, width, height } = chart.bbox;
      const times = aligned().times;
      const context = chart.ctx;
      context.save();
      for (const episode of found) {
        const startMs = times[episode.startIndex];
        const endMs = times[episode.endIndex ?? times.length - 1];
        if (startMs === undefined || endMs === undefined) continue;
        const start = Math.max(left, Math.min(left + width, chart.valToPos(startMs / 1000, "x", true)));
        const end = Math.max(left, Math.min(left + width, chart.valToPos(endMs / 1000, "x", true)));
        if (end <= left || start >= left + width) continue;
        const color = token(episode.peak === "critical" ? "--critical" : "--serious");
        const span = Math.max(2 * dpr, end - start);
        context.fillStyle = color;
        context.globalAlpha = 0.08;
        context.fillRect(start, top, span, height);
        context.globalAlpha = 0.55;
        context.fillRect(start, top, span, 2 * dpr);
      }
      context.restore();
    };

    const drawLimits = (chart: uPlot) => {
      const limits = props.limits;
      if (limits === undefined) return;
      const { left, top, width, height } = chart.bbox;
      const context = chart.ctx;
      context.save();
      context.setLineDash([3 * dpr, 3 * dpr]);
      context.lineWidth = dpr;
      context.font = `${10 * dpr}px ${token("--font")}`;
      context.textAlign = "right";
      const placed: number[] = [];
      for (const [value, color] of [[limits.critical, "--critical"], [limits.elevated, "--serious"]] as const) {
        const y = Math.round(chart.valToPos(value, "y", true));
        if (y < top || y > top + height) continue;
        context.strokeStyle = token(color);
        context.globalAlpha = 0.55;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(left + width, y);
        context.stroke();
        context.globalAlpha = 1;
        const above = limits.direction === "above" ? color === "--critical" : color === "--serious";
        const preferred = above ? y - 4 * dpr : y + 11 * dpr;
        const baseline = preferred < top + 10 * dpr ? y + 11 * dpr : preferred > top + height - 2 * dpr ? y - 4 * dpr : preferred;
        if (placed.some(other => Math.abs(other - baseline) < LIMIT_LABEL_GAP_PX * dpr)) continue;
        placed.push(baseline);
        const text = format(value);
        context.lineJoin = "round";
        context.lineWidth = 3 * dpr;
        context.strokeStyle = token("--surface");
        context.setLineDash([]);
        context.strokeText(text, left + width - 4 * dpr, baseline);
        context.fillStyle = token("--text-2");
        context.fillText(text, left + width - 4 * dpr, baseline);
        context.setLineDash([3 * dpr, 3 * dpr]);
        context.lineWidth = dpr;
      }
      context.restore();
    };

    const drawZero = (chart: uPlot) => {
      if (!mirrored()) return;
      const { left, top, width, height } = chart.bbox;
      const y = Math.round(chart.valToPos(0, "y", true));
      if (y < top || y > top + height) return;
      const context = chart.ctx;
      context.save();
      context.strokeStyle = token("--muted");
      context.globalAlpha = 0.55;
      context.lineWidth = dpr;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(left + width, y);
      context.stroke();
      context.restore();
    };

    const drawEvents = (chart: uPlot) => {
      const events = props.events;
      if (events === undefined || events.length === 0) return;
      const { left, top, width, height } = chart.bbox;
      const context = chart.ctx;
      context.save();
      context.setLineDash([2 * dpr, 3 * dpr]);
      context.lineWidth = dpr;
      context.font = `${11 * dpr}px ${token("--font")}`;
      context.textAlign = "left";
      for (const event of events) {
        const x = Math.round(chart.valToPos(event.atMs / 1000, "x", true));
        if (x < left || x > left + width) continue;
        context.strokeStyle = token("--muted");
        context.globalAlpha = 0.7;
        context.beginPath();
        context.moveTo(x, top);
        context.lineTo(x, top + height);
        context.stroke();
        context.globalAlpha = 1;
        context.lineJoin = "round";
        context.lineWidth = 3 * dpr;
        context.strokeStyle = token("--surface");
        context.setLineDash([]);
        context.strokeText(event.label, x + 3 * dpr, top + 11 * dpr);
        context.fillStyle = token("--text-2");
        context.fillText(event.label, x + 3 * dpr, top + 11 * dpr);
        context.setLineDash([2 * dpr, 3 * dpr]);
        context.lineWidth = dpr;
      }
      context.restore();
    };

    const drawMarkers = (chart: uPlot) => {
      const limits = props.limits;
      if (limits === undefined) return;
      const { left, top, width, height } = chart.bbox;
      const times = aligned().times;
      const context = chart.ctx;
      context.save();
      for (const marker of markersOf(episodes()).slice(-MAX_MARKERS)) {
        const time = times[marker.index];
        if (time === undefined) continue;
        const x = chart.valToPos(time / 1000, "x", true);
        const values = scoredColumns().flatMap(column => (column[marker.index] === null || column[marker.index] === undefined ? [] : [column[marker.index]!]));
        if (values.length === 0 || x < left || x > left + width) continue;
        const value = limits.direction === "above" ? Math.max(...values) : Math.min(...values);
        const y = chart.valToPos(value, "y", true);
        if (y < top || y > top + height) continue;
        const color = token(marker.kind === "critical" ? "--critical" : marker.kind === "elevated" ? "--serious" : "--good");
        context.lineWidth = 2 * dpr;
        context.strokeStyle = token("--surface");
        context.fillStyle = marker.kind === "recovered" ? token("--surface") : color;
        context.beginPath();
        context.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        if (marker.kind === "recovered") {
          context.lineWidth = 1.75 * dpr;
          context.strokeStyle = color;
          context.beginPath();
          context.arc(x, y, 3.5 * dpr, 0, Math.PI * 2);
          context.stroke();
        }
      }
      context.restore();
    };

    const gradedStroke = (chart: uPlot, base: string): CanvasGradient => {
      const limits = props.limits;
      const { top, height } = chart.bbox;
      const gradient = chart.ctx.createLinearGradient(0, top, 0, top + height);
      if (limits === undefined) return gradient;
      const offset = (value: number) => Math.min(1, Math.max(0, (chart.valToPos(value, "y", true) - top) / height));
      const elevated = offset(limits.elevated);
      const critical = offset(limits.critical);
      const stops: readonly (readonly [number, string])[] = limits.direction === "above"
        ? [[0, token("--critical")], [critical, token("--critical")], [critical, token("--serious")], [elevated, token("--serious")], [elevated, base], [1, base]]
        : [[0, base], [elevated, base], [elevated, token("--serious")], [critical, token("--serious")], [critical, token("--critical")], [1, token("--critical")]];
      for (const [position, color] of stops) gradient.addColorStop(position, color);
      return gradient;
    };

    const options: uPlot.Options = {
      width: element.clientWidth,
      height: element.clientHeight,
      legend: { show: false },
      focus: { alpha: 0.16 },
      padding: [8, TIME_LABEL_OVERHANG, props.timeAxis === false ? 8 : 0, 0],
      select: { show: true, ...CLEARED_SELECT },
      cursor: {
        y: false,
        sync: { key: SYNC_KEY },
        drag: { x: true, y: false, setScale: false },
        points: { size: 7, width: 2 },
        bind: { dblclick: () => () => { telemetry.resetZoom(); return null; } }
      },
      scales: {
        x: { time: true },
        y: {
          range: (_chart, low, high) => {
            if (low === null || high === null) return [props.min ?? 0, props.max ?? 1];
            if (mirrored()) {
              const reach = niceCeiling(Math.max(Math.abs(low), Math.abs(high)));
              return [-reach, reach];
            }
            const limits = props.limits;
            const approaching = limits !== undefined && limits.direction === "above" && props.max === undefined && high >= limits.elevated * LIMIT_VISIBLE_SHARE;
            const top = approaching ? Math.max(high, limits.elevated * LIMIT_HEADROOM) : high;
            const pad = (top - low || 1) * 0.08;
            return [props.min ?? low - pad, props.max ?? top + pad];
          }
        }
      },
      axes: [
        axis({
          show: props.timeAxis !== false,
          size: 28,
          space: 110,
          grid: { show: false },
          values: (chart, splits) => {
            const scale = chart.scales.x;
            const spanMs = scale?.min === undefined || scale.min === null || scale.max === undefined || scale.max === null ? 0 : (scale.max - scale.min) * 1000;
            return splits.map(value => axisTime(value * 1000, spanMs));
          }
        }),
        axis({
          ...(props.compact === true ? { space: 28 } : {}),
          ...(mirrored() ? { splits: (chart: uPlot) => { const reach = chart.scales.y?.max ?? 0; return [-reach / 2, 0, reach / 2]; } } : {}),
          values: (_chart, splits) => splits.map(value => format(mirrored() ? Math.abs(value) : value)).map((label, index, labels) => (label === labels[index - 1] ? "" : label)),
          size: (_chart, values: string[] | null) => props.yAxisWidth ?? Math.ceil(Math.max(4, ...(values ?? []).map(value => value.length)) * 6.4 + 16)
        })
      ],
      series: [
        {},
        ...series().map((entry, position): uPlot.Series => {
          const color = colors[position] ?? "";
          const filled = props.area === true && (position === 0 || entry.mirror === true);
          const start = filled ? withAlpha(color, 0.18) : undefined;
          const end = filled ? withAlpha(color, mirrored() ? 0.2 : 0) : undefined;
          return {
            label: entry.label,
            show: !hidden().has(entry.label),
            stroke: entry.graded === true && props.limits !== undefined ? (chart: uPlot) => gradedStroke(chart, color) : color,
            width: entry.graded === true ? 2 : series().some(other => other.graded === true) ? 1.1 : 1.5,
            ...(SMOOTH_PATHS === undefined ? {} : { paths: SMOOTH_PATHS }),
            spanGaps: entry.joinGaps === true,
            points: { show: false },
            ...(entry.dashed === true ? { dash: [4, 3] } : {}),
            ...(start === undefined || end === undefined ? {} : {
              fill: (chart: uPlot) => {
                const gradient = chart.ctx.createLinearGradient(0, chart.bbox.top, 0, chart.bbox.top + chart.bbox.height);
                gradient.addColorStop(0, start);
                gradient.addColorStop(1, end);
                return gradient;
              }
            })
          };
        })
      ],
      hooks: {
        init: [chart => {
          tooltip = document.createElement("div");
          tooltip.className = "chart-tip";
          tooltip.hidden = true;
          chart.over.appendChild(tooltip);
          let pressedAt: number | null = null;
          chart.over.addEventListener("pointerdown", (event) => { pressedAt = event.clientX; });
          chart.over.addEventListener("pointerup", (event) => {
            const start = pressedAt;
            pressedAt = null;
            if (start === null || Math.abs(event.clientX - start) > CLICK_SLOP_PX) return;
            eventNear(chart, event.clientX - chart.over.getBoundingClientRect().left)?.onSelect?.();
          });
        }],
        setCursor: [chart => {
          setCursor(chart.cursor.idx ?? null);
          chart.over.style.cursor = eventNear(chart, chart.cursor.left ?? -1) === undefined ? "" : "pointer";
          showTooltip(chart);
        }],
        setScale: [(chart, key) => {
          if (key !== "x") return;
          const scale = chart.scales.x;
          if (scale?.min === undefined || scale.min === null || scale.max === undefined || scale.max === null) return;
          setSpan(windowIndexes(aligned().times, { fromMs: scale.min * 1000, toMs: scale.max * 1000 }));
        }],
        setSelect: [chart => {
          const { left, width } = chart.select;
          if (width < MIN_ZOOM_PX) return;
          const fromMs = chart.posToVal(left, "x") * 1000;
          const toMs = chart.posToVal(left + width, "x") * 1000;
          chart.setSelect(CLEARED_SELECT, false);
          telemetry.zoomTo({ fromMs, toMs });
        }],
        drawClear: [drawProvisional, drawEpisodes],
        draw: [drawZero, drawEvents, drawLimits, drawMarkers]
      }
    };
    plot = new uPlot(options, data(), element);
    setHidden(new Set<string>());
    applyView();
  };

  const destroy = () => {
    plot?.destroy();
    plot = undefined;
  };

  onSettled(() => {
    const element = host;
    if (element === undefined) return;
    build();
    const observer = new ResizeObserver(() => plot?.setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => {
      observer.disconnect();
      destroy();
    };
  });

  createUpdateEffect(() => signature(), () => {
    if (plot === undefined) return;
    destroy();
    build();
  });

  createUpdateEffect(() => data(), nextData => {
    if (plot === undefined) return;
    plot.setData(nextData, false);
    applyView();
  });

  createUpdateEffect(
    () => series().map(entry => !hidden().has(entry.label)),
    (shown, previous) => {
      if (plot === undefined) return;
      shown.forEach((visible, position) => {
        if (previous?.[position] !== visible) plot?.setSeries(position + 1, { show: visible });
      });
    }
  );

  createUpdateEffect(() => telemetry.view(), applyView);

  createUpdateEffect(() => props.highlight, label => {
    if (plot === undefined) return;
    const position = series().findIndex(entry => entry.label === label);
    plot.setSeries(position === -1 ? null : position + 1, { focus: true });
  });

  const focusSeries = (label: string | null) => {
    const position = series().findIndex(entry => entry.label === label);
    plot?.setSeries(position === -1 ? null : position + 1, { focus: true });
  };

  const toggleSeries = (label: string, additive: boolean) => {
    const labels = series().map(entry => entry.label);
    const current = hidden();
    const next = additive
      ? new Set<string>(current.has(label) ? [...current].filter(entry => entry !== label) : [...current, label])
      : current.size === labels.length - 1 && !current.has(label)
        ? new Set<string>()
        : new Set<string>(labels.filter(entry => entry !== label));
    setHidden(next);
    labels.forEach((entry, position) => plot?.setSeries(position + 1, { show: !next.has(entry) }));
  };

  const moveCursor = (delta: number) => {
    const times = aligned().times;
    const [first, last] = span();
    if (plot === undefined || times.length === 0 || last < first) return;
    const next = Math.min(last, Math.max(first, (cursor() ?? last) + delta));
    plot.setCursor({ left: plot.valToPos(times[next]! / 1000, "x"), top: 8 });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const [first, last] = span();
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (step !== 0) moveCursor(step);
    else if (event.key === "Home") moveCursor(first - (cursor() ?? last));
    else if (event.key === "End") moveCursor(last - (cursor() ?? last));
    else return;
    event.preventDefault();
  };

  return (
    <div class="chart">
      <div
        class={props.compact === true ? "chart-plot compact" : "chart-plot"}
        ref={(element) => { host = element; }}
        role="img"
        tabindex="0"
        aria-label={`${props.label}; latest ${format(latest())}`}
        onKeyDown={onKeyDown}
        onFocus={() => moveCursor(0)}
        onBlur={() => plot?.setCursor({ left: -10, top: -10 })}
      />
      <Show when={!hasData()}>
        <div class="chart-empty">No samples in this range.</div>
      </Show>
      <Show when={props.legend === "inline" && hasData()}>
        <div class="chart-inline-legend">
          <For each={series()}>
            {(entry, position) => {
              const shown = () => {
                const index = cursor();
                return index === null ? settledValue(position()) : aligned().columns[position()]?.[index] ?? undefined;
              };
              return (
                <button
                  class={hidden().has(entry.label) ? "inline-key off" : "inline-key"}
                  type="button"
                  aria-pressed={hidden().has(entry.label) ? "false" : "true"}
                  onClick={(event) => toggleSeries(entry.label, event.shiftKey || event.metaKey)}
                  onMouseEnter={() => focusSeries(hidden().has(entry.label) ? null : entry.label)}
                  onMouseLeave={() => focusSeries(null)}
                >
                  <span class={`legend-swatch ${colorClass(entry.color)}${entry.dashed === true ? " dashed" : ""}`} />
                  <span>{entry.label}</span>
                  {sharedValue() === undefined ? <b>{format(shown())}</b> : null}
                  {entry.scored === false ? null : <HealthMark health={() => healthAt(shown())} />}
                </button>
              );
            }}
          </For>
          {sharedValue() === undefined ? null : <b class="inline-shared">{sharedValue()}</b>}
        </div>
      </Show>
      <Show when={props.legend === true && hasData()}>
        <div class="chart-legend-scroll" role="region" aria-label={`${props.label} series statistics`} tabindex="0">
          <table class="chart-legend">
            <thead>
              <tr><th /><th>Series</th><th>Min</th><th>Avg</th><th>Max</th><th>{cursor() === null ? "Last" : "At cursor"}</th></tr>
            </thead>
            <tbody>
              <For each={series()}>
                {(entry, position) => {
                  const stats = createMemo(() => windowStats(aligned().columns[position()] ?? [], span()[0], span()[1]));
                  const shown = () => {
                    const index = cursor();
                    return index === null ? settledValue(position()) : aligned().columns[position()]?.[index] ?? undefined;
                  };
                  return (
                    <tr
                      class={hidden().has(entry.label) ? "off" : undefined}
                      onClick={(event) => toggleSeries(entry.label, event.shiftKey || event.metaKey)}
                      onMouseEnter={() => focusSeries(hidden().has(entry.label) ? null : entry.label)}
                      onMouseLeave={() => focusSeries(null)}
                    >
                      <td>
                        <button
                          class="legend-key"
                          type="button"
                          aria-pressed={hidden().has(entry.label) ? "false" : "true"}
                          aria-label={`Show only ${entry.label}`}
                        >
                          <span class={`legend-swatch ${colorClass(entry.color)}${entry.dashed === true ? " dashed" : ""}`} />
                        </button>
                      </td>
                      <td>{entry.label}</td>
                      <td>{format(stats()?.min)}</td>
                      <td>{format(stats()?.avg)}</td>
                      <td>{format(stats()?.max)}<span class="mark-slot">{entry.scored === false ? null : <HealthMark health={() => healthAt(stats()?.max)} />}</span></td>
                      <td class="legend-now">{format(shown())}<span class="mark-slot">{entry.scored === false ? null : <HealthMark health={() => healthAt(shown())} />}</span></td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}
