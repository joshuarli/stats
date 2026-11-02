import { createEffect, createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { ApiFailure, getHostHistories, getSummary, getSystem, type Host, type SummaryPoint } from "../api";
import { errorMessage } from "../format";
import { RANGE_MS } from "../../limits";
import { loadQuery } from "../queries";
import { statusFor } from "../status";
import { useTelemetry } from "../state";
import { PageHeader } from "../components/PageHeader";
import { Badge, EmptyState, ErrorState, Notice, Skeleton, Widget } from "../components/ui";
import { BlockCompletionsWidget, BlockWidget } from "./host/Block";
import { CpuWidget, LoadWidget, PressureNotice } from "./host/Compute";
import { DiskWidget } from "./host/Disk";
import { FilesystemsWidget } from "./host/Filesystems";
import { MemoryWidget } from "./host/Memory";
import { buildCells } from "./host/monitors";
import { NetworkWidget } from "./host/Network";
import { PowerWidget, reportsPower } from "./host/Power";
import { rebootEvents } from "./host/shared";
import { StatusStrip } from "./host/Status";
import { SystemInfo } from "./host/System";

const DAY_MS = 86_400_000;
const GHOST_RANGES: ReadonlySet<string> = new Set(["1h", "6h", "24h"]);
const GHOST_REFRESH_TICKS = 20;

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
  const { query, view, refreshHosts, tick } = useTelemetry();
  const [refreshError, setRefreshError] = createSignal<string | null>(null);

  const system = createMemo(() => loadQuery(signal => getSystem(hostId(), signal)));
  const histories = createMemo(() => loadQuery(signal => getHostHistories(hostId(), query(), signal)));
  const summary = () => histories().summary;
  const disks = () => histories().disks;
  const nets = () => histories().nets;
  const filesystems = () => histories().filesystems;
  const block = () => histories().block;

  const comparisonTick = createMemo(() => Math.floor(tick() / GHOST_REFRESH_TICKS));
  const yesterday = createMemo((): Promise<readonly SummaryPoint[] | null> => {
    comparisonTick();
    const current = query();
    if (!("range" in current) || !GHOST_RANGES.has(current.range)) return Promise.resolve(null);
    const range = current.range;
    return loadQuery(async signal => {
      const to = Date.now();
      try {
        const history = await getSummary(hostId(), { fromMs: to - RANGE_MS[range] - DAY_MS, toMs: to - DAY_MS }, signal);
        return (history.points ?? []).map(point => ({ ...point, atMs: point.atMs + DAY_MS }));
      } catch (error) {
        if (signal.aborted || !(error instanceof ApiFailure)) throw error;
        console.error("yesterday's history could not be loaded", error);
        return null;
      }
    });
  });

  const status = createMemo(() => statusFor(props.host, props.host.lastReceivedAtMs));
  const events = createMemo(() => rebootEvents(summary().points ?? []));
  const reportsBlock = createMemo(() => (block().series ?? []).some(entry => entry.points.length > 0));

  const doRefresh = async () => {
    setRefreshError(null);
    try {
      await Promise.all([refreshHosts(), refresh(histories)]);
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
  };
  createEffect(() => tick(), () => { void doRefresh(); }, { defer: true });

  const cells = createMemo(() => buildCells({
    points: summary().points ?? [],
    stepMs: summary().stepMs,
    disks: disks().series ?? [],
    diskStepMs: disks().stepMs,
    nets: nets().series ?? [],
    netStepMs: nets().stepMs,
    filesystems: filesystems().series ?? [],
    fsStepMs: filesystems().stepMs
  }, view()));

  return (
    <>
      <PageHeader
        title={props.host.name}
        titleExtra={
          <>
            <Badge tone={status().tone} dot>{status().label}</Badge>
            <Errored fallback={null}>
              <Loading fallback={null}>
                <SystemInfo system={system()} memoryBytes={() => summary().points?.at(-1)?.mem?.total} uptimeMs={() => summary().points?.at(-1)?.uptimeMs} />
              </Loading>
            </Errored>
          </>
        }
      >
      </PageHeader>
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>

      <Errored fallback={(error) => <ErrorState error={error()} compact />}>
        <Loading fallback={<SummarySkeleton />}>
          <Show
            when={(summary().points ?? []).length > 0}
            fallback={
              <Widget title="Samples">
                <EmptyState title="No samples were accepted in this range." detail="Gaps are not interpolated and missing values never become zero." icon="activity" />
              </Widget>
            }
          >
            <StatusStrip cells={cells()} />
            <Show when={(summary().points ?? []).some(point => point.partial)}>
              <Notice tone="warn">Some buckets are partial; gaps are not interpolated.</Notice>
            </Show>
            <PressureNotice points={summary().points ?? []} />
            <section class="charts" aria-label="Charts">
              <CpuWidget points={summary().points ?? []} yesterday={yesterday()} stepMs={summary().stepMs} events={events()} />
              <LoadWidget points={summary().points ?? []} yesterday={yesterday()} stepMs={summary().stepMs} events={events()} />
              <MemoryWidget points={summary().points ?? []} stepMs={summary().stepMs} events={events()} />
              <Show when={reportsPower(summary().points ?? [])}>
                <PowerWidget points={summary().points ?? []} stepMs={summary().stepMs} events={events()} />
              </Show>
              <FilesystemsWidget series={filesystems().series ?? []} stepMs={filesystems().stepMs} events={events()} />
              <NetworkWidget series={nets().series ?? []} stepMs={nets().stepMs} events={events()} />
              <DiskWidget series={disks().series ?? []} stepMs={disks().stepMs} summary={summary().points ?? []} summaryStepMs={summary().stepMs} events={events()} />
              <Show when={reportsBlock()} fallback={<Notice>Block latency is not reported: the optional eBPF probe is not configured on this host (see bpf/README.md).</Notice>}>
                <BlockWidget series={block().series ?? []} stepMs={block().stepMs} events={events()} />
                <BlockCompletionsWidget series={block().series ?? []} stepMs={block().stepMs} events={events()} />
              </Show>
            </section>
          </Show>
        </Loading>
      </Errored>
    </>
  );
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
      <section class="status-strip" aria-hidden="true">
        <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>{() => <div class="strip-cell"><Skeleton rows={2} /></div>}</For>
      </section>
      <section class="chart-grid" aria-hidden="true">
        <Widget title="CPU"><Skeleton rows={2} chart /></Widget>
        <Widget title="Load"><Skeleton rows={2} chart /></Widget>
        <Widget title="Memory"><Skeleton rows={2} chart /></Widget>
        <Widget title="Pressure"><Skeleton rows={2} chart /></Widget>
      </section>
    </>
  );
}
