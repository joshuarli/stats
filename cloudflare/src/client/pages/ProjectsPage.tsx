import { createMemo, Errored, For, isPending, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { age, count } from "../format";
import { loadProjects } from "../queries";
import { collectorStatus } from "../status";
import { PROJECT_REFRESH_TICKS, useTelemetry } from "../state";
import type { Project } from "../api";
import { EntityCell, EmptyState, ErrorState, Skeleton, StateCell, Widget } from "../components/ui";
import { createUpdateEffect } from "../effect";

export function ProjectsPage(): JSX.Element {
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<Widget title="Projects"><Skeleton rows={2} /></Widget>}>
        <Projects />
      </Loading>
    </Errored>
  );
}

function Projects(): JSX.Element {
  const { now, tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const projects = createMemo(loadProjects);
  createUpdateEffect(() => `${projectTick()}:${manualTick()}`, () => { void refresh(projects); });
  return (
    <Show
      when={projects().length > 0}
      fallback={
        <Widget title="Projects">
          <EmptyState title="No projects are configured." detail="Projects are declared in cloudflare/cloudflare.config.ts." />
        </Widget>
      }
    >
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
