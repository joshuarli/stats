import { encodeBatch, MAX_METRIC_BATCH_BYTES, MAX_METRIC_PAYLOAD_BYTES, type Batch, type Scrape } from "../../../cloudflare/src/metrics/codec.ts";

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

function removeSeries(scrape: Scrape): boolean {
  for (const family of Object.keys(scrape.values).reverse()) {
    if (family === "openorange_worker_info" || family === "openorange_worker_start_time_seconds") continue;
    const series = scrape.values[family]!;
    if (series.length === 0) continue;
    series.pop();
    if (series.length === 0) delete scrape.values[family];
    scrape.dropped.series_cap++;
    return true;
  }
  return false;
}

export function boundBatch(batch: Batch): void {
  for (const scrape of batch.scrapes) {
    const payload = () => ({ values: scrape.values, dropped: scrape.dropped, durationUs: scrape.durationUs, bytes: scrape.bytes });
    const count = () => Object.values(scrape.values).reduce((total, series) => total + series.length, 0);
    while (count() > 256 || bytes(payload()) > MAX_METRIC_PAYLOAD_BYTES) {
      if (!removeSeries(scrape)) throw new Error("metrics payload cannot fit");
    }
  }
  while (bytes(batch) > MAX_METRIC_BATCH_BYTES - 1024) {
    const largest = [...batch.scrapes].sort((a, b) => bytes(b.values) - bytes(a.values));
    if (!largest.some(removeSeries)) throw new Error("metrics batch cannot fit");
  }
  encodeBatch(batch);
}
