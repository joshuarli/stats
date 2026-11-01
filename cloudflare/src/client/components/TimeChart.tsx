import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { alignSeries, windowIndexes, windowStats, type ChartPoint } from "../chart-data";
import { axisTime, clock, percent } from "../format";
import { useTelemetry } from "../state";

export type { ChartPoint };

export interface ChartSeries {
  readonly label: string;
  readonly color: number;
  readonly points: readonly ChartPoint[];
  readonly dashed?: boolean | undefined;
}

export interface ChartThreshold {
  readonly value: number;
  readonly label: string;
}

export interface TimeChartProps {
  readonly label: string;
  readonly series: readonly ChartSeries[];
  readonly format?: ((value: number | undefined) => string) | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly area?: boolean | undefined;
  readonly threshold?: ChartThreshold | undefined;
  readonly legend?: boolean | undefined;
  readonly highlight?: string | null | undefined;
  readonly stepMs?: number | undefined;
  readonly sortTooltip?: boolean | undefined;
}

const SYNC_KEY = "stats";
const MIN_ZOOM_PX = 8;
const MIN_ZOOM_MS = 5_000;
const CLEARED_SELECT = { left: 0, top: 0, width: 0, height: 0 } as const;

function withAlpha(color: string, alpha: number): string | undefined {
  return /^#[0-9a-f]{6}$/iu.test(color) ? `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : undefined;
}

export function TimeChart(props: TimeChartProps): JSX.Element {
  const telemetry = useTelemetry();
  const format = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : (props.format ?? percent)(value));
  const aligned = createMemo(() => alignSeries(props.series.map(entry => entry.points), props.stepMs));
  const hasData = createMemo(() => aligned().columns.some(column => column.some(value => value !== null)));
  const signature = createMemo(() => props.series.map(entry => `${entry.label}:${entry.color}`).join("|"));
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [cursor, setCursor] = createSignal<number | null>(null);
  const [span, setSpan] = createSignal<readonly [number, number]>([0, -1]);
  let host: HTMLDivElement | undefined;
  let plot: uPlot | undefined;

  const latest = createMemo(() => windowStats(aligned().columns[0] ?? [], 0, aligned().times.length - 1)?.last);

  const data = (): uPlot.AlignedData => [aligned().times.map(time => time / 1000), ...aligned().columns.map(column => [...column])] as uPlot.AlignedData;

  const applyView = () => {
    const times = aligned().times;
    if (plot === undefined || times.length < 2) return;
    const view = telemetry.view();
    plot.setScale("x", view === null ? { min: times[0]! / 1000, max: times.at(-1)! / 1000 } : { min: view.fromMs / 1000, max: view.toMs / 1000 });
  };

  const build = () => {
    const element = host;
    if (element === undefined) return;
    const styles = getComputedStyle(element);
    const token = (name: string) => styles.getPropertyValue(name).trim();
    const dpr = window.devicePixelRatio;
    const axisFont = `11px ${token("--font")}`;
    const colors = props.series.map(entry => token(`--s${entry.color}`));
    const axis = (extra: Partial<uPlot.Axis>): uPlot.Axis => ({
      stroke: token("--mut"),
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
      const rows = props.series.flatMap((entry, position) => {
        const value = aligned().columns[position]?.[index];
        return chart.series[position + 1]?.show === false || value === null || value === undefined ? [] : [{ entry, value, color: colors[position] ?? "" }];
      });
      if (props.sortTooltip === true) rows.sort((a, b) => b.value - a.value);
      const heading = document.createElement("b");
      heading.textContent = clock(aligned().times[index]);
      tooltip.replaceChildren(heading, ...rows.map(({ entry, value, color }) => {
        const line = document.createElement("div");
        const swatch = document.createElement("i");
        swatch.style.background = color;
        const name = document.createElement("span");
        name.textContent = entry.label;
        const amount = document.createElement("em");
        amount.textContent = format(value);
        for (const child of [swatch, name, amount]) line.appendChild(child);
        return line;
      }));
      tooltip.hidden = false;
      tooltip.style.left = `${left > chart.over.clientWidth * 0.6 ? left - tooltip.offsetWidth - 14 : left + 14}px`;
    };

    const drawThreshold = (chart: uPlot) => {
      const threshold = props.threshold;
      if (threshold === undefined) return;
      const y = Math.round(chart.valToPos(threshold.value, "y", true));
      const { left, top, width, height } = chart.bbox;
      if (y < top || y > top + height) return;
      const context = chart.ctx;
      context.save();
      context.strokeStyle = token("--bad");
      context.fillStyle = token("--bad");
      context.globalAlpha = 0.55;
      context.setLineDash([4 * dpr, 3 * dpr]);
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(left + width, y);
      context.stroke();
      context.setLineDash([]);
      context.font = `${10 * dpr}px ${token("--font")}`;
      context.textAlign = "right";
      context.fillText(threshold.label, left + width - 4 * dpr, y - 4 * dpr);
      context.restore();
    };

    const options: uPlot.Options = {
      width: element.clientWidth,
      height: element.clientHeight,
      legend: { show: false },
      focus: { alpha: 0.16 },
      padding: [8, 8, 0, 0],
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
            const top = props.threshold === undefined || props.max !== undefined ? high : Math.max(high, props.threshold.value * 1.08);
            const pad = (top - low || 1) * 0.08;
            return [props.min ?? low - pad, props.max ?? top + pad];
          }
        }
      },
      axes: [
        axis({
          size: 28,
          values: (chart, splits) => {
            const scale = chart.scales.x;
            const spanMs = scale?.min === undefined || scale.min === null || scale.max === undefined || scale.max === null ? 0 : (scale.max - scale.min) * 1000;
            return splits.map(value => axisTime(value * 1000, spanMs));
          }
        }),
        axis({
          values: (_chart, splits) => splits.map(value => format(value)),
          size: (_chart, values: string[] | null) => Math.ceil(Math.max(4, ...(values ?? []).map(value => value.length)) * 6.4 + 16)
        })
      ],
      series: [
        {},
        ...props.series.map((entry, position): uPlot.Series => {
          const color = colors[position] ?? "";
          const start = props.area === true && position === 0 ? withAlpha(color, 0.2) : undefined;
          const end = props.area === true && position === 0 ? withAlpha(color, 0) : undefined;
          return {
            label: entry.label,
            stroke: color,
            width: 1.5,
            spanGaps: false,
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
        }],
        setCursor: [chart => {
          setCursor(chart.cursor.idx ?? null);
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
          if (toMs - fromMs >= MIN_ZOOM_MS) telemetry.zoomTo({ fromMs, toMs });
        }],
        draw: [drawThreshold]
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

  createEffect(() => signature(), () => {
    if (plot === undefined) return;
    destroy();
    build();
  }, { defer: true });

  createEffect(() => data(), nextData => {
    if (plot === undefined) return;
    plot.setData(nextData, false);
    applyView();
  }, { defer: true });

  createEffect(() => telemetry.view(), applyView, { defer: true });

  createEffect(() => props.highlight, label => {
    if (plot === undefined) return;
    const position = props.series.findIndex(entry => entry.label === label);
    plot.setSeries(position === -1 ? null : position + 1, { focus: true });
  }, { defer: true });

  const focusSeries = (label: string | null) => {
    const position = props.series.findIndex(entry => entry.label === label);
    plot?.setSeries(position === -1 ? null : position + 1, { focus: true });
  };

  const toggleSeries = (label: string, additive: boolean) => {
    const labels = props.series.map(entry => entry.label);
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
        class="chart-plot"
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
      <Show when={props.legend === true && hasData()}>
        <table class="chart-legend">
          <thead>
            <tr><th /><th>series</th><th>min</th><th>avg</th><th>max</th><th>{cursor() === null ? "last" : "at cursor"}</th></tr>
          </thead>
          <tbody>
            <For each={props.series}>
              {(entry, position) => {
                const stats = createMemo(() => windowStats(aligned().columns[position()] ?? [], span()[0], span()[1]));
                const shown = () => {
                  const index = cursor();
                  return index === null ? stats()?.last : aligned().columns[position()]?.[index] ?? undefined;
                };
                return (
                  <tr class={hidden().has(entry.label) ? "off" : undefined} onMouseEnter={() => focusSeries(hidden().has(entry.label) ? null : entry.label)} onMouseLeave={() => focusSeries(null)}>
                    <td>
                      <button
                        class="legend-key"
                        type="button"
                        aria-pressed={hidden().has(entry.label) ? "false" : "true"}
                        aria-label={`Show only ${entry.label}`}
                        onClick={(event) => toggleSeries(entry.label, event.shiftKey || event.metaKey)}
                      >
                        <span class={`legend-swatch series-${entry.color}${entry.dashed === true ? " dashed" : ""}`} />
                      </button>
                    </td>
                    <td>{entry.label}</td>
                    <td>{format(stats()?.min)}</td>
                    <td>{format(stats()?.avg)}</td>
                    <td>{format(stats()?.max)}</td>
                    <td class="legend-now">{format(shown())}</td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
