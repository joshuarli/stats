import { createMemo, createSignal, Errored, For, isPending, latest, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { LIMITS, loadLimits } from "../health";
import { age, bytes, count, errorMessage, isFiniteNumber, percent, rate } from "../format";
import { alignTracks, sumTracks, worstTrack } from "../chart-data";
import { cpuUsed, lastCell, lastValue, memoryUsed, sumLatest, usedShare } from "../metrics";
import { loadFleetRows, loadProjects, type FleetRow } from "../queries";
import { collectorStatus, statusFor, type HostStatus } from "../status";
import { useTelemetry, PROJECT_REFRESH_TICKS } from "../state";
import type { Host, Project } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { Sparkline } from "../components/Sparkline";
import { OsLogo } from "../components/OsLogo";
import { EmptyState, EntityCell, ErrorState, Meter, Notice, Pagination, Skeleton, StateCell, Widget } from "../components/ui";
import { osFamily } from "../os";
import { createUpdateEffect } from "../effect";

const PAGE_SIZE = 10;
const statusLabels = ["online", "stale", "no samples", "revoked"] as const;
type StatusLabel = (typeof statusLabels)[number];
const statusRank: Record<HostStatus["label"], number> = { online: 0, stale: 1, "no samples": 2, unknown: 3, revoked: 4 };
type SortKey = "name" | "status" | "seen";
interface Sort { readonly key: SortKey; readonly direction: 1 | -1 }

function isStatusLabel(label: string): label is StatusLabel {
  return (statusLabels as readonly string[]).includes(label);
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
  const { query, hosts, now, refreshHosts, tick } = useTelemetry();
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<ReadonlySet<StatusLabel>>(new Set<StatusLabel>());
  const [sort, setSort] = createSignal<Sort>({ key: "status", direction: 1 });
  const [page, setPage] = createSignal(1);
  const [refreshError, setRefreshError] = createSignal<string | null>(null);

  const filtered = createMemo(() => {
    const text = search().trim().toLowerCase();
    const chosen = selected();
    const matching = hosts().filter(host => {
      const label = hostStatus(host).label;
      const matchesStatus = chosen.size === 0 || (isStatusLabel(label) && chosen.has(label));
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
  createUpdateEffect(() => tick(), () => { void doRefresh(); });

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

  const sortBy = (key: SortKey) => setSort(current => ({ key, direction: current.key === key ? (current.direction === 1 ? -1 : 1) : 1 }));

  return (
    <>
      <PageHeader title="Fleet" />
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>
      <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
        <Loading fallback={<FleetSkeleton />}>
          <FleetDashboard
            rows={rows()}
            total={filtered().length}
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
          />
        </Loading>
      </Errored>
      <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} compact />}>
        <Loading fallback={<Widget title="Projects"><Skeleton rows={2} /></Widget>}>
          <ProjectsSection />
        </Loading>
      </Errored>
    </>
  );
}

function ProjectsSection(): JSX.Element {
  const { now, tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const projects = createMemo(loadProjects);
  createUpdateEffect(() => `${projectTick()}:${manualTick()}`, () => { void refresh(projects); });
  return (
    <Show when={projects().length > 0}>
      <Widget
        id="projects"
        title="Projects"
        class={isPending(projects) ? "widget-pending" : undefined}
        bodyClass="flush"
      >
        <div class="table-scroll projects-table-scroll" role="region" aria-label="Projects table">
          <table class="data-table" aria-label="Projects">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Worker</th>
                <th scope="col" class="numeric">R2 buckets</th>
                <th scope="col">Collector</th>
              </tr>
            </thead>
            <tbody>
              <For each={projects()}>{(project) => <ProjectRow project={project} now={now()} />}</For>
            </tbody>
          </table>
        </div>
      </Widget>
    </Show>
  );
}

function ProjectRow(props: { readonly project: Project; readonly now: number }): JSX.Element {
  const status = createMemo(() => collectorStatus(props.project.collector, props.now));
  return (
    <tr>
      <td>
        <EntityCell
          marker={<span class={`status-dot tone-${status().tone}`} aria-hidden="true" />}
          name={props.project.name}
          href={`#/project/${props.project.id}`}
          id={props.project.id}
        />
      </td>
      <td><span class="cell-strong">{props.project.worker}</span></td>
      <td class="numeric"><span class="metric-value-small">{count(props.project.buckets.length)}</span></td>
      <td><StateCell tone={status().tone} label={status().label} note={age(props.project.collector.lastSuccessAtMs, props.now)} /></td>
    </tr>
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
  readonly sort: Sort;
  readonly sortBy: (key: SortKey) => void;
  readonly page: number;
  readonly pages: number;
  readonly setPage: (value: number) => void;
  readonly now: number;
  readonly pending: boolean;
}): JSX.Element {
  const from = () => props.total === 0 ? 0 : (props.page - 1) * PAGE_SIZE + 1;
  const to = () => Math.min(props.total, props.page * PAGE_SIZE);
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
      <Widget
        title="Hosts"
        class={props.pending ? "widget-pending" : undefined}
        bodyClass="flush"
      >
        <div class="table-toolbar">
          <StatusChips counts={props.counts} selected={props.selected} toggle={props.toggle} />
          <label class="search">
            <span class="sr-only">Search hosts</span>
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
                  {header("name", "Host")}
                  <th scope="col">CPU</th>
                  <th scope="col">Memory</th>
                  <th scope="col">Load 1m / 5m / 15m</th>
                  <th scope="col">Disk space</th>
                  <th scope="col">Disk read / write</th>
                  <th scope="col">Network in / out</th>
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
          href={`#/host/${props.row.host.hostId}`}
          id={props.row.host.hostId}
          note={osNote()}
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
