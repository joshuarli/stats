import type { JSX } from "@solidjs/web";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/ui";

export function NotFoundPage(): JSX.Element {
  return (
    <>
      <PageHeader title="Page not found"><span class="page-sub">The requested dashboard route does not exist.</span></PageHeader>
      <EmptyState
        icon="search"
        title="Nothing lives at this address."
        detail="Use the fleet overview to choose a host or refresh the dashboard."
        action={<a class="btn" href="#/">Back to fleet</a>}
      />
    </>
  );
}
