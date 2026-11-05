import { createEffect, createMemo, createSignal, Errored, For, isPending, Loading, onCleanup, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Service } from "../api";
import { age } from "../format";
import { loadServices } from "../queries";
import { PROJECT_REFRESH_TICKS, useTelemetry } from "../state";
import { EmptyState, EntityCell, ErrorState, Skeleton, Widget } from "../components/ui";
import { createUpdateEffect } from "../effect";
import type { DeploymentHistory } from "../../deployments/model";
import { deploymentTitle, loadServiceDeploymentHistory } from "./project/Deployments";
import "./project/projects.css";
import "./project/services.css";

export function ServicesPage(): JSX.Element {
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<Widget title="Services"><Skeleton rows={2} /></Widget>}>
        <Services />
      </Loading>
    </Errored>
  );
}

function Services(): JSX.Element {
  const { tick, manualTick } = useTelemetry();
  const serviceTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const services = createMemo(loadServices);
  createUpdateEffect(() => `${serviceTick()}:${manualTick()}`, () => { void refresh(services); });
  return (
    <Show
      when={services().length > 0}
      fallback={
        <Widget title="Services">
          <EmptyState title="No services are configured." detail="Create one with POST /api/v1/admin/services; see docs/operations.md." />
        </Widget>
      }
    >
      <Widget id="services" title="Services" class={isPending(services) ? "widget-pending" : undefined} bodyClass="flush" meta={<span class="projects-basis">Deployments are markers pushed by deploy scripts</span>}>
        <div class="table-scroll" role="region" aria-label="Services table">
          <table class="data-table services-table" aria-label="Services">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col" class="numeric">Hosts</th>
                <th scope="col">Health probe</th>
                <th scope="col">Last deploy</th>
              </tr>
            </thead>
            <tbody>
              <For each={services()}>{service => <ServiceRow service={service} />}</For>
            </tbody>
          </table>
        </div>
      </Widget>
    </Show>
  );
}

function ServiceRow(props: { readonly service: Service }): JSX.Element {
  const { now, tick, manualTick } = useTelemetry();
  const serviceTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const [deployments, setDeployments] = createSignal<DeploymentHistory | null>(null);
  const [settled, setSettled] = createSignal(false);
  createEffect(() => `${props.service.name}:${serviceTick()}:${manualTick()}`, () => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void loadServiceDeploymentHistory(props.service.name, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setDeployments(value);
      setSettled(true);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setDeployments(null);
      setSettled(true);
    });
  });
  const latest = () => {
    const history = deployments();
    const deployment = history?.deployments[0];
    return history === null || deployment === undefined ? null : { title: deploymentTitle(history, deployment, "service"), atMs: deployment.atMs };
  };
  return (
    <tr>
      <td><EntityCell marker={<span class="status-dot tone-neutral" aria-hidden="true" />} name={props.service.name} href={`#/service/${props.service.name}`} id={props.service.unit ?? props.service.name} /></td>
      <td class="numeric">{props.service.hostIds.length}</td>
      <td>{props.service.healthUrl === null ? <span class="cell-note">unavailable, no health URL</span> : <span class="mono services-url" title={props.service.healthUrl}>{props.service.healthUrl}</span>}</td>
      <td>
        <Show when={latest()} fallback={settled() ? <span class="cell-note">none recorded</span> : <span class="cell-pending" aria-hidden="true" />}>{deployment => (
          <span class="cell-stack"><span class="mono">{deployment().title}</span><span class="cell-note">{age(deployment().atMs, now())}</span></span>
        )}</Show>
      </td>
    </tr>
  );
}
