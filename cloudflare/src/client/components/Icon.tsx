import { For } from "solid-js";
import type { JSX } from "@solidjs/web";

const paths = {
  overview: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"],
  host: ["M4 5h16v6H4z", "M4 13h16v6H4z", "M7 8h.01", "M7 16h.01"],
  search: ["M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z", "m15.2 15.2 4.3 4.3"],
  refresh: ["M20 11a8 8 0 1 0-2.3 6", "M20 4v7h-7"],
  sun: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M4.9 19.1l1.4-1.4", "M17.7 6.3l1.4-1.4"],
  moon: ["M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"],
  chevronLeft: ["m14 6-6 6 6 6"],
  chevronRight: ["m10 6 6 6-6 6"],
  alert: ["M12 3 2.5 20h19L12 3Z", "M12 9v4", "M12 16h.01"],
  check: ["m5 12 4.2 4.2L19 6.5"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7v5l3 2"],
  lock: ["M6 11h12v9H6z", "M9 11V8a3 3 0 0 1 6 0v3"],
  activity: ["M3 12h4l2.2-6 4.1 12L16 12h5"],
  disk: ["M4 6h16v12H4z", "M7 9h.01", "M7 15h.01", "M11 9h6", "M11 15h6"],
  network: ["M12 4v5", "M6 20v-4", "M18 20v-4", "m6 16 6-7 6 7", "M4 20h4", "M10 20h4", "M16 20h4"],
  cpu: ["M7 7h10v10H7z", "M9 3v2", "M15 3v2", "M9 19v2", "M15 19v2", "M3 9h2", "M3 15h2", "M19 9h2", "M19 15h2"],
  memory: ["M5 7h14v10H5z", "M8 10h2v4H8z", "M12 10h2v4h-2z", "M16 10h2v4h-2z", "M8 4v3", "M12 4v3", "M16 4v3", "M8 17v3", "M12 17v3", "M16 17v3"],
  gauge: ["M12 13 17 8", "M4 19a8 8 0 1 1 16 0", "M12 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"],
  arrowLeft: ["M19 12H5", "m11 6-6 6 6 6"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 11v5", "M12 8h.01"]
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
