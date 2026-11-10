import { createEffect, createMemo, createSignal, Errored, For, isPending, Loading, onCleanup, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Service } from "../api";
import { age, errorMessage } from "../format";
import { loadServices } from "../queries";
import { PROJECT_REFRESH_TICKS, useTelemetry } from "../state";
import { EmptyState, Skeleton } from "@laputa-systems/ui-dashboard";
import { EntityCell, ErrorState, Widget } from "../components/ui";
import { compareSortValues, createSort, SortHeader } from "../components/sort";
import { createUpdateEffect } from "../effect";
import { routeWithRange } from "../urlState";
import type { DeploymentHistory } from "../../deployments/model";
import { deploymentTitle, loadServiceDeploymentHistory } from "./project/Deployments";
import "./project/services.css";
import "./project/services-list.css";

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
  const { sort, sortBy } = createSort<"none" | "service" | "hosts" | "probe" | "deploy">({ key: "none", direction: 1 });
  const [deployTimes, setDeployTimes] = createSignal<ReadonlyMap<string, number | null>>(new Map());
  const reportDeploy = (name: string, deployAtMs: number | null) => setDeployTimes(current => {
    if (current.get(name) === deployAtMs) return current;
    const next = new Map(current);
    next.set(name, deployAtMs);
    return next;
  });
  const sortedServices = createMemo(() => {
    const key = sort().key;
    if (key === "none") return services();
    const direction = sort().direction;
    const values = deployTimes();
    const value = (service: Service): number | string | null => {
      if (key === "service") return service.name;
      if (key === "hosts") return service.hostIds.length;
      if (key === "probe") return service.healthUrl;
      return values.get(service.name) ?? null;
    };
    return [...services()].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) return left.name.localeCompare(right.name);
        return leftValue === null ? 1 : -1;
      }
      return compareSortValues(leftValue, rightValue) * direction || left.name.localeCompare(right.name);
    });
  });
  return (
    <Show
      when={services().length > 0}
      fallback={
        <Widget title="Services">
          <EmptyState title="No services are configured." detail="Create one with POST /api/v1/admin/services; see docs/operations.md." />
        </Widget>
      }
    >
      <Widget id="services" title="Services" class={isPending(services) ? "widget-pending" : undefined} bodyClass="flush" meta={<span class="services-basis">Deployments are markers pushed by deploy scripts</span>}>
        <div class="table-scroll" role="region" aria-label="Services table">
          <table class="data-table services-table" aria-label="Services">
            <thead>
              <tr>
                <SortHeader label="Service" sortKey="service" sort={sort()} onSort={sortBy} />
                <SortHeader label="Hosts" sortKey="hosts" sort={sort()} onSort={sortBy} class="numeric" />
                <SortHeader label="Health probe" sortKey="probe" sort={sort()} onSort={sortBy} />
                <SortHeader label="Last deploy" sortKey="deploy" sort={sort()} onSort={sortBy} />
              </tr>
            </thead>
            <tbody>
              <For each={sortedServices()}>{service => <ServiceRow service={service} reportDeploy={reportDeploy} />}</For>
            </tbody>
          </table>
        </div>
      </Widget>
    </Show>
  );
}

function ServiceRow(props: { readonly service: Service; readonly reportDeploy: (name: string, deployAtMs: number | null) => void }): JSX.Element {
  const { now, tick, manualTick, range } = useTelemetry();
  const serviceTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const [deployments, setDeployments] = createSignal<DeploymentHistory | null>(null);
  const [settled, setSettled] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  createEffect(() => `${props.service.name}:${serviceTick()}:${manualTick()}`, () => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void loadServiceDeploymentHistory(props.service.name, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setDeployments(value);
      setFailure(null);
      setSettled(true);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setFailure(errorMessage(error));
      setSettled(true);
    });
  });
  const latest = () => {
    const history = deployments();
    const deployment = history?.deployments[0];
    return history === null || deployment === undefined ? null : { title: deploymentTitle(history, deployment, "service"), atMs: deployment.atMs };
  };
  createEffect(
    () => ({ name: props.service.name, deployAtMs: latest()?.atMs ?? null }),
    value => {
      props.reportDeploy(value.name, value.deployAtMs);
    }
  );
  return (
    <tr>
      <td><EntityCell marker={<span class="status-dot tone-neutral" aria-hidden="true" />} name={props.service.name} href={routeWithRange(`#/service/${props.service.name}`, range())} id={props.service.unit ?? props.service.name} /></td>
      <td class="numeric">{props.service.hostIds.length}</td>
      <td>{props.service.healthUrl === null ? <span class="cell-note">unavailable, no health URL</span> : <span class="mono services-url" title={props.service.healthUrl}>{props.service.healthUrl}</span>}</td>
      <td>
        <Show when={latest()} fallback={failure() !== null ? <span class="cell-note" role="status" title={failure() ?? undefined}>deployments unavailable</span> : settled() ? <span class="cell-note">none recorded</span> : <span class="cell-pending" aria-hidden="true" />}>{deployment => (
          <span class="cell-stack"><span class="mono">{deployment().title}</span><span class="cell-note" title={failure() ?? undefined}>{age(deployment().atMs, now())}{failure() === null ? "" : " · refresh failed"}</span></span>
        )}</Show>
      </td>
    </tr>
  );
}
