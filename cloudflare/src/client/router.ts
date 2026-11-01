import { createRouter, hashHistory } from "@solidjs/router";
import { FleetPage } from "./pages/FleetPage";
import { HostPage } from "./pages/HostPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export const Router = createRouter({
  routes: [
    { path: "/", component: FleetPage },
    { path: "/host/:hostId", component: HostPage, matchFilters: { hostId: /^h_[0-9a-f]{32}$/ } },
    { path: "*404", component: NotFoundPage }
  ],
  history: hashHistory()
});
