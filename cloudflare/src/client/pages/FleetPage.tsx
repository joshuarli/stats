import { createEffect, createMemo, createSignal, Errored, For, isPending, latest, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { pointsIn } from "../chart-data";
import { age, bytes, count, errorMessage, percent, rate } from "../format";
import { cpuUsed, latestPoint, loadOne, memoryFree, memoryTotal, memoryUsed, psiCpu, sparkPoints, sumLatest, sumSeries } from "../metrics";
import { loadFleetRows, type FleetRow } from "../queries";
import { statusFor, type HostStatus } from "../status";
import { useTelemetry } from "../state";
import type { Host } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { Sparkline } from "../components/Sparkline";
import { TimeChart } from "../components/TimeChart";
import { Badge, EmptyState, ErrorState, Meter, Notice, Pagination, Skeleton, Widget } from "../components/ui";

const PAGE_SIZE = 10;
const PALETTE_SIZE = 8;
const facetLabels = ["online", "stale", "no samples", "revoked"] as const;
type FacetLabel = (typeof facetLabels)[number];
const statusRank: Record<HostStatus["label"], number> = { online: 0, stale: 1, "no samples": 2, unknown: 3, revoked: 4 };
type SortKey = "name" | "status" | "seen";
interface Sort { readonly key: SortKey; readonly direction: 1 | -1 }

function isFacetLabel(label: string): label is FacetLabel {
  return (facetLabels as readonly string[]).includes(label);
}

function hostStatus(host: Host): HostStatus {
  return statusFor(host, host.lastReceivedAtMs);
}

function compareHosts(sort: Sort): (left: Host, right: Host) => number {
  return (left, right) => {
    const byName = left.name.localeCompare(right.name);
    const result = sort.key === "name"
      ? byName
      : sort.key === "status"
        ? statusRank[hostStatus(left).label] - statusRank[hostStatus(right).label] || byName
        : (right.lastReceivedAtMs ?? 0) - (left.lastReceivedAtMs ?? 0);
    return result * sort.direction;
  };
}

export function FleetPage(): JSX.Element {
  const { query, hosts, now, refreshHosts, tick, view } = useTelemetry();
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<ReadonlySet<FacetLabel>>(new Set<FacetLabel>());
  const [sort, setSort] = createSignal<Sort>({ key: "status", direction: 1 });
  const [page, setPage] = createSignal(1);
  const [hover, setHover] = createSignal<string | null>(null);
  const [refreshError, setRefreshError] = createSignal<string | null>(null);

  const filtered = createMemo(() => {
    const text = search().trim().toLowerCase();
    const chosen = selected();
    const matching = hosts().filter(host => {
      const label = hostStatus(host).label;
      const matchesStatus = chosen.size === 0 || (isFacetLabel(label) && chosen.has(label));
      return matchesStatus && (text.length === 0 || host.name.toLowerCase().includes(text) || host.hostId.includes(text));
    });
    return matching.sort(compareHosts(sort()));
  });

  const pages = createMemo(() => Math.max(1, Math.ceil(filtered().length / PAGE_SIZE)));
  const currentPage = createMemo(() => Math.min(page(), pages()));
  const pageHosts = createMemo(() => filtered().slice((currentPage() - 1) * PAGE_SIZE, currentPage() * PAGE_SIZE));
  const rows = createMemo(() => loadFleetRows(pageHosts(), query()));

  const doRefresh = async () => {
    setRefreshError(null);
    try {
      await Promise.all([refreshHosts(), refresh(rows)]);
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
  };
  createEffect(() => tick(), () => { void doRefresh(); }, { defer: true });

  const counts = createMemo(() => {
    const all = hosts();
    const byLabel = (label: FacetLabel) => all.filter(host => hostStatus(host).label === label).length;
    return { all: all.length, online: byLabel("online"), stale: byLabel("stale"), noSamples: byLabel("no samples"), revoked: byLabel("revoked") };
  });

  const toggle = (label: FacetLabel) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
    setPage(1);
  };

  const sortBy = (key: SortKey) => setSort(current => ({ key, direction: current.key === key ? (current.direction === 1 ? -1 : 1) : 1 }));
  const colorOf = (host: Host) => Math.max(0, hosts().findIndex(candidate => candidate.hostId === host.hostId)) % PALETTE_SIZE;

  return (
    <>
      <PageHeader title="Hosts" hint="Drag a chart to zoom · double-click to reset · hover a row to isolate its line">
        <span class="page-sub">
          {counts().all} provisioned · {counts().online} reporting · {counts().stale + counts().noSamples} stale · {counts().revoked} revoked
        </span>
      </PageHeader>
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>
      <div class="fleet-layout">
        <Facets counts={counts()} selected={selected()} toggle={toggle} clear={() => { setSelected(new Set<FacetLabel>()); setPage(1); }} />
        <div class="fleet-main">
          <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
            <Loading fallback={<FleetSkeleton />}>
              <FleetDashboard
                rows={rows()}
                colorOf={colorOf}
                total={filtered().length}
                allTotal={counts().all}
                search={latest(search)}
                setSearch={value => { setSearch(value); setPage(1); }}
                clearFilters={() => { setSearch(""); setSelected(new Set<FacetLabel>()); setPage(1); }}
                sort={sort()}
                sortBy={sortBy}
                page={Math.min(latest(page), pages())}
                pages={pages()}
                setPage={setPage}
                now={now()}
                pending={isPending(rows)}
                hover={hover()}
                setHover={setHover}
                windowed={view() !== null}
              />
            </Loading>
          </Errored>
        </div>
      </div>
    </>
  );
}

function Facets(props: {
  readonly counts: { readonly online: number; readonly stale: number; readonly noSamples: number; readonly revoked: number };
  readonly selected: ReadonlySet<FacetLabel>;
  readonly toggle: (label: FacetLabel) => void;
  readonly clear: () => void;
}): JSX.Element {
  const entries = () => [
    { label: "online" as const, count: props.counts.online, tone: "ok" },
    { label: "stale" as const, count: props.counts.stale, tone: "warn" },
    { label: "no samples" as const, count: props.counts.noSamples, tone: "neutral" },
    { label: "revoked" as const, count: props.counts.revoked, tone: "bad" }
  ].filter(entry => entry.count > 0 || entry.label === "online" || entry.label === "revoked" || props.selected.has(entry.label));
  return (
    <aside class="facets" aria-label="Filters">
      <h2>Status</h2>
      <For each={entries()}>
        {(entry) => (
          <label class="facet">
            <input type="checkbox" checked={props.selected.has(entry.label)} onChange={() => props.toggle(entry.label)} />
            <span class="facet-box" aria-hidden="true" />
            <span class={`status-dot tone-${entry.tone}`} aria-hidden="true" />
            <span class="facet-name">{entry.label}</span>
            <span class="facet-count">{entry.count}</span>
          </label>
        )}
      </For>
      <Show when={props.selected.size > 0}>
        <button class="link-button" type="button" onClick={props.clear}>Clear filters</button>
      </Show>
    </aside>
  );
}

function FleetDashboard(props: {
  readonly rows: readonly FleetRow[];
  readonly colorOf: (host: Host) => number;
  readonly total: number;
  readonly allTotal: number;
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly clearFilters: () => void;
  readonly sort: Sort;
  readonly sortBy: (key: SortKey) => void;
  readonly page: number;
  readonly pages: number;
  readonly setPage: (value: number) => void;
  readonly now: number;
  readonly pending: boolean;
  readonly hover: string | null;
  readonly setHover: (value: string | null) => void;
  readonly windowed: boolean;
}): JSX.Element {
  const from = () => props.total === 0 ? 0 : (props.page - 1) * PAGE_SIZE + 1;
  const to = () => Math.min(props.total, props.page * PAGE_SIZE);
  const chartRows = createMemo(() => props.rows.filter(row => row.summary.length > 0));
  const stepMs = createMemo(() => Math.max(0, ...chartRows().map(row => row.stepMs)) || undefined);
  const header = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={props.sort.key === key ? (props.sort.direction === 1 ? "ascending" : "descending") : "none"}>
      <button class="sort-button" type="button" onClick={() => props.sortBy(key)}>
        {label}
        <Show when={props.sort.key === key}>
          <Icon name={props.sort.direction === 1 ? "sortUp" : "sortDown"} size={10} />
        </Show>
      </button>
    </th>
  );
  return (
    <>
      <section class="chart-grid" aria-label="Fleet charts">
        <Widget title="CPU utilization" subtitle="by host" expandable>
          <TimeChart
            label="CPU utilization"
            series={chartRows().map(row => ({ label: row.host.name, color: props.colorOf(row.host), points: row.summary.map(point => ({ atMs: point.atMs, value: cpuUsed(point) })) }))}
            stepMs={stepMs()}
            format={percent}
            min={0}
            max={100}
            threshold={{ value: 90, label: "alert 90%" }}
            highlight={props.hover}
            sortTooltip
          />
        </Widget>
        <Widget title="Network receive" subtitle="by host" expandable>
          <TimeChart
            label="Network receive"
            series={chartRows().map(row => ({ label: row.host.name, color: props.colorOf(row.host), points: sumSeries(row.nets, point => point.rxBytesPerSec) }))}
            stepMs={stepMs()}
            format={rate}
            min={0}
            highlight={props.hover}
            sortTooltip
          />
        </Widget>
      </section>

      <Widget
        title="Hosts"
        class={props.pending ? "widget-pending" : undefined}
        meta={<span class="widget-count">{count(props.total)} {props.total === 1 ? "host" : "hosts"}</span>}
        bodyClass="flush"
      >
        <div class="table-toolbar">
          <label class="search">
            <span class="sr-only">Search hosts</span>
            <span class="search-icon"><Icon name="search" size={13} /></span>
            <input type="search" placeholder="Filter hosts" value={props.search} onInput={event => props.setSearch(event.currentTarget.value)} />
          </label>
          <Show when={props.windowed}>
            <span class="table-note">Values at the end of the zoomed window</span>
          </Show>
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
          <div class="table-scroll">
            <table class="data-table" aria-label="Fleet hosts">
              <thead>
                <tr>
                  {header("name", "Host")}
                  {header("status", "Status")}
                  <th scope="col">CPU</th>
                  <th scope="col">Memory</th>
                  <th scope="col" class="numeric">Load 1m</th>
                  <th scope="col">Disk read / write</th>
                  <th scope="col">Network in / out</th>
                  <th scope="col" class="numeric">PSI some10</th>
                </tr>
              </thead>
              <tbody>
                <For each={props.rows}>
                  {(row) => <FleetTableRow row={row} now={props.now} color={props.colorOf(row.host)} setHover={props.setHover} />}
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

function FleetTableRow(props: { readonly row: FleetRow; readonly now: number; readonly color: number; readonly setHover: (value: string | null) => void }): JSX.Element {
  const { view } = useTelemetry();
  const windowed = createMemo(() => pointsIn(props.row.summary, view()));
  const last = createMemo(() => latestPoint(windowed()));
  const status = createMemo(() => hostStatus(props.row.host));
  const cpu = createMemo(() => cpuUsed(last()));
  const memory = createMemo(() => memoryUsed(last()));
  const free = createMemo(() => memoryFree(last()));
  const total = createMemo(() => memoryTotal(last()));
  const diskRead = createMemo(() => sumLatest(props.row.disks, point => point.readBytesPerSec));
  const diskWrite = createMemo(() => sumLatest(props.row.disks, point => point.writeBytesPerSec));
  const netIn = createMemo(() => sumLatest(props.row.nets, point => point.rxBytesPerSec));
  const netOut = createMemo(() => sumLatest(props.row.nets, point => point.txBytesPerSec));
  const trend = createMemo(() => sparkPoints(windowed(), cpuUsed));
  const reporting = () => status().label === "online";
  const clearHover = () => props.setHover(null);
  const hoverRow = () => props.setHover(props.row.host.name);
  return (
    <tr>
      <td>
        <div class="host-cell">
          <span class={reporting() ? `host-swatch series-${props.color}` : `status-dot tone-${status().tone}`} aria-hidden="true" />
          <div>
            <a class="host-name" href={`#/host/${props.row.host.hostId}`} onMouseEnter={hoverRow} onFocus={hoverRow} onMouseLeave={clearHover} onBlur={clearHover}>{props.row.host.name}</a>
            <span class="host-id" title={props.row.host.hostId}>{props.row.host.hostId}</span>
          </div>
        </div>
      </td>
      <td>
        <div class="status-cell">
          <Badge tone={status().tone} dot>{status().label}</Badge>
          <Show when={!reporting()}>
            <span class="cell-note">{age(props.row.host.lastReceivedAtMs, props.now)}</span>
          </Show>
        </div>
      </td>
      <td>
        <div class="cpu-cell">
          <span class="metric-value-small">{percent(cpu())}</span>
          <Meter value={cpu()} warn={75} bad={90} />
          <Sparkline points={trend()} label={`${props.row.host.name} CPU trend`} class="spark-inline" />
        </div>
      </td>
      <td>
        <div class="cell-stack">
          <div class="cpu-cell">
            <span class="metric-value-small">{percent(memory())}</span>
            <Meter value={memory()} warn={80} bad={92} />
          </div>
          <span class="cell-note">{free() === undefined || total() === undefined ? "unavailable" : `${bytes(free())} free of ${bytes(total())}`}</span>
        </div>
      </td>
      <td class="numeric"><span class="metric-value-small">{count(loadOne(last()))}</span></td>
      <td><span class="cell-strong">{rate(diskRead())}</span><span class="cell-note"> / {rate(diskWrite())}</span></td>
      <td><span class="cell-strong">{rate(netIn())}</span><span class="cell-note"> / {rate(netOut())}</span></td>
      <td class="numeric"><span class="metric-value-small">{percent(psiCpu(last()))}</span></td>
    </tr>
  );
}

function FleetSkeleton(): JSX.Element {
  return (
    <>
      <section class="chart-grid" aria-hidden="true">
        <Widget title="CPU utilization"><Skeleton rows={2} chart /></Widget>
        <Widget title="Network receive"><Skeleton rows={2} chart /></Widget>
      </section>
      <Widget title="Hosts">
        <Skeleton rows={7} />
      </Widget>
    </>
  );
}
