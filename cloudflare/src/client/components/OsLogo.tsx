import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { osFamily } from "../os";
import { OS_MARKS } from "../os-marks";

export function OsLogo(props: {
  readonly os: string | undefined;
  readonly size?: number | undefined;
  readonly tile?: boolean | undefined;
  readonly labelled?: boolean | undefined;
  readonly class?: string | undefined;
}): JSX.Element {
  const family = () => osFamily(props.os);
  return (
    <Show when={family()}>
      {(found) => (
        <span
          class={["os-logo", props.tile === true ? "os-logo-tile" : undefined, props.class].filter(Boolean).join(" ")}
          style={{ color: OS_MARKS[found()].color }}
          title={props.os}
          role={props.labelled === true ? "img" : undefined}
          aria-label={props.labelled === true ? `${props.os ?? "operating system"} logo` : undefined}
          aria-hidden={props.labelled === true ? undefined : "true"}
        >
          <svg width={props.size ?? 14} height={props.size ?? 14} viewBox="0 0 24 24" fill="currentColor">
            <path d={OS_MARKS[found()].path} />
          </svg>
        </span>
      )}
    </Show>
  );
}
