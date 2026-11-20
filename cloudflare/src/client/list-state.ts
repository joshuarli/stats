import { onCleanup } from "solid-js";
import type { Sort } from "./components/sort";

export const hostStatusFilters = ["online", "stale", "no samples", "revoked"] as const;
export type HostStatusFilter = (typeof hostStatusFilters)[number];
export type HostSortKey = "name" | "status" | "cpu" | "memory" | "load" | "diskSpace" | "diskIO" | "network";
export type ProjectSortKey = "none" | "name" | "requests" | "errors" | "cpu" | "cost" | "deploy" | "collector";

export interface ListState {
  fleet: {
    search: string;
    selected: ReadonlySet<HostStatusFilter>;
    sort: Sort<HostSortKey>;
    page: number;
    returnHost: string | null;
  };
  projects: {
    search: string;
    sort: Sort<ProjectSortKey>;
    returnProject: string | null;
  };
}

export function createListState(): ListState {
  return {
    fleet: { search: "", selected: new Set(), sort: { key: "status", direction: 1 }, page: 1, returnHost: null },
    projects: { search: "", sort: { key: "none", direction: 1 }, returnProject: null }
  };
}

export function restoreListFocus(link: HTMLAnchorElement): void {
  let observer: MutationObserver | undefined;
  const focusWhenConnected = () => {
    if (!link.isConnected) return;
    observer?.disconnect();
    if (document.activeElement === document.body) link.focus();
  };
  const frame = requestAnimationFrame(() => {
    if (link.isConnected) {
      focusWhenConnected();
    } else {
      observer = new MutationObserver(focusWhenConnected);
      observer.observe(document, { childList: true, subtree: true });
    }
  });
  onCleanup(() => { cancelAnimationFrame(frame); observer?.disconnect(); });
}
