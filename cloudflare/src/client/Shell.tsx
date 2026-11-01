import { createEffect, createMemo, createSignal, Errored, For, Loading, onSettled, refresh, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation } from "@solidjs/router";
import { Icon } from "./components/Icon";
import { Skeleton } from "./components/ui";
import { clock } from "./format";
import { loadHosts } from "./queries";
import { statusFor } from "./status";
import { TelemetryContext, type Range, type Theme, useTelemetry } from "./state";

function initialTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function Shell(props: ParentProps): JSX.Element {
  const [range, setRange] = createSignal<Range>("1h");
  const [now, setNow] = createSignal(Date.now());
  const [theme, setTheme] = createSignal<Theme>(initialTheme());
  const hosts = createMemo(loadHosts);

  onSettled(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  });

  createEffect(() => theme(), value => {
    document.documentElement.dataset.theme = value;
  });

  const toggleTheme = () => setTheme(value => (value === "dark" ? "light" : "dark"));
  const refreshHosts = async () => {
    await refresh(hosts);
  };

  return (
    <TelemetryContext value={{ range, setRange, now, hosts, refreshHosts, theme, toggleTheme }}>
      <div class="app-shell">
        <Sidebar />
        <div class="app-main">
          <Topbar />
          <main class="content">{props.children}</main>
        </div>
      </div>
    </TelemetryContext>
  );
}

function Sidebar(): JSX.Element {
  const { hosts } = useTelemetry();
  const location = useLocation();
  return (
    <aside class="sidebar">
      <a class="brand" href="#/" aria-label="Stats home">
        <span class="brand-mark"><Icon name="activity" size={18} /></span>
        <span class="brand-copy">
          <strong>Stats</strong>
          <small>Telemetry</small>
        </span>
      </a>
      <nav class="side-nav" aria-label="Main">
        <div class="nav-group">
          <p class="nav-label">Dashboards</p>
          <a class={location.pathname === "/" ? "nav-item active" : "nav-item"} href="#/">
            <Icon name="overview" size={15} />
            <span>Fleet overview</span>
          </a>
        </div>
        <div class="nav-group hosts-group">
          <p class="nav-label">Hosts</p>
          <Errored fallback={<p class="nav-error">Host directory unavailable.</p>}>
            <Loading fallback={<Skeleton rows={4} />}>
              <ul class="host-list">
                <For each={hosts()}>
                  {(host) => {
                    const status = () => statusFor(host, host.lastReceivedAtMs);
                    return (
                      <li>
                        <a
                          class={location.pathname === `/host/${host.hostId}` ? "host-link active" : "host-link"}
                          href={`#/host/${host.hostId}`}
                          title={host.hostId}
                        >
                          <span class={`status-dot tone-${status().tone}`} aria-hidden="true" />
                          <span class="host-link-name">{host.name}</span>
                          <span class="host-link-status">{status().label}</span>
                        </a>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Loading>
          </Errored>
        </div>
      </nav>
      <div class="sidebar-foot">
        <Icon name="lock" size={13} />
        <span>Cloudflare Access</span>
      </div>
    </aside>
  );
}

function Topbar(): JSX.Element {
  const { now, theme, toggleTheme } = useTelemetry();
  const location = useLocation();
  const isHost = () => location.pathname.startsWith("/host/");
  return (
    <header class="topbar">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <span>Observability</span>
        <Icon name="chevronRight" size={12} />
        <a href="#/">Hosts</a>
        <Icon name="chevronRight" size={12} />
        <strong>{isHost() ? "Host detail" : "Fleet overview"}</strong>
      </nav>
      <div class="topbar-actions">
        <span class="live-clock"><span class="pulse" aria-hidden="true" />{clock(now())}</span>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          aria-label={theme() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={toggleTheme}
        >
          <Icon name={theme() === "dark" ? "sun" : "moon"} size={16} />
        </button>
      </div>
    </header>
  );
}
