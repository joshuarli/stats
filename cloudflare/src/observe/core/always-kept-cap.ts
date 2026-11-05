import { COUNT_BUCKET_MS } from "./limits.ts";

export const ALWAYS_KEPT_PER_BUCKET = 10;

const REMEMBERED_BUCKETS = 2;

export class AlwaysKeptCap {
  readonly #admitted = new Map<number, number>();

  admit(bucketAt: number): boolean {
    const used = this.#admitted.get(bucketAt) ?? 0;
    for (const known of this.#admitted.keys()) {
      if (known + REMEMBERED_BUCKETS * COUNT_BUCKET_MS <= bucketAt) this.#admitted.delete(known);
    }
    if (used >= ALWAYS_KEPT_PER_BUCKET) return false;
    this.#admitted.set(bucketAt, used + 1);
    return true;
  }
}
