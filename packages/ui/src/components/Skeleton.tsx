import type { JSX } from "@solidjs/web";

export interface SkeletonProps {
  readonly rows?: number | undefined;
  readonly chart?: boolean | undefined;
  readonly class?: string | undefined;
}

export function Skeleton(props: SkeletonProps): JSX.Element {
  const classes = () => ["ui-skeleton", props.class].filter(Boolean).join(" ");
  return (
    <div class={classes()} aria-hidden="true">
      {Array.from({ length: props.rows ?? 3 }, () => <span class="ui-skeleton-line" />)}
      {props.chart === true ? <span class="ui-skeleton-chart" /> : null}
    </div>
  );
}
