import { createMemo, Errored, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { collectorStatus, HEALTH_TONE } from "../health";
import { loadProjects } from "../queries";
import { useTelemetry } from "../state";
import { PageHeader } from "../components/PageHeader";
import { Badge, EmptyState, ErrorState, Skeleton } from "../components/ui";

export function ProjectPage(): JSX.Element {
  const params = useParams();
  const projects = createMemo(loadProjects);
  const project = createMemo(() => projects().find(candidate => candidate.id === (params.projectId ?? "")));
  const { now } = useTelemetry();
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<Skeleton rows={2} />}>
        <Show
          when={project()}
          fallback={
            <EmptyState
              icon="host"
              title="Project not found"
              detail="The project id is not in this installation's configuration."
              action={<a class="btn" href="#/">Back to fleet</a>}
            />
          }
        >
          {(found) => {
            const status = () => collectorStatus(found().collector, now());
            return (
              <PageHeader title={found().name} titleExtra={<Badge tone={HEALTH_TONE[status().health]} dot>{status().label}</Badge>} hint="Cloudflare project" />
            );
          }}
        </Show>
      </Loading>
    </Errored>
  );
}
