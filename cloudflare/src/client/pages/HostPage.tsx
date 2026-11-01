import { createEffect, createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { getBlock, getDisks, getFilesystems, getLatest, getNets, getSummary, type BlockSeries, type DiskSeries, type FilesystemSeries, type Host, type NetSeries, type Psi, type Series, type SummaryPoint } from "../api";
import { pointsIn, windowStats, type ChartPoint } from "../chart-data";
import { age, bytes, count, errorMessage, isFiniteNumber, microseconds, percent, percentUsed, rate, uptime } from "../format";
import { healthOf, LIMITS, loadLimits, memoryAvailableLimits, type Health, type Limits } from "../health";
import { cpuUsed, loadOne, memoryFree, memoryUsed, psiCpu, sparkPoints, sumSeries } from "../metrics";
import { loadQuery } from "../queries";
import { statusFor } from "../status";
import { useTelemetry } from "../state";
import { CapacityBar } from "../components/CapacityBar";
import { PageHeader } from "../components/PageHeader";
import { Sparkline } from "../components/Sparkline";
import { TimeChart, type VizColor } from "../components/TimeChart";
import { Badge, EmptyState, ErrorState, Meter, Notice, Skeleton, Tile, Widget } from "../components/ui";

export function HostPage(): JSX.Element {
  const params = useParams();
  const { hosts } = useTelemetry();
  const hostId = () => params.hostId ?? "";
  const host = createMemo(() => hosts().find(candidate => candidate.hostId === hostId()));
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<HostSkeleton />}>
        <Show
          when={host()}
          fallback={
            <EmptyState
              icon="host"
              title="Host not found"
              detail="The host id is not in this installation, or the directory changed."
              action={<a class="btn" href="#/">Back to fleet</a>}
            />
          }
        >
          {(found) => <HostView host={found()} />}
        </Show>
      </Loading>
    </Errored>
  );
}

function HostView(props: { readonly host: Host }): JSX.Element {
  const hostId = () => props.host.hostId;
  const { query, now, refreshHosts, tick } = useTelemetry();
  const [refreshError, setRefreshError] = createSignal<string | null>(null);

  const latest = createMemo(() => loadQuery(signal => getLatest(hostId(), signal)));
  const summary = createMemo(() => loadQuery(signal => getSummary(hostId(), query(), signal)));
  const disks = createMemo(() => loadQuery(signal => getDisks(hostId(), query(), signal)));
  const nets = createMemo(() => loadQuery(signal => getNets(hostId(), query(), signal)));
  const filesystems = createMemo(() => loadQuery(signal => getFilesystems(hostId(), query(), signal)));
  const block = createMemo(() => loadQuery(signal => getBlock(hostId(), query(), signal)));

  const status = createMemo(() => statusFor(props.host, props.host.lastReceivedAtMs));

  const doRefresh = async () => {
    setRefreshError(null);
    try {
      await Promise.all([refreshHosts(), refresh(latest), refresh(summary), refresh(disks), refresh(nets), refresh(filesystems), refresh(block)]);
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
  };
  createEffect(() => tick(), () => { void doRefresh(); }, { defer: true });

  return (
    <>
      <PageHeader
        title={props.host.name}
        titleExtra={<Badge tone={status().tone} dot>{status().label}</Badge>}
        hint="Drag a chart to zoom · double-click to reset · click a legend row to isolate"
      >
        <Errored fallback={null}>
          <Loading fallback={null}>
            <HostTags
              hostId={hostId()}
              receivedAtMs={latest()?.receivedAtMs ?? props.host.lastReceivedAtMs ?? undefined}
              uptimeMs={latest()?.sample.uptimeMs === undefined ? undefined : Number(latest()?.sample.uptimeMs)}
              cpuCount={latest()?.sample.cpuCount}
              seq={latest()?.sample.seq}
              now={now()}
            />
          </Loading>
        </Errored>
      </PageHeader>
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>

      <Errored fallback={(error) => <ErrorState error={error()} compact />}>
        <Loading fallback={<SummarySkeleton />}>
          <SummarySection points={summary().points ?? []} stepMs={summary().stepMs} />
        </Loading>
      </Errored>

      <section class="chart-grid" aria-label="Host activity">
        <Errored fallback={(error) => <Widget title="Disk throughput"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Disk throughput"><Skeleton rows={4} chart /></Widget>}>
            <ThroughputWidget
              title="Disk throughput"
              subtitle="all block devices"
              series={disks().series ?? []}
              read={{ label: "read", pick: point => point.readBytesPerSec }}
              write={{ label: "write", pick: point => point.writeBytesPerSec }}
              stepMs={disks().stepMs}
              empty="No disk series in this range."
            />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Network throughput"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Network throughput"><Skeleton rows={4} chart /></Widget>}>
            <ThroughputWidget
              title="Network throughput"
              subtitle="all interfaces"
              series={nets().series ?? []}
              read={{ label: "receive", pick: point => point.rxBytesPerSec }}
              write={{ label: "transmit", pick: point => point.txBytesPerSec }}
              stepMs={nets().stepMs}
              empty="No network series in this range."
            />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Disk operations"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Disk operations"><Skeleton rows={4} chart /></Widget>}>
            <ThroughputWidget
              title="Disk operations"
              subtitle="all block devices, completed per second"
              series={disks().series ?? []}
              read={{ label: "reads", pick: point => point.readsPerSec }}
              write={{ label: "writes", pick: point => point.writesPerSec }}
              format={perSecond}
              stepMs={disks().stepMs}
              empty="No disk series in this range."
            />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Disk busy"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Disk busy"><Skeleton rows={4} chart /></Widget>}>
            <PerSeriesWidget title="Disk busy" subtitle="time with I/O in flight; above 100% means concurrent I/O" series={disks().series ?? []} pick={point => point.busyPct} format={percent} limits={LIMITS.diskBusyPercent} stepMs={disks().stepMs} empty="No disk series in this range." />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Network packets"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Network packets"><Skeleton rows={4} chart /></Widget>}>
            <ThroughputWidget
              title="Network packets"
              subtitle="all interfaces"
              series={nets().series ?? []}
              read={{ label: "receive", pick: point => point.rxPacketsPerSec }}
              write={{ label: "transmit", pick: point => point.txPacketsPerSec }}
              format={perSecond}
              stepMs={nets().stepMs}
              empty="No network series in this range."
            />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Network drops and errors"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Network drops and errors"><Skeleton rows={4} chart /></Widget>}>
            <ThroughputWidget
              title="Network drops and errors"
              subtitle="all interfaces, receive plus transmit"
              series={nets().series ?? []}
              read={{ label: "drops", pick: point => point.rxDropsPerSec + point.txDropsPerSec }}
              write={{ label: "errors", pick: point => point.rxErrorsPerSec + point.txErrorsPerSec }}
              format={perSecond}
              colors={["serious", "critical"]}
              limits={LIMITS.netFaultsPerSec}
              stepMs={nets().stepMs}
              empty="No network series in this range."
            />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Block latency"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Block latency"><Skeleton rows={3} chart /></Widget>}>
            <BlockWidget series={block().series ?? []} stepMs={block().stepMs} />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Block completions"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Block completions"><Skeleton rows={3} chart /></Widget>}>
            <PerSeriesWidget title="Block completions" subtitle="requests completed per sample window" series={block().series ?? []} pick={point => point.count} format={count} stepMs={block().stepMs} empty="No block latency samples in this range." />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Filesystem usage"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Filesystem usage"><Skeleton rows={3} chart /></Widget>}>
            <PerSeriesWidget title="Filesystem usage" subtitle="used share per mount" series={filesystems().series ?? []} pick={point => percentUsed(point.total, point.available)} format={percent} limits={LIMITS.filesystemUsedPercent} max={100} stepMs={filesystems().stepMs} empty="No filesystem series in this range." />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Filesystems"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Filesystems"><Skeleton rows={3} /></Widget>}>
            <FilesystemsWidget series={filesystems().series ?? []} />
          </Loading>
        </Errored>
      </section>

      <Errored fallback={(error) => <Widget title="Devices"><ErrorState error={error()} compact /></Widget>}>
        <Loading fallback={<Widget title="Devices"><Skeleton rows={4} /></Widget>}>
          <DeviceTables disks={disks().series ?? []} nets={nets().series ?? []} diskStepMs={disks().stepMs} netStepMs={nets().stepMs} />
        </Loading>
      </Errored>
    </>
  );
}

function HostTags(props: {
  readonly hostId: string;
  readonly receivedAtMs: number | undefined;
  readonly uptimeMs: number | undefined;
  readonly cpuCount: number | undefined;
  readonly seq: string | undefined;
  readonly now: number;
}): JSX.Element {
  const items = () => [
    { label: "id", value: props.hostId },
    { label: "last sample", value: age(props.receivedAtMs, props.now) },
    { label: "uptime", value: uptime(props.uptimeMs) },
    { label: "cpus", value: count(props.cpuCount) },
    { label: "seq", value: props.seq ?? "—" }
  ];
  return (
    <ul class="tags" aria-label="Host metadata">
      <For each={items()}>
        {(item) => <li class="tag"><span>{item.label}</span>{item.value}</li>}
      </For>
    </ul>
  );
}

function SummarySection(props: { readonly points: readonly SummaryPoint[]; readonly stepMs: number }): JSX.Element {
  const { view } = useTelemetry();
  const windowed = createMemo(() => pointsIn(props.points, view()));
  const stats = (pick: (point: SummaryPoint) => number | undefined) => {
    const values = windowed().map(point => pick(point) ?? null);
    return windowStats(values, 0, values.length - 1);
  };
  const cpu = createMemo(() => stats(cpuUsed));
  const memory = createMemo(() => stats(memoryUsed));
  const load = createMemo(() => stats(loadOne));
  const pressure = createMemo(() => stats(psiCpu));
  const range = (value: { readonly avg: number; readonly max: number } | undefined, format: (value: number | undefined) => string) => value === undefined ? "unavailable" : `avg ${format(value.avg)} · max ${format(value.max)}`;
  const last = createMemo(() => windowed().at(-1));
  const free = createMemo(() => memoryFree(last()));
  const total = createMemo(() => last()?.mem?.total);
  const loadScale = createMemo(() => loadLimits(last()?.cpuCount));
  const memoryScale = createMemo(() => memoryAvailableLimits(total()));
  const health = (value: number | undefined, limits: Limits | undefined): Health | undefined => (limits === undefined ? undefined : healthOf(value, limits) ?? undefined);
  const cpuHealth = createMemo(() => health(cpu()?.last, LIMITS.cpuPercent));
  const memoryHealth = createMemo(() => health(memory()?.last, LIMITS.memoryUsedPercent));
  const loadHealth = createMemo(() => health(load()?.last, loadScale()));
  const pressureHealth = createMemo(() => health(pressure()?.last, LIMITS.pressureSome));
  const series = (label: string, color: number | VizColor, pick: (point: SummaryPoint) => number | undefined, extra: { readonly dashed?: boolean; readonly scored?: boolean; readonly graded?: boolean } = {}) => ({ label, color, points: summarySeries(props.points, pick), ...extra });
  return (
    <Show
      when={props.points.length > 0}
      fallback={
        <Widget title="Samples" subtitle="No accepted observations for this range">
          <EmptyState title="No samples were accepted in this range." detail="Gaps are not interpolated and missing values never become zero." icon="activity" />
        </Widget>
      }
    >
      <section class="tiles" aria-label="Host summary">
        <Tile label="CPU" health={cpuHealth()} value={percent(cpu()?.last)} detail={range(cpu(), percent)} spark={<Sparkline points={sparkPoints(windowed(), cpuUsed)} label="CPU trend" color={0} health={cpuHealth()} />} />
        <Tile label="Memory used" health={memoryHealth()} value={percent(memory()?.last)} detail={free() === undefined || total() === undefined ? range(memory(), percent) : `${bytes(free())} free of ${bytes(total())}`} spark={<Sparkline points={sparkPoints(windowed(), memoryUsed)} label="Memory used trend" color={1} health={memoryHealth()} />} />
        <Tile label="Load 1m" health={loadHealth()} value={count(load()?.last)} detail={range(load(), count)} spark={<Sparkline points={sparkPoints(windowed(), loadOne)} label="Load trend" color={0} health={loadHealth()} />} />
        <Tile label="CPU pressure" health={pressureHealth()} value={percent(pressure()?.last)} detail={range(pressure(), percent)} spark={<Sparkline points={sparkPoints(windowed(), psiCpu)} label="CPU pressure trend" color={0} health={pressureHealth()} />} />
      </section>
      <Show when={props.points.some(point => point.partial)}>
        <Notice tone="warn">Some buckets are partial; gaps are not interpolated.</Notice>
      </Show>
      <section class="chart-grid" aria-label="Host charts">
        <Widget title="CPU" subtitle="% of total counter time" expandable>
          <TimeChart
            label="CPU"
            legend
            area
            series={[series("total", "neutral", cpuUsed, { graded: true }), series("user", "blue", point => point.cpu?.user, { scored: false }), series("system", "aqua", point => point.cpu?.system, { scored: false }), series("iowait", "violet", point => point.cpu?.iowait, { scored: false }), series("steal", "magenta", point => point.cpu?.steal, { scored: false })]}
            format={percent}
            min={0}
            max={100}
            limits={LIMITS.cpuPercent}
            stepMs={props.stepMs}
          />
        </Widget>
        <Widget title="Load" subtitle="run-queue length" expandable>
          <TimeChart
            label="Load"
            legend
            area
            series={[series("1 min", "ramp-5", point => point.load?.one, { graded: true }), series("5 min", "ramp-3", point => point.load?.five, { scored: false }), series("15 min", "ramp-1", point => point.load?.fifteen, { scored: false })]}
            format={value => count(value)}
            limits={loadScale()}
            min={0}
            stepMs={props.stepMs}
          />
        </Widget>
        <Widget title="Available memory" subtitle="to unprivileged processes" expandable>
          <TimeChart label="Available memory" legend area series={[series("available", "aqua", point => point.mem?.available, { graded: true })]} format={bytes} limits={memoryScale()} min={0} stepMs={props.stepMs} />
        </Widget>
        <Widget title="Swap used" subtitle="swap in use" expandable>
          <TimeChart label="Swap used" legend area series={[series("swap used", "aqua", point => point.mem?.swapUsed)]} format={bytes} min={0} stepMs={props.stepMs} />
        </Widget>
        <Widget title="Swap activity" subtitle="bytes paged to and from swap per second" expandable>
          <TimeChart
            label="Swap activity"
            legend
            area
            series={[series("swap in", "blue", point => point.mem?.swapInBytesPerSec), series("swap out", "aqua", point => point.mem?.swapOutBytesPerSec)]}
            format={rate}
            limits={LIMITS.swapBytesPerSec}
            min={0}
            stepMs={props.stepMs}
          />
        </Widget>
        <Widget title="Memory pressure" subtitle="PSI some: share of time tasks stalled on memory" expandable>
          <TimeChart
            label="Memory pressure"
            legend
            area
            series={[
              { label: "10s", color: "ramp-5", points: psiSeries(props.points, value => value.memory?.some10) },
              { label: "60s", color: "ramp-3", scored: false, points: psiSeries(props.points, value => value.memory?.some60) },
              { label: "300s", color: "ramp-1", scored: false, points: psiSeries(props.points, value => value.memory?.some300) }
            ]}
            format={percent}
            limits={LIMITS.pressureSome}
            min={0}
            stepMs={props.stepMs}
          />
        </Widget>
        <Widget title="Pressure" subtitle="PSI, 10s average" expandable>
          <TimeChart
            label="Pressure"
            legend
            area
            series={[
              { label: "cpu", color: "blue", points: psiSeries(props.points, value => value.cpu?.some10) },
              { label: "memory", color: "aqua", points: psiSeries(props.points, value => value.memory?.some10) },
              { label: "i/o", color: "violet", points: psiSeries(props.points, value => value.io?.some10) }
            ]}
            format={percent}
            limits={LIMITS.pressureSome}
            min={0}
            stepMs={props.stepMs}
          />
        </Widget>
        <Show when={props.points.some(point => [point.psi?.cpu, point.psi?.memory, point.psi?.io].some(group => group?.full10 !== undefined))}>
          <Widget title="Full stalls" subtitle="PSI full, 10s average: all non-idle tasks stalled" expandable>
            <TimeChart
              label="Full stalls"
              legend
              area
              series={[
                { label: "cpu", color: "blue", points: psiSeries(props.points, value => value.cpu?.full10) },
                { label: "memory", color: "aqua", points: psiSeries(props.points, value => value.memory?.full10) },
                { label: "i/o", color: "violet", points: psiSeries(props.points, value => value.io?.full10) }
              ]}
              format={percent}
              limits={LIMITS.pressureFull}
              min={0}
              stepMs={props.stepMs}
            />
          </Widget>
        </Show>
      </section>
    </Show>
  );
}

function ThroughputWidget<T extends { readonly atMs: number }>(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly series: readonly { readonly points: readonly T[] }[];
  readonly read: { readonly label: string; readonly pick: (point: T) => number | undefined };
  readonly write: { readonly label: string; readonly pick: (point: T) => number | undefined };
  readonly format?: (value: number | undefined) => string;
  readonly colors?: readonly [VizColor, VizColor];
  readonly limits?: Limits;
  readonly stepMs: number;
  readonly empty: string;
}): JSX.Element {
  return (
    <Widget title={props.title} subtitle={props.subtitle} expandable>
      {props.series.length === 0 ? <EmptyState title={props.empty} icon="disk" /> : (
        <TimeChart
          label={props.title}
          legend
          area
          series={[
            { label: props.read.label, color: props.colors?.[0] ?? "blue", points: sumSeries(props.series, props.read.pick) },
            { label: props.write.label, color: props.colors?.[1] ?? "aqua", points: sumSeries(props.series, props.write.pick) }
          ]}
          format={props.format ?? rate}
          limits={props.limits}
          min={0}
          stepMs={props.stepMs}
        />
      )}
    </Widget>
  );
}

function perSecond(value: number | undefined): string {
  return isFiniteNumber(value) ? `${count(value)}/s` : count(value);
}

const SERIES_COLORS = ["blue", "aqua", "violet", "magenta"] as const satisfies readonly VizColor[];

function PerSeriesWidget<T extends { readonly atMs: number }>(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly series: readonly Series<T>[];
  readonly pick: (point: T) => number | undefined;
  readonly format: (value: number | undefined) => string;
  readonly limits?: Limits;
  readonly max?: number;
  readonly stepMs: number;
  readonly empty: string;
}): JSX.Element {
  const shown = createMemo(() => {
    const peak = (entry: Series<T>) => Math.max(Number.NEGATIVE_INFINITY, ...entry.points.map(point => props.pick(point) ?? Number.NEGATIVE_INFINITY));
    const ranked = [...props.series].sort((left, right) => peak(right) - peak(left)).slice(0, SERIES_COLORS.length);
    return ranked.sort((left, right) => left.id.localeCompare(right.id));
  });
  const subtitle = () => (props.series.length > shown().length ? `${props.subtitle} · highest ${shown().length} of ${props.series.length}` : props.subtitle);
  return (
    <Widget title={props.title} subtitle={subtitle()} expandable>
      {props.series.length === 0 ? <EmptyState title={props.empty} icon="disk" /> : (
        <TimeChart
          label={props.title}
          legend
          series={shown().map((entry, index) => ({ label: entry.name ?? entry.id, color: SERIES_COLORS[index] ?? "neutral", points: entry.points.map(point => ({ atMs: point.atMs, value: props.pick(point) })) }))}
          format={props.format}
          limits={props.limits}
          min={0}
          max={props.max}
          stepMs={props.stepMs}
        />
      )}
    </Widget>
  );
}

function reporting<T extends { readonly atMs: number }>(series: readonly Series<T>[], stepMs: number): { readonly active: readonly Series<T>[]; readonly retired: number } {
  const latest = Math.max(0, ...series.map(entry => entry.points.at(-1)?.atMs ?? 0));
  const active = series.filter(entry => (entry.points.at(-1)?.atMs ?? 0) >= latest - 2 * stepMs);
  return { active, retired: series.length - active.length };
}

function retiredNote(subtitle: string, retired: number): string {
  return retired === 0 ? subtitle : `${subtitle} · ${retired} retired hidden, still in the totals`;
}

function DeviceTables(props: { readonly disks: readonly DiskSeries[]; readonly nets: readonly NetSeries[]; readonly diskStepMs: number; readonly netStepMs: number }): JSX.Element {
  const { view } = useTelemetry();
  const disks = createMemo(() => reporting(props.disks, props.diskStepMs));
  const nets = createMemo(() => reporting(props.nets, props.netStepMs));
  const lastIn = <T extends { readonly atMs: number }>(points: readonly T[]) => pointsIn(points, view()).at(-1);
  return (
    <>
      <Widget title="Disks" subtitle={retiredNote("kernel block device activity", disks().retired)} bodyClass="flush">
        {props.disks.length === 0 ? <EmptyState title="No disk series in this range." icon="disk" /> : (
          <div class="table-scroll">
            <table class="data-table compact" aria-label="Disk activity">
              <thead><tr><th scope="col">Device</th><th scope="col">Read</th><th scope="col">Write</th><th scope="col">IOPS read / write</th><th scope="col">Busy</th><th scope="col">Trend</th></tr></thead>
              <tbody>
                <For each={disks().active}>
                  {(entry) => {
                    const point = () => lastIn(entry.points);
                    return (
                      <tr>
                        <td><span class="device-name">{entry.name ?? entry.id}</span><span class="cell-note">{entry.id}</span></td>
                        <td>{rate(point()?.readBytesPerSec)}</td>
                        <td>{rate(point()?.writeBytesPerSec)}</td>
                        <td>{count(point()?.readsPerSec)} <span class="cell-note">/ {count(point()?.writesPerSec)}</span></td>
                        <td><div class="cpu-cell"><span class="metric-value-small">{percent(point()?.busyPct)}</span><Meter value={point()?.busyPct} warn={LIMITS.diskBusyPercent.elevated} bad={LIMITS.diskBusyPercent.critical} /></div></td>
                        <td><Sparkline points={pointsIn(entry.points, view()).map(value => ({ atMs: value.atMs, value: value.readBytesPerSec }))} label={`${entry.id} read rate`} /></td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Widget>
      <Widget title="Network" subtitle={retiredNote("interface counters since the previous sample", nets().retired)} bodyClass="flush">
        {props.nets.length === 0 ? <EmptyState title="No network series in this range." icon="network" /> : (
          <div class="table-scroll">
            <table class="data-table compact" aria-label="Network activity">
              <thead><tr><th scope="col">Interface</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Drops</th><th scope="col">Errors</th><th scope="col">Trend</th></tr></thead>
              <tbody>
                <For each={nets().active}>
                  {(entry) => {
                    const point = () => lastIn(entry.points);
                    const drops = () => {
                      const value = point();
                      return value === undefined ? undefined : value.rxDropsPerSec + value.txDropsPerSec;
                    };
                    const errors = () => {
                      const value = point();
                      return value === undefined ? undefined : value.rxErrorsPerSec + value.txErrorsPerSec;
                    };
                    return (
                      <tr>
                        <td><span class="device-name">{entry.name ?? entry.id}</span><span class="cell-note">{entry.id}</span></td>
                        <td>{rate(point()?.rxBytesPerSec)}</td>
                        <td>{rate(point()?.txBytesPerSec)}</td>
                        <td>{drops() === undefined ? "unavailable" : `${count(drops())}/s`}</td>
                        <td>{errors() === undefined ? "unavailable" : `${count(errors())}/s`}</td>
                        <td><Sparkline points={pointsIn(entry.points, view()).map(value => ({ atMs: value.atMs, value: value.rxBytesPerSec }))} label={`${entry.id} receive rate`} /></td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Widget>
    </>
  );
}

function FilesystemsWidget(props: { readonly series: readonly FilesystemSeries[] }): JSX.Element {
  return (
    <Widget title="Filesystems" subtitle="capacity available to unprivileged processes" bodyClass="flush">
      {props.series.length === 0 ? <EmptyState title="No filesystem series in this range." icon="disk" /> : (
        <div class="table-scroll">
          <table class="data-table compact" aria-label="Filesystem capacity">
            <thead><tr><th scope="col">Mount</th><th scope="col">Capacity</th></tr></thead>
            <tbody>
              <For each={props.series}>
                {(entry) => {
                  const point = () => entry.points.at(-1);
                  return (
                    <tr>
                      <td><span class="device-name">{entry.id}</span></td>
                      <td>
                        <Show when={point()} fallback={<span class="cell-note">unavailable</span>}>
                          {(current) => <CapacityBar total={current().total} available={current().available} />}
                        </Show>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}

function BlockWidget(props: { readonly series: readonly BlockSeries[]; readonly stepMs: number }): JSX.Element {
  const points = createMemo(() => props.series.at(0)?.points ?? []);
  const last = createMemo(() => points().at(-1));
  return (
    <Widget
      title="Block latency"
      subtitle="eBPF probe histogram"
      meta={last() === undefined ? undefined : <span class="widget-latest">{count(last()?.count)} completions · p50 {microseconds(last()?.p50Us)}</span>}
      expandable
    >
      {points().length === 0 ? (
        <EmptyState title="No block latency samples in this range." detail="The optional probe is not configured or reported no completions." icon="disk" />
      ) : (
        <TimeChart
          label="Block latency"
          legend
          series={[
            { label: "min", color: "ramp-1", scored: false, points: points().map(point => ({ atMs: point.atMs, value: point.minUs })), dashed: true },
            { label: "p50", color: "ramp-2", scored: false, points: points().map(point => ({ atMs: point.atMs, value: point.p50Us })) },
            { label: "p95", color: "ramp-3", scored: false, points: points().map(point => ({ atMs: point.atMs, value: point.p95Us })) },
            { label: "p99", color: "ramp-4", points: points().map(point => ({ atMs: point.atMs, value: point.p99Us })) },
            { label: "max", color: "ramp-5", scored: false, points: points().map(point => ({ atMs: point.atMs, value: point.maxUs })), dashed: true }
          ]}
          limits={LIMITS.blockP99Us}
          format={microseconds}
          min={0}
          stepMs={props.stepMs}
        />
      )}
    </Widget>
  );
}

function summarySeries(points: readonly SummaryPoint[], pick: (point: SummaryPoint) => number | undefined): ChartPoint[] {
  return points.map(point => ({ atMs: point.atMs, value: pick(point) }));
}

function psiSeries(points: readonly SummaryPoint[], pick: (pressure: Psi) => number | undefined): ChartPoint[] {
  return points.map(point => ({ atMs: point.atMs, value: point.psi === undefined ? undefined : pick(point.psi) }));
}

function HostSkeleton(): JSX.Element {
  return (
    <>
      <div class="page-skeleton">
        <Skeleton rows={2} />
      </div>
      <SummarySkeleton />
    </>
  );
}

function SummarySkeleton(): JSX.Element {
  return (
    <>
      <section class="tiles" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="tile"><Skeleton rows={2} /></div>}</For>
      </section>
      <section class="chart-grid" aria-hidden="true">
        <Widget title="CPU"><Skeleton rows={2} chart /></Widget>
        <Widget title="Load"><Skeleton rows={2} chart /></Widget>
        <Widget title="Available memory"><Skeleton rows={2} chart /></Widget>
        <Widget title="Pressure"><Skeleton rows={2} chart /></Widget>
      </section>
    </>
  );
}
