import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation, useParams } from "@solidjs/router";
import { Skeleton } from "@laputa-systems/ui-dashboard";
import { ErrorState, Redirect } from "../components/ui";
import { loadCapabilities } from "../queries";
import { nativeProjects } from "./project/native-series";

const CloudflareProjectPage = lazy(() => import("./CloudflareProjectPage").then(module => ({ default: module.CloudflareProjectPage })));

export function ProjectPage(): JSX.Element {
  const capabilities = createMemo(loadCapabilities);
  const params = useParams();
  const location = useLocation();
  return <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}><Loading fallback={<Skeleton rows={2} />}><Show when={nativeProjects(capabilities())} fallback={<CloudflareProjectPage />}><Redirect href={`/service/${encodeURIComponent(params.projectId ?? "")}${location.search}`} /></Show></Loading></Errored>;
}
