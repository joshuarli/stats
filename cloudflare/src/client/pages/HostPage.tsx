import { createEffect, createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { ApiFailure, getBlock, getDisks, getFilesystems, getNets, getSummary, getSystem, type Host, type SummaryPoint } from "../api";
import { errorMessage } from "../format";
import { RANGE_MS } from "../../limits";
import { loadQuery } from "../queries";
import { statusFor } from "../status";
import { useTelemetry } from "../state";
import { PageHeader } from "../components/PageHeader";
import { Badge, EmptyState, ErrorState, Notice, Skeleton, Widget } from "../components/ui";
import { BlockCompletionsWidget, BlockWidget } from "./host/Block";
import { ComputeWidgets } from "./host/Compute";
import { DiskWidget } from "./host/Disk";
import { FilesystemsWidget } from "./host/Filesystems";
import { MemoryWidget } from "./host/Memory";
import { buildCells } from "./host/monitors";
import { NetworkWidget } from "./host/Network";
import { rebootEvents } from "./host/shared";
import { IncidentTimeline, StatusStrip } from "./host/Status";
import { SystemPanel } from "./host/System";

const DAY_MS = 86_400_000;
const GHOST_RANGES: ReadonlySet<string> = new Set(["1h", "6h", "24h"]);
const GHOST_REFRESH_TICKS = 20;
const LONG_REFRESH_TICKS = 40;

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
  const summary = createMemo(() => loadQuery(signal => getSummary(hostId(), query(), signal)));
  const disks = createMemo(() => loadQuery(signal => getDisks(hostId(), query(), signal)));
  const nets = createMemo(() => loadQuery(signal => getNets(hostId(), query(), signal)));
  const filesystems = createMemo(() => loadQuery(signal => getFilesystems(hostId(), query(), signal)));
  const block = createMemo(() => loadQuery(signal => getBlock(hostId(), query(), signal)));

  const week = createMemo(() => {
    void Math.floor(tick() / LONG_REFRESH_TICKS);
    return loadQuery(async signal => {
      try {
        return (await getFilesystems(hostId(), { range: "7d" }, signal)).series ?? [];
      } catch (error) {
        if (signal.aborted) throw error;
        console.error("filesystem history for the forecast could not be loaded", error);
        return null;
      }
    });
  });

  const yesterday = createMemo((): Promise<readonly SummaryPoint[] | null> => {
    void Math.floor(tick() / GHOST_REFRESH_TICKS);
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

  const doRefresh = async () => {
    setRefreshError(null);
    try {
      await Promise.all([refreshHosts(), refresh(summary), refresh(disks), refresh(nets), refresh(filesystems), refresh(block)]);
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
        titleExtra={<Badge tone={status().tone} dot>{status().label}</Badge>}
        hint="Drag a chart to zoom · double-click to reset · click a legend row to isolate"
      >
      </PageHeader>
      <Errored fallback={(error) => <ErrorState error={error()} compact />}>
        <Loading fallback={<Widget title="System"><Skeleton rows={2} /></Widget>}>
          <SystemPanel system={system()} memoryBytes={summary().points?.at(-1)?.mem?.total} />
        </Loading>
      </Errored>
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>

      <Errored fallback={(error) => <ErrorState error={error()} compact />}>
        <Loading fallback={<SummarySkeleton />}>
          <Show when={(summary().points ?? []).length > 0}>
            <StatusStrip cells={cells()} />
            <IncidentTimeline cells={cells()} />
          </Show>
          <ComputeWidgets points={summary().points ?? []} yesterday={yesterday()} stepMs={summary().stepMs} events={events()} />
          <section class="stack" aria-label="Host activity">
            <MemoryWidget points={summary().points ?? []} stepMs={summary().stepMs} events={events()} />
            <DiskWidget series={disks().series ?? []} stepMs={disks().stepMs} events={events()} />
            <NetworkWidget series={nets().series ?? []} stepMs={nets().stepMs} events={events()} />
            <FilesystemsWidget series={filesystems().series ?? []} stepMs={filesystems().stepMs} longSeries={week()} events={events()} />
            <section class="chart-grid" aria-label="Block latency">
              <BlockWidget series={block().series ?? []} stepMs={block().stepMs} events={events()} />
              <BlockCompletionsWidget series={block().series ?? []} stepMs={block().stepMs} events={events()} />
            </section>
          </section>
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
        <For each={[0, 1, 2, 3, 4, 5]}>{() => <div class="status-cell"><Skeleton rows={2} /></div>}</For>
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
