import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { HostSystem } from "../../api";
import { bytes } from "../../format";
import { duration } from "../../health";
import { HoverCard } from "../../components/ui";

function ghz(mhz: number): string {
  return `${(mhz / 1000).toFixed(2)} GHz`;
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function SystemInfo(props: { readonly system: HostSystem | null; readonly memoryBytes: () => number | undefined; readonly uptimeMs: () => number | undefined }): JSX.Element {
  const facts = () => {
    const found = props.system;
    if (found === null) return [];
    const { system } = found;
    const uptime = props.uptimeMs();
    const topology = [
      system.cpu.cores === undefined ? undefined : plural(system.cpu.cores, "core"),
      plural(system.cpu.threads, "thread"),
      system.cpu.sockets === undefined ? undefined : plural(system.cpu.sockets, "socket"),
      system.cpu.maxMhz === undefined ? undefined : `up to ${ghz(system.cpu.maxMhz)}`
    ].filter((part): part is string => part !== undefined);
    return [
      { label: "CPU", value: system.cpu.model ?? "unknown model", detail: topology.join(" · ") },
      { label: "Memory", value: bytes(props.memoryBytes()), detail: undefined },
      { label: "OS", value: system.os ?? "unknown", detail: `kernel ${system.kernel} · ${system.arch}` },
      { label: "Hostname", value: system.hostname, detail: `agent ${system.agent}` },
      { label: "Uptime", value: uptime === undefined ? "—" : duration(uptime), detail: undefined }
    ];
  };
  return (
    <HoverCard label="Host information">
      <Show
        when={props.system}
        fallback={<p class="hover-card-empty">This host has not reported system details. The agent sends them with its first upload after an update.</p>}
      >
        <dl class="system-facts">
          <For each={facts()}>
            {(fact) => (
              <>
                <dt>{fact.label}</dt>
                <dd>
                  {fact.value}
                  {fact.detail === undefined ? null : <span>{fact.detail}</span>}
                </dd>
              </>
            )}
          </For>
        </dl>
      </Show>
    </HoverCard>
  );
}
