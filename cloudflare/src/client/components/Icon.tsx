import { For } from "solid-js";
import type { JSX } from "@solidjs/web";

const paths = {
  host: ["M4 5h16v6H4z", "M4 13h16v6H4z", "M7 8h.01", "M7 16h.01"],
  search: ["M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z", "m15.2 15.2 4.3 4.3"],
  refresh: ["M20 11a8 8 0 1 0-2.3 6", "M20 4v7h-7"],
  chevronLeft: ["m14 6-6 6 6 6"],
  chevronRight: ["m10 6 6 6-6 6"],
  alert: ["M12 3 2.5 20h19L12 3Z", "M12 9v4", "M12 16h.01"],
  activity: ["M3 12h4l2.2-6 4.1 12L16 12h5"],
  disk: ["M4 6h16v12H4z", "M7 9h.01", "M7 15h.01", "M11 9h6", "M11 15h6"],
  network: ["M12 4v5", "M6 20v-4", "M18 20v-4", "m6 16 6-7 6 7", "M4 20h4", "M10 20h4", "M16 20h4"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 11v5", "M12 8h.01"],
  expand: ["M14 4h6v6", "M10 20H4v-6", "m20 4-6.5 6.5", "m4 20 6.5-6.5"],
  arrowRight: ["M5 12h14", "m13 6 6 6-6 6"],
  sortUp: ["m6 14 6-6 6 6"],
  sortDown: ["m6 10 6 6 6-6"]
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof paths;

export function Icon(props: { readonly name: IconName; readonly size?: number | undefined; readonly class?: string | undefined }): JSX.Element {
  return (
    <svg
      class={props.class === undefined ? "icon" : `icon ${props.class}`}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <For each={paths[props.name]}>{(path) => <path d={path} />}</For>
    </svg>
  );
}
