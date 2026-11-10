import type { JSX } from "@solidjs/web";
import { EmptyState, PageHeader } from "@laputa-systems/ui-dashboard";
import { useTelemetry } from "../state";
import { routeWithRange } from "../urlState";

export function NotFoundPage(): JSX.Element {
  const { range } = useTelemetry();
  return (
    <>
      <PageHeader title="Page not found"><span class="page-sub">The requested dashboard route does not exist.</span></PageHeader>
      <EmptyState
        icon="search"
        title="Nothing lives at this address."
        detail="Use the fleet overview to choose a host or refresh the dashboard."
        action={<a class="btn" href={routeWithRange("#/", range())}>Back to hosts</a>}
      />
    </>
  );
}
