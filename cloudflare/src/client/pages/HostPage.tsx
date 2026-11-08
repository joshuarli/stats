import { createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import type { HostHistories } from "../history";
import { getHostHistories, getSystem, type Host } from "../api";
import { lastCell } from "../metrics";
import { errorMessage } from "../format";
import { createUpdateEffect } from "../effect";
import { createRefreshRetention, loadQuery } from "../queries";
import { windowParams } from "../history-path";
import { statusFor } from "../status";
import { useTelemetry } from "../state";
import { OsLogo } from "../components/OsLogo";
import { PageHeader } from "@laputa-systems/ui-dashboard";
import { SectionBar, type SectionLink } from "../components/SectionBar";
import { Badge, EmptyState, ErrorState, Notice, Skeleton, Widget } from "../components/ui";
import { BlockCompletionsWidget, BlockWidget } from "./host/Block";
import { CpuWidget, LoadWidget, PressureNotice, reportsPressure } from "./host/Compute";
import { DiskWidget } from "./host/Disk";
import { FilesystemsWidget } from "./host/Filesystems";
import { MemoryWidget } from "./host/Memory";
import { buildCells } from "./host/monitors";
import { NetworkWidget } from "./host/Network";
import { PowerWidget, reportsPower } from "./host/Power";
import { PsiWindowBar } from "./host/Psi";
import type { PsiWindow } from "../psi";
import { rebootEvents } from "./host/shared";
import { StatusStrip } from "./host/Status";
import { SystemInfo } from "./host/System";

export function HostPage(): JSX.Element {
  const params = useParams();
  const { hosts } = useTelemetry();
  const hostId = () => params.hostId ?? "";
  const host = createMemo(() => hosts().find(candidate => candidate.hostId === hostId()));
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<HostSkeleton />}>
        <Show
          when={host()?.hostId}
          keyed
          fallback={
            <EmptyState
              icon="host"
              title="Host not found"
              detail="The host id is not in this installation, or the directory changed."
              action={<a class="btn" href="#/">Back to hosts</a>}
            />
          }
        >
          {id => <HostView host={hosts().find(candidate => candidate.hostId === id)!} />}
        </Show>
      </Loading>
    </Errored>
  );
}

function HostView(props: { readonly host: Host }): JSX.Element {
  const hostId = () => props.host.hostId;
  const { query, view, refreshHosts, tick } = useTelemetry();
  const [refreshError, setRefreshError] = createSignal<string | null>(null);
  const [psiWindow, setPsiWindow] = createSignal<PsiWindow>("300");

  const system = createMemo(() => loadQuery(signal => getSystem(hostId(), signal)));
  const retention = createRefreshRetention();
  const histories = createMemo<HostHistories>(previous =>
    loadQuery(
      signal => getHostHistories(hostId(), query(), signal),
      { key: `${hostId()}|${windowParams(query())}`, previous, retention, onError: error => setRefreshError(error === null ? null : errorMessage(error)) }
    )
  );
  const summary = () => histories().summary;
  const disks = () => histories().disks;
  const nets = () => histories().nets;
  const filesystems = () => histories().filesystems;
  const block = () => histories().block;

  const status = createMemo(() => statusFor(props.host, props.host.lastReceivedAtMs));
  const table = () => summary().table;
  const events = createMemo(() => rebootEvents(table()));
  const reportsBlock = createMemo(() => block().series.some(entry => entry.table.rows > 0));

  const doRefresh = async () => {
    setRefreshError(null);
    try {
      await Promise.all([refreshHosts(), refresh(histories)]);
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
  };
  createUpdateEffect(() => tick(), () => { void doRefresh(); });

  const moreSections = (): SectionLink[] => [
    ...(reportsPower(table()) ? [{ label: "Power", anchor: "power" }] : []),
    ...(reportsBlock() ? [{ label: "Block latency", anchor: "block" }, { label: "Block completions", anchor: "block-completions" }] : [])
  ];
  const cells = createMemo(() => buildCells({ summary: summary(), disks: disks(), nets: nets(), filesystems: filesystems() }, view(), psiWindow()));

  return (
    <>
      <PageHeader
        title={props.host.name}
        mark={
          <Errored fallback={null}>
            <Loading fallback={<span class="os-logo-tile" aria-hidden="true" />}>
              <Show when={system()?.system.os}>
                {(os) => <OsLogo os={os()} size={17} tile labelled />}
              </Show>
            </Loading>
          </Errored>
        }
        titleExtra={
          <>
            <Badge tone={status().tone} dot>{status().label}</Badge>
            <Errored fallback={null}>
              <Loading fallback={null}>
                <SystemInfo system={system()} memoryBytes={() => lastCell(table().cells("mem.total"))} uptimeMs={() => lastCell(table().cells("uptimeMs"))} />
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
            when={table().rows > 0}
            fallback={
              <Widget title="Samples">
                <EmptyState title="No samples were accepted in this range." detail="Gaps are not interpolated and missing values never become zero." icon="activity" />
              </Widget>
            }
          >
            <StatusStrip cells={cells()} class="dense" />
            <SectionBar cells={cells()} more={moreSections()} />
            <Show when={table().cells("partial").some(value => value === 1)}>
              <Notice tone="warn">Some buckets are partial; gaps are not interpolated.</Notice>
            </Show>
            <PressureNotice table={table()} />
            <Show when={reportsPressure(table())}>
              <PsiWindowBar value={psiWindow()} onChange={setPsiWindow} />
            </Show>
            <section class="charts host" aria-label="Charts">
              <CpuWidget table={table()} stepMs={summary().stepMs} events={events()} psiWindow={psiWindow()} />
              <LoadWidget table={table()} stepMs={summary().stepMs} events={events()} />
              <MemoryWidget table={table()} stepMs={summary().stepMs} events={events()} psiWindow={psiWindow()} />
              <Show when={reportsPower(table())}>
                <PowerWidget table={table()} stepMs={summary().stepMs} events={events()} />
              </Show>
              <FilesystemsWidget series={filesystems().series} stepMs={filesystems().stepMs} events={events()} />
              <NetworkWidget series={nets().series} stepMs={nets().stepMs} events={events()} />
              <DiskWidget series={disks().series} stepMs={disks().stepMs} summary={table()} summaryStepMs={summary().stepMs} events={events()} psiWindow={psiWindow()} />
              <Show when={reportsBlock()} fallback={<Notice>Block latency is not reported: the optional eBPF probe is not configured on this host (see bpf/README.md).</Notice>}>
                <BlockWidget series={block().series} stepMs={block().stepMs} events={events()} />
                <BlockCompletionsWidget series={block().series} stepMs={block().stepMs} events={events()} />
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
