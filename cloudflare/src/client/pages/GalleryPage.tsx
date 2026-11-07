import {
  Badge,
  Button,
  CollapsiblePanel,
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  Meter,
  Modal,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Segmented,
  Skeleton,
  type Tone
} from "@joshuarli/ui";
import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

const ALL_TONES: readonly Tone[] = ["ok", "warn", "bad", "neutral", "info", "accent"];
const ALL_ICONS: readonly IconName[] = [
  "activity",
  "alert",
  "arrowRight",
  "check",
  "chevronLeft",
  "chevronRight",
  "disk",
  "expand",
  "host",
  "info",
  "network",
  "refresh",
  "search",
  "sortDown",
  "sortUp",
  "x"
];

export function GalleryPage(): JSX.Element {
  const [segmentedValue, setSegmentedValue] = createSignal("1h");
  const [currentPage, setCurrentPage] = createSignal(2);
  const [modalOpen, setModalOpen] = createSignal(false);
  const [panelCollapsed, setPanelCollapsed] = createSignal(false);

  return (
    <div style="padding: 24px; max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px;">
      <PageHeader
        title="Component Gallery"
        titleExtra={<Badge tone="accent">@joshuarli/ui</Badge>}
        mark={<Icon name="activity" size={24} />}
      />

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px;">
        <Panel title="Badges & Status">
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
              <For each={ALL_TONES}>{tone => <Badge tone={tone}>{tone}</Badge>}</For>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
              <For each={ALL_TONES}>{tone => <Badge tone={tone} dot>{tone}</Badge>}</For>
            </div>
          </div>
        </Panel>

        <Panel title="Buttons & Controls">
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
            <Button>Standard</Button>
            <Button variant="small">Small</Button>
            <Button variant="icon" ariaLabel="Search"><Icon name="search" size={14} /></Button>
            <Button disabled>Disabled</Button>
          </div>
          <div style="margin-top: 16px;">
            <Segmented
              label="Time Range"
              value={segmentedValue()}
              options={[["1h", "1 Hour"], ["6h", "6 Hours"], ["24h", "24 Hours"], ["7d", "7 Days"]]}
              onChange={setSegmentedValue}
            />
          </div>
        </Panel>

        <Panel title="Meters & Gauges">
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div>
              <span style="font-size: 11px; color: var(--ui-muted);">Normal (25%)</span>
              <Meter value={25} warn={70} bad={90} />
            </div>
            <div>
              <span style="font-size: 11px; color: var(--ui-muted);">Warning (75%)</span>
              <Meter value={75} warn={70} bad={90} />
            </div>
            <div>
              <span style="font-size: 11px; color: var(--ui-muted);">Critical (95%)</span>
              <Meter value={95} warn={70} bad={90} />
            </div>
          </div>
        </Panel>

        <Panel title="Notices">
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <Notice tone="info">System operational and polling telemetry.</Notice>
            <Notice tone="warn">Host agent running behind on collection schedule.</Notice>
            <Notice tone="bad">Failed to authenticate with origin service.</Notice>
            <Notice tone="ok">Verification policy satisfied across all hosts.</Notice>
          </div>
        </Panel>

        <CollapsiblePanel
          title="Collapsible Panel"
          meta={<Badge tone="neutral">Toggleable</Badge>}
          collapsible
          collapsed={panelCollapsed()}
          onToggleCollapsed={() => setPanelCollapsed(c => !c)}
          expandable
        >
          <p style="margin: 0; color: var(--ui-text-2);">This panel demonstrates collapsible and expandable behavior with no application-specific storage bindings.</p>
        </CollapsiblePanel>

        <Panel title="Modal Dialog">
          <p style="margin: 0 0 12px; color: var(--ui-text-2);">Accessible dialog with keyboard trap and focus restoration.</p>
          <Button onClick={() => setModalOpen(true)}>Open Modal</Button>
        </Panel>

        <Panel title="Skeleton Loading">
          <Skeleton rows={3} chart />
        </Panel>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px;">
        <Panel title="Empty State">
          <EmptyState
            title="No hosts matched your query"
            detail="Try clearing search filters or checking agent provisioning status."
            action={<Button variant="small">Clear filters</Button>}
          />
        </Panel>

        <Panel title="Error State">
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <ErrorState
              title="Failed to query database"
              detail="Connection reset by peer after 30s timeout."
              retry={() => {}}
            />
            <ErrorState
              compact
              title="Compact alert"
              detail="Worker returned 503 Service Unavailable"
            />
          </div>
        </Panel>
      </div>

      <Panel title="Dense Table Layout">
        <div class="ui-table-toolbar">
          <div class="ui-search">
            <Icon name="search" size={14} />
            <input type="text" placeholder="Filter records…" aria-label="Filter records" />
          </div>
          <Badge tone="ok" dot>Live</Badge>
        </div>
        <div class="ui-table-scroll">
          <table class="ui-data-table">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Status</th>
                <th scope="col" class="numeric">P95 Latency</th>
                <th scope="col" class="numeric">Throughput</th>
                <th scope="col">Capacity</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>auth-worker</strong></td>
                <td><Badge tone="ok" dot>Healthy</Badge></td>
                <td class="numeric">4.2 ms</td>
                <td class="numeric">1,420 req/s</td>
                <td><Meter value={35} warn={70} bad={90} /></td>
              </tr>
              <tr>
                <td><strong>ingest-pipeline</strong></td>
                <td><Badge tone="warn" dot>Elevated</Badge></td>
                <td class="numeric">18.9 ms</td>
                <td class="numeric">4,890 req/s</td>
                <td><Meter value={78} warn={70} bad={90} /></td>
              </tr>
              <tr>
                <td><strong>analytics-rollup</strong></td>
                <td><Badge tone="bad" dot>Degraded</Badge></td>
                <td class="numeric">142.0 ms</td>
                <td class="numeric">310 req/s</td>
                <td><Meter value={94} warn={70} bad={90} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pagination
          page={currentPage()}
          pages={8}
          from={11}
          to={20}
          total={80}
          onChange={setCurrentPage}
        />
      </Panel>

      <Panel title="Icon System">
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 12px; text-align: center;">
          <For each={ALL_ICONS}>{name => (
            <div style="padding: 12px 8px; border: 1px solid var(--ui-line); border-radius: var(--ui-radius-md); display: flex; flex-direction: column; align-items: center; gap: 8px;">
              <Icon name={name} size={18} />
              <span style="font-size: 11px; color: var(--ui-muted);">{name}</span>
            </div>
          )}</For>
        </div>
      </Panel>

      <Show when={modalOpen()}>
        <Modal
          label="Example Dialog"
          title="Component Library Modal"
          size="compact"
          onClose={() => setModalOpen(false)}
        >
          <p style="margin: 0 0 16px; color: var(--ui-text-2);">This modal uses native HTML &lt;dialog&gt; under the hood with accessible keyboard focus trapping, backdrop blur, and escape handling.</p>
          <div style="display: flex; justify-content: flex-end; gap: 8px;">
            <Button variant="small" onClick={() => setModalOpen(false)}>Done</Button>
          </div>
        </Modal>
      </Show>
    </div>
  );
}
