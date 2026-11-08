# @stats/producer

Bounded, non-blocking application telemetry for Stats. `record` never waits
for the network; `flush` and `shutdown` drain the queue.

```ts
import { createProducer } from "@stats/producer";

const producer = createProducer({
  endpoint: "https://stats.17166969.xyz",
  service: "tansu",
  token: () => process.env.STATS_INGEST_TOKEN!,
  release: process.env.RELEASE ?? "dev",
  instance: process.env.HOSTNAME,
  host: "lisa",
});

producer.record({ operation: "note.save", outcome: "ok", durationMs: 12, work: { bytes: 512, revisions: 1 } });
await producer.flush();
```

A failing operation may carry `errorCode`, a fixed label from the
application's own closed set matching `^[a-z][a-z0-9_.-]{0,63}$`. Stats groups
coded failures into issues. Never put a message, stack, or input-derived text
in it. An event with an invalid code, or a code on outcome `ok`, is dropped and
counted as `invalid_event`.

```ts
producer.record({ operation: "note.save", outcome: "error", durationMs: 30, errorCode: "db.timeout" });
```

`createProducer()` with no config, or with an empty endpoint, service, release,
or static token, returns a no-op producer that opens no connections.

## Delivery

- The queue holds at most 256 events by default and is capped at 256. The
  worst-case encoded event is 1,512 bytes, so the queue stays under 0.4 MiB.
  When it is full the oldest event is dropped and counted in `stats().dropped`.
- A batch holds at most 64 events by default and never exceeds the protocol
  limits of 128 events or 64 KiB.
- Requests time out after 5 s. Retryable failures (network, timeout, 408, 425,
  429, 5xx, or a malformed success body) are retried 5 times with exponential
  backoff and jitter; 429 honours `Retry-After`.
- 400, 404, 413, 415 and other permanent 4xx responses are not retried. A
  malformed body is never retried after the final attempt.
- A 401 or 403 retries once when the token provider returns a different value,
  so a rotated token is picked up without a restart.
- `flush()` and `shutdown()` resolve even when the final batch was dropped;
  inspect `stats().lastError` and `stats().dropped`.
- `stats()` reports `queued`, `dropped`, `sent`, `duplicates`, `batches`,
  `retries`, and `lastError`.

Call `shutdown()` before process exit to flush the queue and stop the flush
timer.

Version 0.2.0.
