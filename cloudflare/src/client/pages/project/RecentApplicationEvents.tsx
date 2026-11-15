import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { EmptyState } from "@laputa-systems/ui-dashboard";
import type { ApplicationTelemetry } from "../../../observe/application/telemetry";
import { Widget } from "../../components/ui";
import { milliseconds } from "../../format";

export function RecentApplicationEvents(props: { readonly data: ApplicationTelemetry }): JSX.Element {
  return <Widget title="Recent events">
    <Show when={props.data.recent.length} fallback={<EmptyState title="No recent events in this window" />}>
      <div class="table-scroll"><table class="data-table" aria-label="Recent application events">
        <thead><tr><th>Time</th><th>Operation</th><th>Outcome</th><th>Wall</th><th>Release</th><th>Work</th></tr></thead>
        <tbody><For each={props.data.recent}>{row => <tr>
          <td>{new Date(row.event.atMs).toLocaleString()}</td><td>{row.event.operation}</td><td>{row.event.outcome}</td>
          <td>{milliseconds(row.event.durationMs)}</td><td>{row.event.release}</td>
          <td>{Object.entries(row.event.work).map(([key, value]) => `${key}: ${value}`).join(", ")}<Show when={row.event.error}><div>{row.event.error?.code}</div></Show></td>
        </tr>}</For></tbody>
      </table></div>
    </Show>
    <Show when={props.data.moreRecent}><p>Showing the newest 50 events in the selected window.</p></Show>
    <p class="cell-note">HTTP events report response status and time to response headers. Other events report application work.</p>
  </Widget>;
}
