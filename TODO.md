Prefix: STA
Next: 25

### STA-2 · P2 · Transient TLS and unclassified transport errors drop batches as permanent

- **Area:** Errors
- **Where:** `agent/src/transport.rs:98-119`, `agent/src/runtime.rs:92`
- **Problem:** `classify` maps `Error::Tls`, `Error::Rustls`, `Error::Http`, and the catch-all to `Permanent`. `classify_status` treats every status other than 429 and 5xx as permanent, including 408 and 425. `flush_once` drops a permanent batch with no requeue. On a host whose clock is still unsynced at boot, a certificate that is "not yet valid" is transient but discards each upload until NTP corrects the clock. The test at `transport.rs:313-331` asserts only `is_err()`. The classification and the drop are proven by code; that a not-yet-valid certificate surfaces as `Rustls` is `unproven`.
- **Recommendation:** Make only 400, 401, 403, 404, 413, and 422 and `BadUri` permanent, and treat everything else as retryable with backoff. Add one classification test per variant. The 401 and 403 handling depends on STA-3.
- **Fix with:** error-model
- **Effort:** S

### STA-3 · P2 · Upload failures and data loss are invisible while the system runs

- **Area:** Operability
- **Where:** `agent/src/runtime.rs:88-92`, `agent/src/runtime.rs:122-124`, `agent/src/runtime.rs:143-157`, `agent/src/queue.rs:36-39`, `agent/src/main.rs:134-137`, `cloudflare/src/installation.ts:277-283`, `cloudflare/src/installation.ts:416-417`, `cloudflare/cloudflare.config.ts`
- **Problem:** The agent discards every error message and prints counts only on exit. After a rotation or revocation it keeps sampling and keeps dropping every batch, and the owner learns nothing until SIGTERM. Agent-side drops are mixed into the server's `rejected` count, and final-flush drops are not counted at all. The Worker has no `console.*` call and no observability, so alarm failures and 500s leave no trace. The only live signal is staleness after 45 s, and a host whose batches are all rejected never goes stale.
- **Recommendation:** Log each failed flush (rate-limited, no token), count local drops separately, and log Worker errors with a fixed shape. How the agent handles 401 and whether to enable Workers Logs are owner calls in the RFC.
- **Fix with:** error-model
- **Effort:** M
- **Design:** [docs/rfc/STA-3-runtime-failure-visibility.md](docs/rfc/STA-3-runtime-failure-visibility.md)

### STA-18 · P3 · Fleet charts omit hosts that are not online now, even in past windows

- **Area:** Data
- **Where:** `cloudflare/src/client/pages/FleetPage.tsx:194-195`
- **Problem:** `reporting()` keeps only rows whose current status is online. A host that went stale a minute ago vanishes from the fleet charts. Zooming into an outage window shows nothing for the host that failed, while the table still shows its last point.
- **Recommendation:** Chart every row that has points in the window, and use current status only for styling.
- **Fix with:** root-cause
- **Effort:** S

### STA-19 · P3 · Zoom floor assumes the raw tier, and view state admits a frozen non-live page

- **Area:** Types
- **Where:** `cloudflare/src/client/components/TimeChart.tsx:38-39`, `cloudflare/src/client/components/TimeChart.tsx:222-226`, `cloudflare/src/client/state.ts:46-85`
- **Problem:** `MIN_ZOOM_MS` (30 s) assumes two 15 s raw samples. A short zoom on a window older than 48 h lands on 1 m or 1 h buckets and shows "No samples in this range" even though data exists. A selection under the floor is ignored without feedback. `view`, `trail`, and `live` are separate signals, and after zooming out to the preset range `live` stays off, so the page stops refreshing until the user presses `l`.
- **Recommendation:** Derive the minimum span from the tier the zoom would read (at least two steps). Model view state as one union (`live`, `paused`, or `zoomed` with its stack), and enforce the floor in `zoomTo`.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### STA-20 · P4 · Rollup rebuild runs outside the sample transaction

- **Area:** Concurrency
- **Where:** `cloudflare/src/installation.ts:329-381`
- **Problem:** `rebuildRollups` runs after the sample `transactionSync` commits. If it throws, the samples are stored, the client gets 500, and its retry sees only duplicates, so the affected minutes are never rebuilt. Not triggered.
- **Recommendation:** Move the rebuild into the same `transactionSync`.
- **Fix with:** durable-state
- **Effort:** S

### STA-21 · P4 · Config, token, and block file checks are by path, and the owner is not checked

- **Area:** Security
- **Where:** `agent/src/config.rs:89-109`, `agent/src/block.rs:66-87`
- **Problem:** `owner_file` and `block::read` run `symlink_metadata` and then `fs::read(path)`. A swap between the two calls defeats the symlink, size, and mode checks, and a swap to a FIFO hangs startup or the sampler thread. The mode is checked, but not that the file belongs to the running user. Exploiting this needs write access to the parent directory.
- **Recommendation:** Open with `O_NOFOLLOW | O_NONBLOCK`, `fstat` the descriptor, check uid and mode on it, and read at most limit + 1 bytes from it.
- **Fix with:** os-boundaries
- **Effort:** S

### STA-22 · P4 · An additive field in the ingest response makes the agent retry accepted batches

- **Area:** Types
- **Where:** `agent/src/transport.rs:48-50`, `agent/src/transport.rs:86-87`
- **Problem:** `IngestResponse` uses `deny_unknown_fields`, and a parse failure on 2xx is `Retryable`. Adding any field to the server response would requeue every accepted batch as a duplicate. Not live today: the server returns exactly `{v, accepted, duplicates, rejected}`.
- **Recommendation:** Drop `deny_unknown_fields` on the response type and treat a 2xx with `v: 1` as success.
- **Fix with:** error-model
- **Effort:** S

### STA-23 · P4 · Dead code in the agent and dashboard

- **Area:** Dead code
- **Where:** `agent/src/queue.rs:54`, `agent/src/transport.rs:149`, `cloudflare/src/client/format.ts:63`, `cloudflare/src/client/format.ts:84`, `cloudflare/src/client/style.css:71-72`
- **Problem:** `Queue::clear`, `HttpTransport::host_id`, `timestamp`, `shortTime`, and the `.spin` animation have no callers (`rg` finds only their definitions).
- **Recommendation:** Delete them.
- **Fix with:** delete
- **Effort:** S

### STA-24 · P4 · Dashboard decode failures discard which field broke

- **Area:** Errors
- **Where:** `cloudflare/src/client/api.ts:411-418`
- **Problem:** Both `catch` blocks replace the decoder's error with the generic "did not match the telemetry contract", so neither the user nor the console learns which field failed. No test feeds malformed bodies to the decoders.
- **Recommendation:** Keep the decode error as the `ApiFailure` cause, log it, and add one table test of malformed responses.
- **Fix with:** error-model
- **Effort:** S
