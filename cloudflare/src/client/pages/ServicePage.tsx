import { createMemo, Errored, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import type { Service } from "../api";
import { age } from "../format";
import { loadServices } from "../queries";
import { PROJECT_REFRESH_TICKS, useTelemetry } from "../state";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState, Skeleton } from "../components/ui";
import { createUpdateEffect } from "../effect";
import { createServiceDeployments, DeploymentRail, DeploymentsWidget } from "./project/Deployments";
import { DeploymentEvents } from "../components/DeploymentEvents";
import "./project/project.css";
import "./project/services.css";

export function ServicePage(): JSX.Element {
  const params = useParams();
  const { tick, manualTick } = useTelemetry();
  const serviceTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const services = createMemo(loadServices);
  const service = createMemo(() => services().find(candidate => candidate.name === (params.serviceName ?? "")));
  createUpdateEffect(() => `${serviceTick()}:${manualTick()}`, () => { void refresh(services); });
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<Skeleton rows={2} />}>
        <Show
          when={service()}
          fallback={<EmptyState icon="host" title="Service not found" detail="The service name is not in this installation." action={<a class="btn" href="#/services">Back to services</a>} />}
        >
          {found => <ServiceView service={found()} />}
        </Show>
      </Loading>
    </Errored>
  );
}

function ServiceView(props: { readonly service: Service }): JSX.Element {
  const { range, now, tick, manualTick } = useTelemetry();
  const serviceTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const deployments = createServiceDeployments(() => props.service.name, range, () => `${serviceTick()}:${manualTick()}`);
  const settled = () => deployments.history() !== null || deployments.historyError() !== null;
  const latest = () => deployments.history()?.deployments[0];
  return (
    <DeploymentEvents value={deployments.events}>
      <PageHeader title={props.service.name} />
      <p class="service-facts">
        <span>{props.service.hostIds.length} {props.service.hostIds.length === 1 ? "host" : "hosts"}</span>
        <span>{props.service.healthUrl === null ? "health probe unavailable, no health URL" : `probing ${props.service.healthUrl}`}</span>
        <Show when={props.service.unit}>{unit => <span>unit {unit()}</span>}</Show>
        <Show when={latest()}>{deployment => <span>last deploy {deployments.title(deployment())}, {age(deployment().atMs, now())}</span>}</Show>
      </p>
      <div class="project-page">
        <Show when={settled()} fallback={<Skeleton rows={4} chart class="skeleton-deployments" />}>
          <div class={deployments.listed() ? "project-body with-rail" : "project-body"}>
            <Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show>
            <div class="project-main">
              <DeploymentsWidget deployments={deployments} />
            </div>
          </div>
        </Show>
      </div>
    </DeploymentEvents>
  );
}
