import { createMemo, createSignal, Errored, For, Loading, onCleanup, onSettled, refresh, Show, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation } from "@solidjs/router";
import type { HistoryQuery } from "./api";
import { TimeBar } from "./components/TimeBar";
import { loadHosts } from "./queries";
import { createUpdateEffect } from "./effect";
import type { TimeWindow } from "./chart-data";
import { createViewState, DEFAULT_RANGE, LIVE_INTERVAL_MS, rangeMs, ranges, smallestRangeCovering, TelemetryContext, useTelemetry, type Range } from "./state";
import { readParam, routeWithRange, writeParam } from "./urlState";
import { createListState } from "./list-state";

const HOST_PATH = /^\/host\/(h_[0-9a-f]{32})$/u;
const SERVICE_PATH = /^\/service\/([a-z][a-z0-9-]{0,31})$/u;
const PROJECT_PATH = /^\/project\/([a-z][a-z0-9-]{0,31})$/u;

function isHostsPath(path: string): boolean {
  return path === "/" || path.startsWith("/host/");
}

function isProjectsPath(path: string): boolean {
  return path === "/projects" || PROJECT_PATH.test(path);
}

function isServicesPath(path: string): boolean {
  return path === "/services" || SERVICE_PATH.test(path);
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) ||
    target.closest('[role="menu"], [role="listbox"], [role="combobox"][aria-expanded="true"], [aria-haspopup="menu"][aria-expanded="true"]') !== null
  );
}

export function Shell(props: ParentProps): JSX.Element {
  const lists = createListState();
  const [range, setRange] = createSignal<Range>(ranges.find(candidate => candidate === readParam("range")) ?? DEFAULT_RANGE);
  const [now, setNow] = createSignal(Date.now());
  const hosts = createMemo(loadHosts);
  const views = createViewState(range, now);
  const liveQuery = createMemo<HistoryQuery>(() => ({ range: range() }));
  const query = createMemo<HistoryQuery>(() => views.view() ?? liveQuery());
  const location = useLocation();
  const onHashChange = (event: HashChangeEvent) => {
    const hash = new URL(event.newURL).hash;
    const query = hash.indexOf("?");
    const requested = query < 0 ? null : new URLSearchParams(hash.slice(query + 1)).get("range");
    const next = ranges.find(candidate => candidate === requested) ?? DEFAULT_RANGE;
    if (next === range()) return;
    views.resetZoom();
    setRange(next);
  };
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => window.removeEventListener("hashchange", onHashChange));

  onSettled(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 10_000);
    const live = window.setInterval(() => {
      if (!document.hidden && views.live() && views.view() === null) views.autoRefresh();
    }, LIVE_INTERVAL_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || document.querySelector("dialog[open]") !== null) return;
      if (event.key === "z") views.zoomOut();
      else if (event.key === "l") views.toggleLive();
      else if (event.key === "[") views.pan(-1);
      else if (event.key === "]") views.pan(1);
      else if (event.key === "Escape") views.resetZoom();
      else if (event.key === "/") {
        const search = document.querySelector<HTMLInputElement>("input[type=search]");
        if (search === null) return;
        event.preventDefault();
        search.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(live);
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  const chooseRange = (next: Range): void => {
    views.resetZoom();
    setRange(next);
  };
  const showWindow = (window: TimeWindow): boolean => {
    const current = now();
    const fromMs = Math.max(window.fromMs, current - rangeMs[ranges[ranges.length - 1]!]);
    const covering = smallestRangeCovering(fromMs, current);
    if (rangeMs[covering] > rangeMs[range()]) {
      setRange(covering);
    }
    views.resetZoom();
    return views.zoomTo({ fromMs, toMs: window.toMs });
  };
  createUpdateEffect(() => location.pathname, () => {
    views.resetZoom();
  });
  createUpdateEffect(() => `${range()}:${location.pathname}`, () => writeParam("range", range() === DEFAULT_RANGE ? null : range()));

  const refreshHosts = async () => {
    await refresh(hosts);
  };

  return (
    <TelemetryContext value={{ lists, range, query, chooseRange, showWindow, now, hosts, refreshHosts, ...views }}>
      <header class="topbar">
        <div class="topbar-start">
          <nav class="primary-nav" aria-label="Primary">
            <a href={routeWithRange("#/", range())} aria-current={isHostsPath(location.pathname) ? "page" : "false"}>Hosts</a>
            <a href={routeWithRange("#/projects", range())} aria-current={isProjectsPath(location.pathname) ? "page" : "false"}>Projects</a>
            <a href={routeWithRange("#/services", range())} aria-current={isServicesPath(location.pathname) ? "page" : "false"}>Services</a>
          </nav>
          <Breadcrumb />
        </div>
        <TimeBar />
      </header>
      <main class="content"><Loading fallback={null}>{props.children}</Loading></main>
    </TelemetryContext>
  );
}

function Breadcrumb(): JSX.Element {
  const location = useLocation();
  const host = () => HOST_PATH.exec(location.pathname)?.[1];
  return (
    <Show when={host()}>
      {(current) => (
        <div class="breadcrumb">
          <Errored fallback={null}>
            <Loading fallback={null}>
              <HostSwitcher current={current()} />
            </Loading>
          </Errored>
        </div>
      )}
    </Show>
  );
}

function HostSwitcher(props: { readonly current: string }): JSX.Element {
  const { hosts, range } = useTelemetry();
  return (
    <select
      class="host-switcher"
      aria-label="Switch host"
      onChange={(event) => { window.location.hash = routeWithRange(`#/host/${event.currentTarget.value}`, range()); }}
    >
      <For each={hosts()}>
        {(host) => <option value={host.hostId} selected={host.hostId === props.current}>{host.name}</option>}
      </For>
    </select>
  );
}
