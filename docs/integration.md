# Stats integration contract

Stats owns this document. Tansu and Niceforge link here and document only their
concrete implementation. A change to any numbered section is a contract change:
surface it in the commit body with `!`.

The producer versions this contract targets are listed at the end.

## 1. Service identity

A service is the join key across deployment markers, application telemetry, and
operator reads. Its name is the path parameter in
`/ingest/observe/v1/:service/batches` and the `service` field of every event.

- A service name matches `^[a-z][a-z0-9-]{0,31}$`.
- Create a service with `POST /api/v1/admin/services` and
  `{ name, hostIds, healthUrl?, unit? }`. The `201` response carries the
  service plus `deployToken` and `ingestToken` exactly once.
- `GET /api/v1/services` and `GET /api/v1/services/:name` return
  `{ name, hostIds, healthUrl, unit, createdAtMs }` and never a token.
- The `service` field of an event must equal the path's service. A mismatch
  rejects the whole batch as `invalid_service`.
- A service is not a Stats host and not a Cloudflare project. It may share a
  name with either, but the identities are separate.

## 2. Host identity

A service's `hostIds` are registered agent hosts. Each is `h_` followed by 32
lowercase hex digits. They are stored sorted, contain 1 to 64 distinct ids, and
must be existing, non-revoked hosts when the service is created or a marker is
recorded.

- A deploy marker's `hostIds` is a non-empty subset of the service's hosts.
- The deploy credential file's `hostIds` is the default marker host set.
- The optional event fields `host` and `instance` are bounded application
  labels, not registered host ids. `host` matches
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; `instance` matches the same pattern.
  An absent label is absent, never `0` or `""`.
- The agent's host telemetry is separate. It posts binary frames to
  `/ingest/v2/batches` with its own host token; nothing in this contract
  authenticates or selects an agent host.

## 3. Release and attempt identity

`release` in an event and `version` in a deploy marker name the running
software. Use the same string for both.

- `release` matches `^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$` (1 to 64
  characters).
- Marker `version` matches `^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$` (1 to 128
  characters). A marker version longer than 64 characters cannot be correlated
  with application telemetry, because it cannot appear in `release`.
- Marker `markerId` matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. It is the
  deploy attempt's idempotency key. The CLI defaults it to `v-VERSION`.
- Event `eventId` matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. It is the
  telemetry attempt's idempotency key, unique within the service.
- `deployment.id` is a UUID derived from SHA-256 of the service name and
  `markerId`, so the same marker always names the same deployment.
- An optional `trace` is `{ traceId, spanId }`: a non-zero 32-character
  lowercase hex trace id and a non-zero 16-character lowercase hex span id.
- A retry reuses its `markerId` or `eventId`. A new attempt uses a new id.
  Elapsed time is never an attempt identity.

## 4. Health semantics

`healthUrl` is the service's own health endpoint, optional at creation. It is an
`https:` URL, or an `http:` URL on a host ending in `.ts.net`, with no
credentials or fragment, at most 2048 characters.

`statsctl service check --service NAME` reads the service and its marker
history, then sends one unauthenticated `GET` to `healthUrl` with a 5 second
timeout and redirects not followed:

- A `2xx` or `3xx` response is `up`.
- Any other response is `down`.
- A missing URL, a connection failure, or a timeout is `unavailable`.

Exit `0` means up with at least one marker, `5` means unavailable or no marker,
and `7` means the endpoint answered with a failing status. A `200` elsewhere
never proves health.

The Node server also probes each configured `healthUrl` on the five-minute
collection boundary. Results are stored under the `service:NAME` owner as
`probe.health.up` (1 or 0) and `probe.health.ms`; `probe.health.failure` in a
comparison is the complement of the mean `up` share. A target that does not
record probes leaves the series `unavailable`, never `0`. Health requests carry
no Access, Tailscale, deploy, or ingest credential.

## 5. Telemetry protocol version

Send one JSON object to `POST /ingest/observe/v1/:service/batches` with
`Content-Type: application/json` and `Authorization: Bearer <ingest token>`.
The route is versioned in the path; every event also carries
`schemaVersion: 1`.

The body is exactly `{ "events": [...] }` with 1 to 128 events. Each event has
exactly these fields; an unknown field rejects the whole batch:

| Field | Rule |
| --- | --- |
| `schemaVersion` | The integer `1`. |
| `eventId` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`, unique within the batch and the service. |
| `atMs` | Positive integer epoch milliseconds. Must be within the 7-day retention and no more than 5 minutes in the future. |
| `operation` | Low-cardinality operation name, `^[a-z][A-Za-z0-9_.-]{0,63}$`. |
| `outcome` | Low-cardinality outcome, `^[a-z][a-z0-9_-]{0,31}$`. |
| `durationMs` | Integer from 0 to 86,400,000. Application-reported duration. |
| `work` | Object of at most 16 measurements. Each key matches `^[a-z][a-z0-9_]{0,31}$`; each value is an integer from 0 to 1,000,000,000,000. `{}` is valid. |
| `release` | `^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$`. |
| `service` | The path's service, `^[a-z][a-z0-9-]{0,31}$`. |
| `instance` | Optional, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. |
| `host` | Optional, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. |
| `trace` | Optional `{ traceId, spanId }`: a non-zero 32-character lowercase hex `traceId` and a non-zero 16-character lowercase hex `spanId`. |

Caps and rejection:

- A body over 64 KiB is refused with `413 too_large` before JSON parsing.
- More than 128 events is `400 too_many_events`.
- Any malformed event rejects the whole batch; nothing from the batch is
  stored. The first problem's stable code is returned:
  `invalid_json`, `invalid_batch`, `too_many_events`, `invalid_event`,
  `invalid_schema_version`, `invalid_event_id`, `duplicate_event_id`,
  `invalid_time`, `expired_event`, `future_event`, `invalid_operation`,
  `invalid_outcome`, `invalid_duration`, `invalid_work`, `invalid_release`,
  `invalid_service`, `invalid_instance`, `invalid_host`, or `invalid_trace`.
- A service may send at most 120 batches in a fixed 60-second window; the next
  request is `429 rate_limited`.
- A successful new batch answers `202` with `{ "accepted": N, "duplicate": M }`.
  A batch whose event ids were all stored before answers `200` with
  `{ "accepted": 0, "duplicate": M }`.
- The same `(service, eventId)` with different content is `409 event_conflict`;
  nothing from that batch is stored. Identical content is a duplicate and is not
  stored twice.
- Events, and their event ids for deduplication, are retained for 7 days.
  Stored observations carry `provenance: "application"`. A reader must not
  confuse an application-reported `durationMs` with Cloudflare's `wallMs` or
  `cpuMs`, or with a host counter.
- Optional fields that are absent stay absent. Required counts may be a real
  `0`; an absent measurement never becomes `0`.

The golden frame and the malformed corpus are in `fixtures/observe-ingest/`.
JSON object order is not significant; the golden file is the canonical encoder
output of the TypeScript and Rust producers.

## 6. Credential scope

Each credential authenticates exactly one capability. A credential presented on
another capability's route is `401`, indistinguishably from a wrong token.

| Credential | Route | Cannot |
| --- | --- | --- |
| Service deploy token | `POST /ingest/services/:name/deployments` | ingest telemetry or manage the service |
| Service ingest token | `POST /ingest/observe/v1/:name/batches` | record a marker or manage the service |
| Host token | `POST /ingest/v2/batches` | any service route |
| Cloudflare Access or tailnet identity | `/api/v1/*` management and reads, `/api/observe/*` reads | write either service route |

- `POST /api/v1/admin/services` returns `deployToken` and `ingestToken` once.
  The service stores only their SHA-256 verifiers. Neither token can be read
  back.
- `statsctl service create` writes both to a new mode-0600 JSON file and never
  prints them. The file also holds `name`, `hostIds`, `healthUrl`, `unit`, and
  `createdAtMs`.
- `POST /api/v1/admin/services/:name/rotate` replaces the deploy verifier and
  returns `{ name, deployToken }`.
- `POST /api/v1/admin/services/:name/token/rotate` replaces the ingest verifier
  and returns `{ name, ingestToken }`.
- `DELETE /api/v1/admin/services/:name` removes the service, both verifiers, and
  its markers. Rotation or deletion invalidates the old credential immediately.
- A token never appears in argv, a URL, a log, telemetry, or a built asset. Send
  it only in the `Authorization` header to the configured origin.

## 7. Telemetry failure semantics

Telemetry must never fail or block the application operation that produced it.

- Producers enqueue synchronously and send from a worker. A full queue drops
  the oldest event and increments a bounded `dropped` count.
- The producer queue defaults to 256 events and cannot be configured above 256;
  a batch defaults to 64 events and
  never exceeds the 128-event or 64 KiB protocol cap.
- Requests time out after 5 seconds. Retryable failures are retried 5 times
  with exponential backoff and jitter; `429` honours `Retry-After`. Permanent
  `4xx` responses, including `413`, are not retried. A malformed `2xx` body is
  retried a bounded number of times and then dropped.
- A `401` or `403` is retried once when the token provider or `replace_token`
  returns a different token, so rotation needs no restart.
- An unconfigured producer is a no-op with no network activity.
- When Stats is unreachable or slow, events are dropped after the bounded
  retries. There is no disk spool in this version, and the application
  continues. Inspect `dropped`, `sent`, `duplicates`, `batches`, `retries`, and
  `lastError` from the producer's `stats()`. These counters do not reach Stats:
  the protocol has no field for them, so a service comparison cannot tell a
  dropped event from one that never happened. It reports per-work CPU and I/O as
  per observed work, withholds them for a five-minute bucket with no events
  while the service was up, and withholds every application metric when the
  event read is truncated or fails (`docs/architecture.md`, Service comparison).
  Check `dropped` before trusting a comparison.
- `flush()` and `shutdown()` drain within their bounds and do not throw for a
  dropped batch. Call `shutdown()` before process exit.

## 8. Rollback semantics

A rollback is a new activation of an older release, not a rewrite of history.

- Record a marker only after the candidate passes its readiness check and is
  serving. A failed candidate records no marker.
- Give a rollback its own `markerId`; the default `v-VERSION` is idempotent, so
  rolling back to a version whose default marker already exists records nothing
  and leaves the newer marker latest. Use `statsctl deploy mark --marker-id`.
- The rollback marker's `version` is the restored release and its `atMs` is the
  rollback time. Application events after it carry that `release`.
- A marker id recorded with a different version, message, or host set is
  `409 conflict`; a repeat with identical content answers `200` and creates
  nothing.
- Markers are retained for 30 days. A rollback older than that has no marker to
  correlate with.
- `service check` before and after a rollback follows section 4. This contract
  does not claim zero-downtime replacement; a singleton stateful service may
  pause.

## 9. Deployment-to-observation correlation

Join application events to a deployment on `service` and `release`, then on time:

- `event.service` equals the marker's service name.
- `event.release` equals the marker's `version`. The release rules in section 3
  make this exact-string join safe.
- `event.atMs` falls in the comparison window around `deployment.atMs`. The
  marker time is the server receive time; event time is application time; use a
  window, not exact equality.
- `deployment.id` and `markerId` identify the attempt; `eventId` identifies a
  telemetry attempt. Neither substitutes for a timestamp.

Reads:

- `GET /api/v1/services/:name/deployments` returns the marker history and
  `{ deploymentId, markerId, hostIds }` for each marker.
- `GET /api/observe/:service/external?from=<ms>&to=<ms>&limit=<n>` returns
  `{ events: [{ eventId, service, receivedAtMs, provenance, event }] }`, ordered
  by event time and then event id, bounded to the 7-day retention. It is behind
  Access or the tailnet identity, never a service token. `limit` is 1 to 5000
  (default 1000), so a busy service's day does not fit in one read.
- `GET /api/observe/:service/external/operations?from=<ms>&to=<ms>` totals the
  same events by operation in the store, over the half-open `[from, to)`
  clamped to retention, with no event cap: `{ fromMs, toMs, operations:
  [{ operation, events, failed, durationMsSum, durationMsMax, firstAtMs,
  lastAtMs }] }`, most events first. `failed` counts outcomes other than `ok`.
  `statsctl observe application --service NAME --window 24h` reads it; unlike
  `observe operations`, it accepts any service that reports application
  telemetry, because it reads the service's own events, not Cloudflare tail
  observation.
- `statsctl service deployments --service NAME` and
  `statsctl verify --service NAME` use the marker history. Verification compares
  resource levels and per-work application ratios around a marker. The
  application metrics are `application.duration` (ms per successful event),
  `application.failure` (failure share), and, for a named work counter,
  `application.durationPerWork` (ms per unit), `application.cpuPerWork`
  (CPU-seconds per unit), and `application.ioPerWork` (bytes per unit). A
  policy names the `operation`, and the per-work kinds also name `work`.

Provenance and privacy:

- Application events carry `provenance: "application"`. Host counters and
  Cloudflare tail observations keep their own provenance; never mix them in one
  ratio.
- `work` counts are the application's own measurements. A per-work ratio is
  valid only when the resource is attributable and the counter is complete;
  otherwise report `unavailable`. The counter is complete only when every
  successful (`outcome: "ok"`) event of that operation in the window reports
  it. A service cgroup resource is divided by work only when exactly one
  operation owned the service's successful events in that window; otherwise
  the ratio is unavailable with the reason. An unset, missing, or truncated
  event window is unavailable, never zero.
- Never send note titles or bodies, repository contents, filenames, paths,
  credentials, headers, environment values, or raw job output. Only bounded
  operation/outcome labels, counters, and optional instance/host labels belong
  in telemetry.

## Producer versions

| Package | Version | Registry |
| --- | --- | --- |
| `@stats/producer` | 0.1.0 | `https://npm.17166969.xyz` |
| `stats-producer` | 0.1.0 | `https://crates.17166969.xyz` |

Publication is an owner action: run `make publish-producer` and
`make publish-producer-crate` from a checkout whose registry credentials are
available. The versions above are the ones this contract targets.
