import { createEffect, createMemo, createSignal, Errored, For, Loading, onSettled, refresh, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation } from "@solidjs/router";
import type { HistoryQuery } from "./api";
import { Icon } from "./components/Icon";
import { TimeBar } from "./components/TimeBar";
import { loadHosts } from "./queries";
import { createViewState, LIVE_INTERVAL_MS, TelemetryContext, useTelemetry, type Range } from "./state";

const HOST_PATH = /^\/host\/(h_[0-9a-f]{32})$/u;

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
}

export function Shell(props: ParentProps): JSX.Element {
  const [range, setRange] = createSignal<Range>("1h");
  const [now, setNow] = createSignal(Date.now());
  const hosts = createMemo(loadHosts);
  const views = createViewState(range, now);
  const query = createMemo<HistoryQuery>(() => {
    const window = views.view();
    return window === null ? { range: range() } : window;
  });
  const location = useLocation();

  onSettled(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 10_000);
    const live = window.setInterval(() => {
      if (!document.hidden && views.live() && views.view() === null) views.requestRefresh();
    }, LIVE_INTERVAL_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
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

  createEffect(() => range(), views.resetZoom, { defer: true });
  createEffect(() => location.pathname, views.resetZoom, { defer: true });

  const refreshHosts = async () => {
    await refresh(hosts);
  };

  return (
    <TelemetryContext value={{ range, query, setRange, now, hosts, refreshHosts, ...views }}>
      <header class="topbar">
        <div class="topbar-start">
          <a class="brand" href="#/" aria-label="Stats home">stats</a>
          <Breadcrumb />
        </div>
        <TimeBar />
      </header>
      <main class="content">{props.children}</main>
    </TelemetryContext>
  );
}

function Breadcrumb(): JSX.Element {
  const location = useLocation();
  const current = () => HOST_PATH.exec(location.pathname)?.[1];
  return (
    <nav class="breadcrumb" aria-label="Breadcrumb">
      {current() === undefined ? <span>Hosts</span> : (
        <>
          <a href="#/">Hosts</a>
          <Icon name="chevronRight" size={12} />
          <Errored fallback={null}>
            <Loading fallback={null}>
              <HostSwitcher current={current() ?? ""} />
            </Loading>
          </Errored>
        </>
      )}
    </nav>
  );
}

function HostSwitcher(props: { readonly current: string }): JSX.Element {
  const { hosts } = useTelemetry();
  return (
    <select
      class="host-switcher"
      aria-label="Switch host"
      onChange={(event) => { window.location.hash = `#/host/${event.currentTarget.value}`; }}
    >
      <For each={hosts()}>
        {(host) => <option value={host.hostId} selected={host.hostId === props.current}>{host.name}</option>}
      </For>
    </select>
  );
}
