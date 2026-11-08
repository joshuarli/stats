# stats-producer

Bounded, non-blocking application telemetry for Stats. The crate reuses the
agent's `h12tiny-client-sync` TLS stack and a dedicated std thread; it does not
add Tokio or a second HTTP stack. `record` only enqueues, `flush` waits for the
queue to drain, and `shutdown` flushes and joins the worker.

```rust
use stats_producer::{OperationEvent, Producer, ProducerConfig};

let mut config = ProducerConfig::new(
    "https://stats.17166969.xyz",
    "tansu",
    std::env::var("STATS_INGEST_TOKEN")?,
    std::env::var("RELEASE").unwrap_or_else(|_| "dev".to_owned()),
);
config.instance = std::env::var("HOSTNAME").ok();
config.host = Some("lisa".to_owned());

let producer = Producer::new(config)?;
let mut event = OperationEvent::new("note.save", "ok", 12);
event.work.insert("bytes".to_owned(), 512);
producer.record(event);
producer.shutdown()?;
```

A failing operation may set `error_code`, a fixed label from the application's
own closed set matching `^[a-z][a-z0-9_.-]{0,63}$`. Stats groups coded failures
into issues. Never put a message, stack, or input-derived text in it. An event
with an invalid code, or a code on outcome `ok`, is dropped and counted as
`invalid_event`.

```rust
let mut event = OperationEvent::new("note.save", "error", 30);
event.error_code = Some("db.timeout".to_owned());
producer.record(event);
```

A `ProducerConfig` with an empty endpoint, service, token, or release is
disabled: it opens no connection and `record` is a no-op.

## Delivery

- The queue holds at most 256 events by default and is capped at 256. The
  worst-case encoded event is 1,512 bytes, so the queue stays under 0.4 MiB.
  When it is full the oldest event is dropped and counted in `stats().dropped`.
- A batch holds at most 64 events by default and never exceeds 128 events or
  64 KiB.
- Requests time out after 5 s. Retryable failures (network, timeout, 408, 425,
  429, 5xx, or a malformed success body) are retried 5 times with exponential
  backoff and jitter; 429 honours `Retry-After`.
- 400, 404, 413, 415 and other permanent 4xx responses are not retried.
- A 401 or 403 retries once when `replace_token` changed the token, so a rotated
  token is picked up without a restart.
- `flush()` and `shutdown()` return `Ok` even when the final batch was dropped;
  inspect `stats().last_error` and `stats().dropped`.
- `stats()` reports `queued`, `dropped`, `sent`, `duplicates`, `batches`,
  `retries`, and `last_error`.

`Producer` is `Send + Sync`; share it behind an `Arc` when several threads
record events.

Version 0.2.0.
