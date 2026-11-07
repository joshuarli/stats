import type { JSX } from "@solidjs/web";
import { Icon } from "./Icon";

export interface PaginationProps {
  readonly page: number;
  readonly pages: number;
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly class?: string | undefined;
  readonly onChange: (page: number) => void;
}

export function Pagination(props: PaginationProps): JSX.Element {
  const classes = () => ["ui-pagination", props.class].filter(Boolean).join(" ");
  return (
    <div class={classes()}>
      <span>
        Showing <strong>{props.from}</strong>–<strong>{props.to}</strong> of <strong>{props.total}</strong>
      </span>
      <div class="ui-pagination-actions">
        <button
          class="ui-btn ui-btn-icon"
          type="button"
          aria-label="Previous page"
          disabled={props.page <= 1}
          onClick={() => props.onChange(props.page - 1)}
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <span>
          Page {props.page} of {props.pages}
        </span>
        <button
          class="ui-btn ui-btn-icon"
          type="button"
          aria-label="Next page"
          disabled={props.page >= props.pages}
          onClick={() => props.onChange(props.page + 1)}
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </div>
  );
}
