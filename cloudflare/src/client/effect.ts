import { createEffect } from "solid-js";

export function createUpdateEffect<T>(compute: () => T, apply: (value: T, previous: T | undefined) => void | (() => void)): void {
  let mounted = false;
  createEffect(compute, (value, previous) => {
    if (!mounted) {
      mounted = true;
      return;
    }
    return apply(value, previous);
  });
}
