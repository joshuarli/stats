import { createMemo, createSignal, Errored, For, isPending, latest, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { age, bytes, count, errorMessage, percent, rate } from "../format";
import { cpuUsed, latestPoint, loadOne, memoryFree, memoryTotal, memoryUsed, psiCpu, sparkPoints, sumLatest } from "../metrics";
import { loadFleetRows, type FleetRow } from "../queries";
import { statusFor } from "../status";
import { rangeLabels, useTelemetry } from "../state";
import { PageHeader, RangePicker, RefreshButton } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { Sparkline } from "../components/Sparkline";
import { Badge, EmptyState, ErrorState, MetricTile, Notice, Pagination, Skeleton, Widget } from "../components/ui";

const PAGE_SIZE = 10;
const filters = [
  { value: "all", label: "All hosts" },
  { value: "online", label: "Online" },
  { value: "stale", label: "Stale" },
  { value: "revoked", label: "Revoked" }
] as const;
type Filter = (typeof filters)[number]["value"];

export function FleetPage(): JSX.Element {
  const { range, hosts, now, refreshHosts } = useTelemetry();
  const [search, setSearch] = createSignal("");
  const [filter, setFilter] = createSignal<Filter>("all");
  const [page, setPage] = createSignal(1);
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshError, setRefreshError] = createSignal<string | null>(null);

  const filtered = createMemo(() => {
    const text = search().trim().toLowerCase();
    const selected = filter();
    return hosts().filter(host => {
      const status = statusFor(host, host.lastReceivedAtMs).label;
      const matchesFilter = selected === "all" || status === selected;
      const matchesSearch = text.length === 0 || host.name.toLowerCase().includes(text) || host.hostId.includes(text);
      return matchesFilter && matchesSearch;
    });
  });

  const pages = createMemo(() => Math.max(1, Math.ceil(filtered().length / PAGE_SIZE)));
  const currentPage = createMemo(() => Math.min(page(), pages()));
  const pageHosts = createMemo(() => filtered().slice((currentPage() - 1) * PAGE_SIZE, currentPage() * PAGE_SIZE));
  const rows = createMemo(() => loadFleetRows(pageHosts(), range()));

  const doRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await Promise.all([refreshHosts(), refresh(rows)]);
    } catch (error) {
      setRefreshError(errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  const counts = createMemo(() => {
    const all = hosts();
    return {
      all: all.length,
      online: all.filter(host => statusFor(host, host.lastReceivedAtMs).label === "online").length,
      stale: all.filter(host => statusFor(host, host.lastReceivedAtMs).label === "stale").length,
      revoked: all.filter(host => host.revoked).length
    };
  });

  return (
    <>
      <PageHeader
        eyebrow="Host telemetry"
        title="Fleet overview"
        subtitle="Host health, resource pressure, and throughput from accepted samples."
        actions={
          <>
            <RangePicker />
            <RefreshButton pending={refreshing()} onClick={() => void doRefresh()} />
          </>
        }
      />
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>
      <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
        <Loading fallback={<FleetSkeleton />}>
          <FleetDashboard
            rows={rows()}
            range={rangeLabels[range()]}
            allCounts={counts()}
            total={filtered().length}
            search={latest(search)}
            setSearch={setSearch}
            filter={latest(filter)}
            setFilter={setFilter}
            page={Math.min(latest(page), pages())}
            pages={pages()}
            setPage={setPage}
            now={now()}
            pending={isPending(rows)}
          />
        </Loading>
      </Errored>
    </>
  );
}

function FleetDashboard(props: {
  readonly rows: readonly FleetRow[];
  readonly range: string;
  readonly allCounts: { readonly all: number; readonly online: number; readonly stale: number; readonly revoked: number };
  readonly total: number;
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly filter: Filter;
  readonly setFilter: (value: Filter) => void;
  readonly page: number;
  readonly pages: number;
  readonly setPage: (value: number) => void;
  readonly now: number;
  readonly pending: boolean;
}): JSX.Element {
  const from = () => props.total === 0 ? 0 : (props.page - 1) * PAGE_SIZE + 1;
  const to = () => Math.min(props.total, props.page * PAGE_SIZE);
  return (
    <>
      <section class="metric-grid" aria-label="Fleet status">
        <MetricTile
          icon="host"
          label="Hosts provisioned"
          value={count(props.allCounts.all)}
          detail={props.total === props.allCounts.all ? "all hosts" : `${props.total} matching filters`}
          tone="neutral"
        />
        <MetricTile
          icon="check"
          label="Online"
          value={count(props.allCounts.online)}
          detail={props.allCounts.all === 0 ? "no hosts" : percent((props.allCounts.online / props.allCounts.all) * 100)}
          tone="ok"
          meter={props.allCounts.all === 0 ? 0 : (props.allCounts.online / props.allCounts.all) * 100}
        />
        <MetricTile
          icon="clock"
          label="Stale"
          value={count(props.allCounts.stale)}
          detail="no sample in 45s"
          tone="warn"
          meter={props.allCounts.all === 0 ? 0 : (props.allCounts.stale / props.allCounts.all) * 100}
        />
        <MetricTile
          icon="alert"
          label="Revoked"
          value={count(props.allCounts.revoked)}
          detail="credentials retired"
          tone="bad"
          meter={props.allCounts.all === 0 ? 0 : (props.allCounts.revoked / props.allCounts.all) * 100}
        />
      </section>

      <Widget
        title="Hosts"
        subtitle={`${props.range} · missing values stay unavailable`}
        class={props.pending ? "widget-pending" : undefined}
        meta={<span class="widget-count">{count(props.total)} {props.total === 1 ? "host" : "hosts"}</span>}
        bodyClass="flush"
      >
        <div class="table-toolbar">
          <label class="search">
            <span class="sr-only">Search hosts</span>
            <span class="search-icon"><Icon name="search" size={14} /></span>
            <input
              type="search"
              placeholder="Search host name or id"
              value={props.search}
              onInput={event => { props.setSearch(event.currentTarget.value); props.setPage(1); }}
            />
          </label>
          <div class="filter-chips" role="group" aria-label="Host status">
            <For each={filters}>
              {(entry) => (
                <button
                  class={props.filter === entry.value ? "filter-chip active" : "filter-chip"}
                  type="button"
                  aria-pressed={props.filter === entry.value ? "true" : "false"}
                  onClick={() => { props.setFilter(entry.value); props.setPage(1); }}
                >
                  {entry.label}
                </button>
              )}
            </For>
          </div>
        </div>
        <Show
          when={props.rows.length > 0}
          fallback={
            <EmptyState
              title={props.allCounts.all === 0 ? "No telemetry hosts are provisioned." : "No hosts match this view."}
              detail={props.allCounts.all === 0 ? "Provision a host through the admin API to start collecting counters." : "Clear the search or choose another status filter."}
              icon="host"
              action={props.allCounts.all === 0 ? undefined : <button class="btn btn-secondary" type="button" onClick={() => { props.setSearch(""); props.setFilter("all"); props.setPage(1); }}>Clear filters</button>}
            />
          }
        >
          <div class="table-scroll">
            <table class="data-table" aria-label="Fleet hosts">
              <thead>
                <tr>
                  <th scope="col">Host</th>
                  <th scope="col">Status</th>
                  <th scope="col">CPU</th>
                  <th scope="col">Memory</th>
                  <th scope="col" class="numeric">Load 1m</th>
                  <th scope="col">Disk throughput</th>
                  <th scope="col">Network</th>
                  <th scope="col" class="numeric">PSI some10</th>
                </tr>
              </thead>
              <tbody>
                <For each={props.rows}>
                  {(row) => <FleetTableRow row={row} now={props.now} />}
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

function FleetTableRow(props: { readonly row: FleetRow; readonly now: number }): JSX.Element {
  const last = createMemo(() => latestPoint(props.row.summary));
  const status = createMemo(() => statusFor(props.row.host, props.row.host.lastReceivedAtMs));
  const cpu = createMemo(() => cpuUsed(last()));
  const memory = createMemo(() => memoryUsed(last()));
  const free = createMemo(() => memoryFree(last()));
  const total = createMemo(() => memoryTotal(last()));
  const diskRead = createMemo(() => sumLatest(props.row.disks, point => point.readBytesPerSec));
  const diskWrite = createMemo(() => sumLatest(props.row.disks, point => point.writeBytesPerSec));
  const netIn = createMemo(() => sumLatest(props.row.nets, point => point.rxBytesPerSec));
  const netOut = createMemo(() => sumLatest(props.row.nets, point => point.txBytesPerSec));
  const trend = createMemo(() => sparkPoints(props.row.summary, cpuUsed));
  return (
    <tr>
      <td class="host-cell">
        <a class="host-name" href={`#/host/${props.row.host.hostId}`}>{props.row.host.name}</a>
        <span class="host-id">{props.row.host.hostId}</span>
      </td>
      <td>
        <div class="status-cell">
          <Badge tone={status().tone} dot>{status().label}</Badge>
          <span class="cell-note">{status().label === "online" ? "reporting" : `last seen ${age(props.row.host.lastReceivedAtMs, props.now)}`}</span>
        </div>
      </td>
      <td>
        <div class="cpu-cell">
          <div class="cpu-cell-value">
            <span class="metric-value-small">{percent(cpu())}</span>
            <Sparkline points={trend()} label={`${props.row.host.name} CPU trend`} class="spark-inline" />
          </div>
          <div class="meter meter-small" aria-hidden="true"><span class={cpuTone(cpu())} style={`width:${clamp(cpu())}%`} /></div>
        </div>
      </td>
      <td>
        <div class="cell-stack">
          <span class="metric-value-small">{percent(memory())}</span>
          <span class="cell-note">{free() === undefined || total() === undefined ? "unavailable" : `${bytes(free())} free of ${bytes(total())}`}</span>
        </div>
      </td>
      <td class="numeric">
        <span class="metric-value-small">{count(loadOne(last()))}</span>
        <span class="cell-note">1 min</span>
      </td>
      <td>
        <div class="cell-stack">
          <span class="cell-strong">{rate(diskRead())} down</span>
          <span class="cell-note">{rate(diskWrite())} write</span>
        </div>
      </td>
      <td>
        <div class="cell-stack">
          <span class="cell-strong">{rate(netIn())} in</span>
          <span class="cell-note">{rate(netOut())} out</span>
        </div>
      </td>
      <td class="numeric">
        <span class="metric-value-small">{percent(psiCpu(last()))}</span>
        <span class="cell-note">10s window</span>
      </td>
    </tr>
  );
}

function cpuTone(value: number | undefined): string {
  if (value === undefined) return "tone-neutral";
  return value >= 90 ? "tone-bad" : value >= 75 ? "tone-warn" : "tone-ok";
}

function clamp(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "0" : Math.min(100, Math.max(0, value)).toFixed(1);
}

function FleetSkeleton(): JSX.Element {
  return (
    <>
      <section class="metric-grid" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>
          {() => <div class="metric skeleton-metric"><Skeleton rows={2} /></div>}
        </For>
      </section>
      <Widget title="Hosts" subtitle="Loading accepted samples">
        <Skeleton rows={7} />
      </Widget>
    </>
  );
}

