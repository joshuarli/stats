import { createEffect, createMemo, createSignal, Errored, For, isPending, latest, Loading, onCleanup, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { LIMITS, loadLimits } from "../health";
import { age, bytes, count, errorMessage, isFiniteNumber, percent, rate } from "../format";
import { alignTracks, sumTracks, worstTrack } from "../chart-data";
import { cpuUsed, lastCell, lastValue, memoryUsed, sumLatest, usedShare } from "../metrics";
import { createRefreshRetention, loadFleetRows, type FleetRow, type FleetRowCache } from "../queries";
import { statusFor, type HostStatus } from "../status";
import { useTelemetry } from "../state";
import type { Host } from "../api";
import { EmptyState, Icon, Meter, Pagination, Skeleton } from "@laputa-systems/ui-dashboard";
import { Sparkline } from "../components/Sparkline";
import { OsLogo } from "../components/OsLogo";
import { EntityCell, ErrorState, Notice, Widget } from "../components/ui";
import { osFamily } from "../os";
import { createUpdateEffect } from "../effect";
import { compareSortValues, createSort, SortHeader, type Sort } from "../components/sort";
import { hostStatusFilters as statusLabels, restoreListFocus, type HostSortKey as SortKey, type HostStatusFilter as StatusLabel } from "../list-state";
import { routeWithRange } from "../urlState";

const PAGE_SIZE = 10;
const statusRank: Record<HostStatus["label"], number> = { online: 0, stale: 1, "no samples": 2, unknown: 3, revoked: 4 };
const METRIC_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(["cpu", "memory", "load", "diskSpace", "diskIO", "network"]);

function isStatusLabel(label: string): label is StatusLabel {
  return (statusLabels as readonly string[]).includes(label);
}

function hostStatus(host: Host): HostStatus {
  return statusFor(host, host.lastReceivedAtMs);
}

function fleetDiskSpace(row: FleetRow): number | undefined {
  const trend = worstTrack(row.filesystems.map(entry => ({ times: entry.table.times, values: usedShare(entry.table) })), row.filesystemStepMs);
  return lastValue(trend.values);
}

function metricValue(row: FleetRow, key: SortKey): number | null {
  switch (key) {
    case "cpu": return lastCell(cpuUsed(row.summary)) ?? null;
    case "memory": return lastCell(memoryUsed(row.summary)) ?? null;
    case "load": return lastCell(row.summary.cells("load.one")) ?? null;
    case "diskSpace": return fleetDiskSpace(row) ?? null;
    case "diskIO": return sumLatest(row.disks, entry => entry.table.cells("readBytesPerSec")) ?? null;
    case "network": return sumLatest(row.nets, entry => entry.table.cells("rxBytesPerSec")) ?? null;
    case "name":
    case "status": return null;
  }
}

function compareHosts(sort: Sort<SortKey>, metricRows: ReadonlyMap<string, FleetRow>): (left: Host, right: Host) => number {
  return (left, right) => {
    const byName = left.name.localeCompare(right.name);
    const key = sort.key;
    if (METRIC_KEYS.has(key)) {
      const leftRow = metricRows.get(left.hostId);
      const rightRow = metricRows.get(right.hostId);
      const leftValue = leftRow === undefined ? null : metricValue(leftRow, key);
      const rightValue = rightRow === undefined ? null : metricValue(rightRow, key);
      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) return byName;
        return leftValue === null ? 1 : -1;
      }
      return compareSortValues(leftValue, rightValue) * sort.direction || byName;
    }
    const result = key === "name"
      ? byName
      : statusRank[hostStatus(left).label] - statusRank[hostStatus(right).label] || byName;
    return result * sort.direction;
  };
}

export function FleetPage(): JSX.Element {
  const { query, hosts, now, refreshHosts, tick, manualTick, lists } = useTelemetry();
  const [search, setSearch] = createSignal(lists.fleet.search);
  const [selected, setSelected] = createSignal(lists.fleet.selected);
  const { sort, sortBy } = createSort(lists.fleet.sort);
  const [page, setPage] = createSignal(lists.fleet.page);
  let returnHost = lists.fleet.returnHost;
  lists.fleet.returnHost = null;
  onCleanup(() => {
    lists.fleet.search = search();
    lists.fleet.selected = selected();
    lists.fleet.sort = sort();
    lists.fleet.page = currentPage();
  });
  const onHostMount = (id: string, link: HTMLAnchorElement) => {
    if (returnHost !== id) return;
    returnHost = null;
    restoreListFocus(link);
  };
  const [refreshError, setRefreshError] = createSignal<string | null>(null);
  const [rowsEpoch, setRowsEpoch] = createSignal(0);
  const rowCache: FleetRowCache = {
    systems: new Map(),
    histories: new Map()
  };

  const matching = createMemo(() => {
    const text = search().trim().toLowerCase();
    const chosen = selected();
    return hosts().filter(host => {
      const label = hostStatus(host).label;
      const matchesStatus = chosen.size === 0 || (isStatusLabel(label) && chosen.has(label));
      return matchesStatus && (text.length === 0 || host.name.toLowerCase().includes(text) || host.hostId.includes(text));
    });
  });

  const rowsRetention = createRefreshRetention();
  const [metricRows, setMetricRows] = createSignal<readonly FleetRow[]>([]);
  createEffect(
    () => ({ key: sort().key, hosts: matching(), query: query(), epoch: rowsEpoch() }),
    ({ key, hosts, query: queryKey }) => {
      if (!METRIC_KEYS.has(key)) {
        setMetricRows([]);
        return;
      }
      void loadFleetRows(hosts, queryKey, { previous: metricRows(), retention: rowsRetention, onError: error => setRefreshError(error === null ? null : errorMessage(error)) }, rowCache)
        .then(rows => setMetricRows(rows))
        .catch(() => {});
    }
  );

  const sorted = createMemo(() => {
    const rowsByKey = new Map<string, FleetRow>();
    if (METRIC_KEYS.has(sort().key)) for (const row of metricRows()) rowsByKey.set(row.host.hostId, row);
    return [...matching()].sort(compareHosts(sort(), rowsByKey));
  });

  const pages = createMemo(() => Math.max(1, Math.ceil(sorted().length / PAGE_SIZE)));
  const currentPage = createMemo(() => Math.min(page(), pages()));
  const pageHosts = createMemo(() => sorted().slice((currentPage() - 1) * PAGE_SIZE, currentPage() * PAGE_SIZE));
  const rows = createMemo<readonly FleetRow[]>(previous =>
    loadFleetRows(
      pageHosts(),
      query(),
      { previous, retention: rowsRetention, onError: error => setRefreshError(error === null ? null : errorMessage(error)) },
      rowCache
    )
  );

  let lastManualTick = manualTick();
  const doRefresh = async (includeSystem: boolean) => {
    setRefreshError(null);
    rowCache.histories.clear();
    if (includeSystem) rowCache.systems.clear();
    setRowsEpoch(value => value + 1);
    try {
      await Promise.all([refreshHosts(), refresh(rows)]);
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
  };
  createUpdateEffect(() => tick(), () => {
    const manual = manualTick();
    const includeSystem = manual !== lastManualTick;
    lastManualTick = manual;
    void doRefresh(includeSystem);
  });

  const counts = createMemo(() => {
    const all = hosts();
    const byLabel = (label: StatusLabel) => all.filter(host => hostStatus(host).label === label).length;
    return { all: all.length, online: byLabel("online"), stale: byLabel("stale"), noSamples: byLabel("no samples"), revoked: byLabel("revoked") };
  });

  const toggle = (label: StatusLabel) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
    setPage(1);
  };

  return (
    <>
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>
      <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
        <Loading fallback={<FleetSkeleton />}>
          <FleetDashboard
            rows={rows()}
            total={sorted().length}
            allTotal={counts().all}
            counts={counts()}
            selected={selected()}
            toggle={toggle}
            search={latest(search)}
            setSearch={value => { setSearch(value); setPage(1); }}
            clearFilters={() => { setSearch(""); setSelected(new Set<StatusLabel>()); setPage(1); }}
            sort={sort()}
            sortBy={sortBy}
            page={Math.min(latest(page), pages())}
            pages={pages()}
            setPage={setPage}
            now={now()}
            pending={isPending(rows)}
            onHostNavigate={id => { lists.fleet.returnHost = id; }}
            onHostMount={onHostMount}
          />
        </Loading>
      </Errored>
    </>
  );
}

function StatusChips(props: {
  readonly counts: { readonly online: number; readonly stale: number; readonly noSamples: number; readonly revoked: number };
  readonly selected: ReadonlySet<StatusLabel>;
  readonly toggle: (label: StatusLabel) => void;
}): JSX.Element {
  const entries = () => [
    { label: "online" as const, count: props.counts.online, tone: "ok" },
    { label: "stale" as const, count: props.counts.stale, tone: "warn" },
    { label: "no samples" as const, count: props.counts.noSamples, tone: "neutral" },
    { label: "revoked" as const, count: props.counts.revoked, tone: "bad" }
  ].filter(entry => entry.count > 0 || entry.label === "online" || entry.label === "revoked" || props.selected.has(entry.label));
  return (
    <div class="chips" role="group" aria-label="Filter by status">
      <For each={entries()}>
        {(entry) => (
          <button class="chip" type="button" aria-pressed={props.selected.has(entry.label) ? "true" : "false"} onClick={() => props.toggle(entry.label)}>
            <span class={`status-dot tone-${entry.tone}`} aria-hidden="true" />
            {entry.label}
            <span class="chip-count">{entry.count}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function FleetDashboard(props: {
  readonly rows: readonly FleetRow[];
  readonly total: number;
  readonly allTotal: number;
  readonly counts: { readonly online: number; readonly stale: number; readonly noSamples: number; readonly revoked: number };
  readonly selected: ReadonlySet<StatusLabel>;
  readonly toggle: (label: StatusLabel) => void;
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly clearFilters: () => void;
  readonly sort: Sort<SortKey>;
  readonly sortBy: (key: SortKey) => void;
  readonly page: number;
  readonly pages: number;
  readonly setPage: (value: number) => void;
  readonly now: number;
  readonly pending: boolean;
  readonly onHostNavigate: (id: string) => void;
  readonly onHostMount: (id: string, link: HTMLAnchorElement) => void;
}): JSX.Element {
  const from = () => props.total === 0 ? 0 : (props.page - 1) * PAGE_SIZE + 1;
  const to = () => Math.min(props.total, props.page * PAGE_SIZE);
  return (
    <>
      <Widget
        title="Hosts"
        class={props.pending ? "widget-pending" : undefined}
        bodyClass="flush"
      >
        <div class="table-toolbar">
          <StatusChips counts={props.counts} selected={props.selected} toggle={props.toggle} />
          <label class="search">
            <span class="ui-sr-only">Search hosts</span>
            <span class="search-icon"><Icon name="search" size={13} /></span>
            <input type="search" placeholder="Filter hosts" value={props.search} onInput={event => props.setSearch(event.currentTarget.value)} />
          </label>
        </div>
        <Show
          when={props.rows.length > 0}
          fallback={
            <EmptyState
              title={props.allTotal === 0 ? "No telemetry hosts are provisioned." : "No hosts match this view."}
              detail={props.allTotal === 0 ? "Provision a host through the admin API to start collecting counters." : "Clear the search or choose another status filter."}
              icon="host"
              action={props.allTotal === 0 ? undefined : <button class="btn" type="button" onClick={props.clearFilters}>Clear filters</button>}
            />
          }
        >
          <div class="table-scroll fleet-table-scroll" role="region" aria-label="Fleet hosts table">
            <table class="data-table" aria-label="Fleet hosts">
              <thead>
                <tr>
                  <SortHeader label="Host" sortKey="name" sort={props.sort} onSort={props.sortBy} />
                  <SortHeader label="CPU" sortKey="cpu" sort={props.sort} onSort={props.sortBy} />
                  <SortHeader label="Memory" sortKey="memory" sort={props.sort} onSort={props.sortBy} />
                  <SortHeader label="Load 1m / 5m / 15m" sortKey="load" sort={props.sort} onSort={props.sortBy} />
                  <SortHeader label="Disk space" sortKey="diskSpace" sort={props.sort} onSort={props.sortBy} />
                  <SortHeader label="Disk read / write" sortKey="diskIO" sort={props.sort} onSort={props.sortBy} />
                  <SortHeader label="Network in / out" sortKey="network" sort={props.sort} onSort={props.sortBy} />
                </tr>
              </thead>
              <tbody>
                <For each={props.rows}>
                  {(row) => <FleetTableRow row={row} now={props.now} onNavigate={props.onHostNavigate} onMount={props.onHostMount} />}
                </For>
              </tbody>
            </table>
          </div>
          <Pagination page={props.page} pages={props.pages} from={from()} to={to()} total={props.total} onChange={props.setPage} />
        </Show>
      </Widget>
    </>
  );
}

function FleetTableRow(props: { readonly row: FleetRow; readonly now: number; readonly onNavigate: (id: string) => void; readonly onMount: (id: string, link: HTMLAnchorElement) => void }): JSX.Element {
  const { range } = useTelemetry();
  const table = () => props.row.summary;
  const timeWindow = createMemo(() => ({ fromMs: props.row.fromMs, toMs: props.row.toMs }));
  const status = createMemo(() => hostStatus(props.row.host));
  const info = createMemo(() => props.row.system?.system);
  const cpuTrend = createMemo(() => cpuUsed(table()));
  const memoryTrend = createMemo(() => memoryUsed(table()));
  const loadTrend = createMemo(() => [table().cells("load.one"), table().cells("load.five"), table().cells("load.fifteen")]);
  const cpu = createMemo(() => lastCell(cpuTrend()));
  const memory = createMemo(() => lastCell(memoryTrend()));
  const free = createMemo(() => lastCell(table().cells("mem.available")));
  const total = createMemo(() => lastCell(table().cells("mem.total")));
  const cpuCount = createMemo(() => lastCell(table().cells("cpuCount")));
  const diskRead = createMemo(() => sumLatest(props.row.disks, entry => entry.table.cells("readBytesPerSec")));
  const diskWrite = createMemo(() => sumLatest(props.row.disks, entry => entry.table.cells("writeBytesPerSec")));
  const netIn = createMemo(() => sumLatest(props.row.nets, entry => entry.table.cells("rxBytesPerSec")));
  const netOut = createMemo(() => sumLatest(props.row.nets, entry => entry.table.cells("txBytesPerSec")));
  const diskTrend = createMemo(() => alignTracks([
    sumTracks(props.row.disks.map(entry => entry.table.track("readBytesPerSec"))),
    sumTracks(props.row.disks.map(entry => entry.table.track("writeBytesPerSec")))
  ]));
  const netTrend = createMemo(() => alignTracks([
    sumTracks(props.row.nets.map(entry => entry.table.track("rxBytesPerSec"))),
    sumTracks(props.row.nets.map(entry => entry.table.track("txBytesPerSec")))
  ]));
  const diskSpaceTrend = createMemo(() => worstTrack(props.row.filesystems.map(entry => ({ times: entry.table.times, values: usedShare(entry.table) })), props.row.filesystemStepMs));
  const diskSpace = createMemo(() => lastValue(diskSpaceTrend().values));
  const diskSpaceUsage = createMemo(() => {
    let worst: { readonly share: number; readonly usedBytes: number; readonly totalBytes: number } | undefined;
    for (const entry of props.row.filesystems) {
      const shares = usedShare(entry.table);
      for (let row = shares.length - 1; row >= 0; row -= 1) {
        const share = shares[row];
        const total = entry.table.at("total", row);
        const available = entry.table.at("available", row);
        if (!isFiniteNumber(share) || !isFiniteNumber(total) || !isFiniteNumber(available)) continue;
        if (worst === undefined || share > worst.share) worst = { share, usedBytes: Math.max(0, total - available), totalBytes: total };
        break;
      }
    }
    return worst;
  });
  const diskSpaceNote = createMemo(() => {
    const usage = diskSpaceUsage();
    return usage === undefined ? "unavailable" : `${bytes(usage.usedBytes)} used of ${bytes(usage.totalBytes)}`;
  });
  const cpuNote = createMemo(() => {
    const cores = info()?.cpu.cores ?? cpuCount();
    const threads = info()?.cpu.threads;
    return [
      cores === undefined ? undefined : `${count(cores)} cores`,
      threads === undefined || threads === cores ? undefined : `${count(threads)} threads`
    ].filter((part): part is string => part !== undefined).join(" · ");
  });
  const cpuModel = createMemo(() => info()?.cpu.model);
  const osNote = createMemo(() => {
    const system = info();
    if (system === undefined) return undefined;
    const parts = [system.os, system.kernel.length === 0 ? undefined : `kernel ${system.kernel}`].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(" · ");
  });
  const reporting = () => status().label === "online";
  return (
    <tr>
      <td>
        <EntityCell
          marker={
            <span class="host-mark">
              <Show when={osFamily(info()?.os)} fallback={<span class="host-mark-empty"><Icon name="host" size={13} /></span>}>
                <OsLogo os={info()?.os} size={14} tile />
              </Show>
              <span class={`status-dot marker-status tone-${status().tone}`} role="img" aria-label={status().label} title={status().label} />
            </span>
          }
          name={props.row.host.name}
          href={routeWithRange(`#/host/${props.row.host.hostId}`, range())}
          id={props.row.host.hostId}
          note={osNote()}
          onNavigate={() => props.onNavigate(props.row.host.hostId)}
          onLinkMount={link => props.onMount(props.row.host.hostId, link)}
        />
        <Show when={cpuModel()}>
          {(model) => <span class="cell-note wrap-note">{model()}</span>}
        </Show>
        <Show when={!reporting()}>
          <span class="cell-note">{age(props.row.host.lastReceivedAtMs, props.now)}</span>
        </Show>
      </td>
      <td>
        <div class="cell-stack">
          <div class="cpu-cell">
            <span class="metric-value-small">{percent(cpu())}</span>
            <Meter value={cpu()} warn={LIMITS.cpuPercent.elevated} bad={LIMITS.cpuPercent.critical} />
            <Sparkline series={[{ values: cpuTrend() }]} times={table().times} window={timeWindow()} label={`${props.row.host.name} CPU trend`} class="spark-inline" limits={LIMITS.cpuPercent} />
          </div>
          <Show when={cpuNote()}>
            {(note) => <span class="cell-note">{note()}</span>}
          </Show>
        </div>
      </td>
      <td>
        <div class="cell-stack">
          <div class="cpu-cell">
            <span class="metric-value-small">{percent(memory())}</span>
            <Meter value={memory()} warn={LIMITS.memoryUsedPercent.elevated} bad={LIMITS.memoryUsedPercent.critical} />
            <Sparkline series={[{ values: memoryTrend() }]} times={table().times} window={timeWindow()} label={`${props.row.host.name} memory trend`} class="spark-inline" limits={LIMITS.memoryUsedPercent} />
          </div>
          <span class="cell-note">{free() === undefined || total() === undefined ? "unavailable" : `${bytes(free())} free of ${bytes(total())}`}</span>
        </div>
      </td>
      <td>
        <div class="cpu-cell">
          <span><span class="cell-strong">{count(lastCell(table().cells("load.one")))}</span><span class="cell-note"> / {count(lastCell(table().cells("load.five")))} / {count(lastCell(table().cells("load.fifteen")))}</span></span>
          <Sparkline
            series={[
              { values: loadTrend()[0]!, class: "viz-ramp-5" },
              { values: loadTrend()[1]!, class: "viz-ramp-3" },
              { values: loadTrend()[2]!, class: "viz-ramp-1" }
            ]}
            times={table().times}
            window={timeWindow()}
            label={`${props.row.host.name} load trend`}
            class="spark-inline"
            limits={loadLimits(cpuCount())}
          />
        </div>
      </td>
      <td>
        <div class="cell-stack">
          <div class="cpu-cell">
            <span class="metric-value-small">{percent(diskSpace())}</span>
            <Meter value={diskSpace()} warn={LIMITS.filesystemUsedPercent.elevated} bad={LIMITS.filesystemUsedPercent.critical} />
            <Sparkline series={[{ values: diskSpaceTrend().values }]} times={diskSpaceTrend().times} window={timeWindow()} label={`${props.row.host.name} disk space trend`} class="spark-inline" limits={LIMITS.filesystemUsedPercent} />
          </div>
          <span class="cell-note">{diskSpaceNote()}</span>
        </div>
      </td>
      <td>
        <div class="cpu-cell">
          <span><span class="cell-strong">{rate(diskRead())}</span><span class="cell-note"> / {rate(diskWrite())}</span></span>
          <Sparkline
            series={[
              { values: diskTrend().columns[0]!, class: "viz-blue" },
              { values: diskTrend().columns[1]!, class: "viz-aqua", mirror: true }
            ]}
            times={diskTrend().times}
            window={timeWindow()}
            zeroBased
            label={`${props.row.host.name} disk throughput trend`}
            class="spark-inline"
          />
        </div>
      </td>
      <td>
        <div class="cpu-cell">
          <span><span class="cell-strong">{rate(netIn())}</span><span class="cell-note"> / {rate(netOut())}</span></span>
          <Sparkline
            series={[
              { values: netTrend().columns[0]!, class: "viz-blue" },
              { values: netTrend().columns[1]!, class: "viz-aqua", mirror: true }
            ]}
            times={netTrend().times}
            window={timeWindow()}
            zeroBased
            label={`${props.row.host.name} network throughput trend`}
            class="spark-inline"
          />
        </div>
      </td>
    </tr>
  );
}

function FleetSkeleton(): JSX.Element {
  return (
    <>
      <Widget title="Hosts">
        <Skeleton rows={7} />
      </Widget>
    </>
  );
}
