import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation } from "@solidjs/router";
import { Skeleton } from "@laputa-systems/ui-dashboard";
import { ErrorState, Redirect } from "../components/ui";
import { loadCapabilities } from "../queries";
import { nativeProjects } from "./project/native-series";

const CloudflareProjectsPage = lazy(() => import("./CloudflareProjectsPage").then(module => ({ default: module.CloudflareProjectsPage })));

export function ProjectsPage(): JSX.Element {
  const capabilities = createMemo(loadCapabilities);
  const location = useLocation();
  return <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}><Loading fallback={<Skeleton rows={2} />}><Show when={nativeProjects(capabilities())} fallback={<CloudflareProjectsPage />}><Redirect href={`/services${location.search}`} /></Show></Loading></Errored>;
}
