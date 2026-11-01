import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { HostSystem } from "../../api";
import { bytes } from "../../format";
import { EmptyState, Widget } from "../../components/ui";

function ghz(mhz: number): string {
  return `${(mhz / 1000).toFixed(2)} GHz`;
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function SystemPanel(props: { readonly system: HostSystem | null; readonly memoryBytes: number | undefined }): JSX.Element {
  const facts = () => {
    const found = props.system;
    if (found === null) return [];
    const { system } = found;
    const topology = [
      system.cpu.cores === undefined ? undefined : plural(system.cpu.cores, "core"),
      plural(system.cpu.threads, "thread"),
      system.cpu.sockets === undefined ? undefined : plural(system.cpu.sockets, "socket"),
      system.cpu.maxMhz === undefined ? undefined : `up to ${ghz(system.cpu.maxMhz)}`
    ].filter((part): part is string => part !== undefined);
    return [
      { label: "CPU", value: system.cpu.model ?? "unknown model", detail: topology.join(" · ") },
      { label: "Memory", value: bytes(props.memoryBytes), detail: undefined },
      { label: "OS", value: system.os ?? "unknown", detail: `kernel ${system.kernel} · ${system.arch}` },
      { label: "Hostname", value: system.hostname, detail: `agent ${system.agent}` }
    ];
  };
  return (
    <Show
      when={props.system !== null}
      fallback={
        <Widget title="System">
          <EmptyState title="This host has not reported system details." detail="The agent sends them with its first upload after an update." icon="host" />
        </Widget>
      }
    >
      <section class="sysinfo" aria-label="System">
        <For each={facts()}>
          {(fact) => (
            <div class="sysinfo-fact">
              <span class="sysinfo-label">{fact.label}</span>
              <span class="sysinfo-value">{fact.value}</span>
              {fact.detail === undefined ? null : <span class="sysinfo-detail">{fact.detail}</span>}
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}
