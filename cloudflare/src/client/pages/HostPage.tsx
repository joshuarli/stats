import { createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { getBlock, getDisks, getFilesystems, getLatest, getNets, getSummary, type BlockSeries, type DiskSeries, type FilesystemSeries, type Host, type NetSeries, type Psi, type SummaryPoint } from "../api";
import { age, bytes, count, errorMessage, microseconds, percent, rate, timestamp, uptime } from "../format";
import { cpuUsed, latestPoint, loadOne, memoryFree, memoryTotal, memoryUsed, psiCpu, sparkPoints } from "../metrics";
import { loadQuery } from "../queries";
import { statusFor } from "../status";
import { useTelemetry } from "../state";
import { CapacityBar } from "../components/CapacityBar";
import { Icon } from "../components/Icon";
import { PageHeader, RangePicker, RefreshButton } from "../components/PageHeader";
import { Sparkline } from "../components/Sparkline";
import { TimeChart, type ChartPoint } from "../components/TimeChart";
import { Badge, EmptyState, ErrorState, KeyValue, MetricTile, Notice, Skeleton, Widget, type Tone } from "../components/ui";

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
              action={<a class="btn btn-secondary" href="#/">Back to fleet</a>}
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
  const { range, now, refreshHosts } = useTelemetry();
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshError, setRefreshError] = createSignal<string | null>(null);

  const latest = createMemo(() => loadQuery(signal => getLatest(hostId(), signal)));
  const summary = createMemo(() => loadQuery(signal => getSummary(hostId(), range(), signal)));
  const disks = createMemo(() => loadQuery(signal => getDisks(hostId(), range(), signal)));
  const nets = createMemo(() => loadQuery(signal => getNets(hostId(), range(), signal)));
  const filesystems = createMemo(() => loadQuery(signal => getFilesystems(hostId(), range(), signal)));
  const block = createMemo(() => loadQuery(signal => getBlock(hostId(), range(), signal)));

  const status = createMemo(() => statusFor(props.host, props.host.lastReceivedAtMs));

  const doRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await Promise.all([
        refreshHosts(),
        refresh(latest),
        refresh(summary),
        refresh(disks),
        refresh(nets),
        refresh(filesystems),
        refresh(block)
      ]);
    } catch (error) {
      setRefreshError(errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Host detail"
        title={props.host.name}
        titleExtra={<Badge tone={status().tone} dot>{status().label}</Badge>}
        subtitle={`${props.host.hostId} · last sample ${age(props.host.lastReceivedAtMs, now())}`}
        actions={
          <>
            <a class="btn btn-ghost" href="#/" aria-label="All hosts"><Icon name="arrowLeft" size={14} /><span class="btn-label">All hosts</span></a>
            <RangePicker />
            <RefreshButton pending={refreshing()} onClick={() => void doRefresh()} />
          </>
        }
      />
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>

      <Errored fallback={(error) => <ErrorState error={error()} compact />}>
        <Loading fallback={<div class="host-meta"><Skeleton rows={1} /></div>}>
          <HostMeta
            receivedAtMs={latest()?.receivedAtMs}
            uptimeMs={latest()?.sample.uptimeMs === undefined ? undefined : Number(latest()?.sample.uptimeMs)}
            cpuCount={latest()?.sample.cpuCount}
            sampleAtMs={latest()?.sample.atMs === undefined ? undefined : Number(latest()?.sample.atMs)}
            seq={latest()?.sample.seq}
            now={now()}
          />
        </Loading>
      </Errored>

      <Errored fallback={(error) => <ErrorState error={error()} compact />}>
        <Loading fallback={<SummarySkeleton />}>
          <SummarySection points={summary().points ?? []} />
        </Loading>
      </Errored>

      <section class="widget-grid">
        <Errored fallback={(error) => <Widget title="Disks" class="span-2"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Disks" class="span-2"><Skeleton rows={4} /></Widget>}>
            <DisksWidget series={disks().series ?? []} />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Network" class="span-2"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Network" class="span-2"><Skeleton rows={4} /></Widget>}>
            <NetworkWidget series={nets().series ?? []} />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Filesystems" class="span-2"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Filesystems" class="span-2"><Skeleton rows={3} /></Widget>}>
            <FilesystemsWidget series={filesystems().series ?? []} />
          </Loading>
        </Errored>
        <Errored fallback={(error) => <Widget title="Block latency" class="span-2"><ErrorState error={error()} compact /></Widget>}>
          <Loading fallback={<Widget title="Block latency" class="span-2"><Skeleton rows={3} chart /></Widget>}>
            <BlockWidget series={block().series ?? []} />
          </Loading>
        </Errored>
      </section>
    </>
  );
}

function HostMeta(props: {
  readonly receivedAtMs: number | undefined;
  readonly uptimeMs: number | undefined;
  readonly cpuCount: number | undefined;
  readonly sampleAtMs: number | undefined;
  readonly seq: string | undefined;
  readonly now: number;
}): JSX.Element {
  return (
    <section class="host-meta" aria-label="Host metadata">
      <KeyValue
        items={[
          { label: "Last received", value: age(props.receivedAtMs, props.now) },
          { label: "Uptime", value: uptime(props.uptimeMs) },
          { label: "CPUs", value: count(props.cpuCount) },
          { label: "Sample time", value: timestamp(props.sampleAtMs) },
          { label: "Sequence", value: props.seq ?? "—" }
        ]}
      />
    </section>
  );
}

function SummarySection(props: { readonly points: readonly SummaryPoint[] }): JSX.Element {
  const last = createMemo(() => latestPoint(props.points));
  const cpu = createMemo(() => cpuUsed(last()));
  const memory = createMemo(() => memoryUsed(last()));
  const free = createMemo(() => memoryFree(last()));
  const total = createMemo(() => memoryTotal(last()));
  const load = createMemo(() => loadOne(last()));
  const pressure = createMemo(() => psiCpu(last()));
  if (props.points.length === 0) {
    return (
      <Widget title="Samples" subtitle="No accepted observations for this range">
        <EmptyState title="No samples were accepted in this range." detail="Gaps are not interpolated and missing values never become zero." icon="activity" />
      </Widget>
    );
  }
  return (
    <>
      <section class="metric-grid" aria-label="Host summary">
        <MetricTile icon="cpu" label="CPU" value={percent(cpu())} detail="user + system" tone={percentTone(cpu(), 75, 90)} meter={cpu()} spark={<Sparkline points={sparkPoints(props.points, cpuUsed)} label="CPU trend" color={0} />} />
        <MetricTile icon="memory" label="Memory used" value={percent(memory())} detail={free() === undefined || total() === undefined ? "unavailable" : `${bytes(free())} free of ${bytes(total())}`} tone={percentTone(memory(), 75, 90)} meter={memory()} spark={<Sparkline points={sparkPoints(props.points, memoryUsed)} label="Memory used trend" color={3} />} />
        <MetricTile icon="gauge" label="Load 1m" value={count(load())} detail={`5m ${count(last()?.load?.five)} · 15m ${count(last()?.load?.fifteen)}`} tone="neutral" spark={<Sparkline points={sparkPoints(props.points, loadOne)} label="Load trend" color={1} />} />
        <MetricTile icon="activity" label="CPU pressure" value={percent(pressure())} detail="PSI some10" tone={percentTone(pressure(), 20, 50)} meter={pressure()} spark={<Sparkline points={sparkPoints(props.points, psiCpu)} label="CPU pressure trend" color={2} />} />
      </section>
      <Show when={props.points.some(point => point.partial)}>
        <Notice tone="warn">Some buckets are partial; gaps are not interpolated.</Notice>
      </Show>
      <section class="chart-grid" aria-label="Host charts">
        <Widget title="CPU" subtitle="Percentage of total counter time" meta={<span class="widget-latest">Now {percent(cpu())}</span>}>
          <TimeChart
            label="CPU"
            series={[
              { label: "user", color: 0, points: summarySeries(props.points, point => point.cpu?.user) },
              { label: "system", color: 1, points: summarySeries(props.points, point => point.cpu?.system) },
              { label: "iowait", color: 2, points: summarySeries(props.points, point => point.cpu?.iowait) },
              { label: "idle", color: 3, points: summarySeries(props.points, point => point.cpu?.idle) }
            ]}
            format={percent}
            min={0}
            max={100}
            latest={cpu() ?? null}
          />
        </Widget>
        <Widget title="Load" subtitle="Run-queue length across sample windows" meta={<span class="widget-latest">Now {count(load())}</span>}>
          <TimeChart
            label="Load"
            series={[
              { label: "1 min", color: 0, points: summarySeries(props.points, point => point.load?.one) },
              { label: "5 min", color: 1, points: summarySeries(props.points, point => point.load?.five) },
              { label: "15 min", color: 3, points: summarySeries(props.points, point => point.load?.fifteen) }
            ]}
            format={value => count(value)}
            min={0}
            latest={load() ?? null}
          />
        </Widget>
        <Widget title="Available memory" subtitle="Memory available to unprivileged processes" meta={<span class="widget-latest">Now {bytes(free())}</span>}>
          <TimeChart
            label="Available memory"
            series={[{ label: "available", color: 3, points: summarySeries(props.points, point => point.mem?.available) }]}
            format={bytes}
            min={0}
            latest={free() ?? null}
          />
        </Widget>
        <Widget title="Pressure" subtitle="Pressure stall information, 10s average" meta={<span class="widget-latest">Now {percent(pressure())}</span>}>
          <TimeChart
            label="Pressure"
            series={[
              { label: "CPU some10", color: 0, points: psiSeries(props.points, value => value.cpu?.some10) },
              { label: "Memory some10", color: 1, points: psiSeries(props.points, value => value.memory?.some10) },
              { label: "I/O some10", color: 2, points: psiSeries(props.points, value => value.io?.some10) }
            ]}
            format={percent}
            min={0}
            latest={pressure() ?? null}
          />
        </Widget>
      </section>
    </>
  );
}

function DisksWidget(props: { readonly series: readonly DiskSeries[] }): JSX.Element {
  return (
    <Widget title="Disks" subtitle="Kernel block device activity" class="span-2" bodyClass="flush">
      {props.series.length === 0 ? <EmptyState title="No disk series in this range." icon="disk" /> : (
        <div class="table-scroll">
          <table class="data-table compact" aria-label="Disk activity">
            <thead><tr><th scope="col">Device</th><th scope="col">Throughput</th><th scope="col">IOPS</th><th scope="col">Busy</th><th scope="col">Trend</th></tr></thead>
            <tbody>
              <For each={props.series}>
                {(entry) => {
                  const point = () => entry.points.at(-1);
                  return (
                    <tr>
                      <td>
                        <span class="device-name">{entry.name ?? entry.id}</span>
                        <span class="cell-note">{entry.id}</span>
                      </td>
                      <td><span class="cell-strong">{rate(point()?.readBytesPerSec)} read</span><span class="cell-note">{rate(point()?.writeBytesPerSec)} write</span></td>
                      <td><span class="cell-strong">{count(point()?.readsPerSec)} read</span><span class="cell-note">{count(point()?.writesPerSec)} write</span></td>
                      <td><MeterCell value={point()?.busyPct} label={percent(point()?.busyPct)} warn={75} bad={100} /></td>
                      <td><Sparkline points={entry.points.map(value => ({ atMs: value.atMs, value: value.readBytesPerSec }))} label={`${entry.id} read rate`} /></td>
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

function NetworkWidget(props: { readonly series: readonly NetSeries[] }): JSX.Element {
  return (
    <Widget title="Network" subtitle="Interface counters since the previous sample" class="span-2" bodyClass="flush">
      {props.series.length === 0 ? <EmptyState title="No network series in this range." icon="network" /> : (
        <div class="table-scroll">
          <table class="data-table compact" aria-label="Network activity">
            <thead><tr><th scope="col">Interface</th><th scope="col">Throughput</th><th scope="col">Packets</th><th scope="col">Drops</th><th scope="col">Errors</th><th scope="col">Trend</th></tr></thead>
            <tbody>
              <For each={props.series}>
                {(entry) => {
                  const point = () => entry.points.at(-1);
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
                      <td><span class="cell-strong">{rate(point()?.rxBytesPerSec)} in</span><span class="cell-note">{rate(point()?.txBytesPerSec)} out</span></td>
                      <td><span class="cell-strong">{count(point()?.rxPacketsPerSec)} in</span><span class="cell-note">{count(point()?.txPacketsPerSec)} out</span></td>
                      <td><span class="cell-strong">{drops() === undefined ? "unavailable" : `${count(drops())}/s`}</span></td>
                      <td><span class="cell-strong">{errors() === undefined ? "unavailable" : `${count(errors())}/s`}</span></td>
                      <td><Sparkline points={entry.points.map(value => ({ atMs: value.atMs, value: value.rxBytesPerSec }))} label={`${entry.id} receive rate`} /></td>
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

function FilesystemsWidget(props: { readonly series: readonly FilesystemSeries[] }): JSX.Element {
  return (
    <Widget title="Filesystems" subtitle="Capacity available to unprivileged processes" class="span-2" bodyClass="flush">
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

function BlockWidget(props: { readonly series: readonly BlockSeries[] }): JSX.Element {
  const points = createMemo(() => props.series.at(0)?.points ?? []);
  const last = createMemo(() => points().at(-1));
  return (
    <Widget
      title="Block latency"
      subtitle="Interval histogram derived from the optional eBPF probe"
      class="span-2"
      meta={last() === undefined ? undefined : <span class="widget-latest">{count(last()?.count)} completions · p50 {microseconds(last()?.p50Us)}</span>}
    >
      {points().length === 0 ? (
        <EmptyState title="No block latency samples in this range." detail="The optional probe is not configured or reported no completions." icon="disk" />
      ) : (
        <TimeChart
          label="Block latency"
          series={[
            { label: "p95", color: 0, points: points().map(point => ({ atMs: point.atMs, value: point.p95Us })) },
            { label: "p99", color: 1, points: points().map(point => ({ atMs: point.atMs, value: point.p99Us })), dash: "dashed" },
            { label: "max", color: 2, points: points().map(point => ({ atMs: point.atMs, value: point.maxUs })), dash: "dotted" }
          ]}
          format={microseconds}
          min={0}
          latest={last()?.p95Us ?? null}
        />
      )}
    </Widget>
  );
}

function MeterCell(props: { readonly value: number | undefined; readonly label: string; readonly warn: number; readonly bad: number }): JSX.Element {
  return (
    <div class="cell-stack">
      <span class="metric-value-small">{props.label}</span>
      <div class="meter meter-small" aria-hidden="true">
        <span class={meterTone(props.value, props.warn, props.bad)} style={`width:${clampPercent(props.value).toFixed(1)}%`} />
      </div>
    </div>
  );
}

function meterTone(value: number | undefined, warn: number, bad: number): string {
  if (value === undefined) return "tone-neutral";
  return value >= bad ? "tone-bad" : value >= warn ? "tone-warn" : "tone-ok";
}

function percentTone(value: number | undefined, warn: number, bad: number): Tone {
  if (value === undefined) return "neutral";
  return value >= bad ? "bad" : value >= warn ? "warn" : "ok";
}

function clampPercent(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : Math.min(100, Math.max(0, value));
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
      <div class="metric-grid" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="metric skeleton-metric"><Skeleton rows={2} /></div>}</For>
      </div>
      <SummarySkeleton />
    </>
  );
}

function SummarySkeleton(): JSX.Element {
  return (
    <section class="chart-grid" aria-hidden="true">
      <Widget title="CPU"><Skeleton rows={2} chart /></Widget>
      <Widget title="Load"><Skeleton rows={2} chart /></Widget>
      <Widget title="Available memory"><Skeleton rows={2} chart /></Widget>
      <Widget title="Pressure"><Skeleton rows={2} chart /></Widget>
    </section>
  );
}
