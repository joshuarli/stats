import { createRouter, hashHistory } from "@solidjs/router";
import { lazy } from "solid-js";
import { FleetPage } from "./pages/FleetPage";

const HostPage = lazy(() => import("./pages/HostPage").then(module => ({ default: module.HostPage })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then(module => ({ default: module.ProjectsPage })));
const ProjectPage = lazy(() => import("./pages/ProjectPage").then(module => ({ default: module.ProjectPage })));
const ServicesPage = lazy(() => import("./pages/ServicesPage").then(module => ({ default: module.ServicesPage })));
const ServicePage = lazy(() => import("./pages/ServicePage").then(module => ({ default: module.ServicePage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then(module => ({ default: module.NotFoundPage })));

export const Router = createRouter({
  routes: [
    { path: "/", component: FleetPage },
    { path: "/projects", component: ProjectsPage },
    { path: "/host/:hostId", component: HostPage, matchFilters: { hostId: /^h_[0-9a-f]{32}$/ } },
    { path: "/project/:projectId", component: ProjectPage, matchFilters: { projectId: /^[a-z][a-z0-9-]{0,31}$/ } },
    { path: "/services", component: ServicesPage },
    { path: "/service/:serviceName", component: ServicePage, matchFilters: { serviceName: /^[a-z][a-z0-9-]{0,31}$/ } },
    { path: "*404", component: NotFoundPage }
  ],
  history: hashHistory()
});
