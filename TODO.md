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

### STA-4 · P2 · Retention alarm falls behind past about 25 hosts and scans without an index

- **Area:** Data
- **Where:** `cloudflare/src/installation.ts:276-283`, `cloudflare/src/installation.ts:67-90`
- **Problem:** Each alarm deletes at most 1000 rows per tier and reschedules after 60 s only when `raw + minute + hour >= 3000`, which requires all three tiers to be full in the same run. A probe confirmed `rowsWritten` is 1000 for a full raw batch. With only raw behind, the next alarm is 10 minutes out, so the drain rate is about 144k rows per day. A host writes 5760 raw samples per day (`make fixtures` cost table), so past about 25 hosts raw storage grows without bound toward the Durable Object ceiling. `EXPLAIN QUERY PLAN` shows `SCAN samples` for `received_at_ms < ?`, and the rollup delete scans the `(host_id, …)` index. The alarm test deletes one row per tier and asserts nothing about rescheduling.
- **Recommendation:** Reschedule in 60 s whenever any tier deleted a full batch. Index the retention predicates (`samples(received_at_ms)`, `rollups(resolution, bucket_ms)`; this needs STA-6 for existing objects). Add an alarm test with more than 1000 expired rows in one tier.
- **Fix with:** durable-state
- **Effort:** S

### STA-6 · P3 · Durable Object SQLite has no schema version or migration path

- **Area:** Data
- **Where:** `cloudflare/src/installation.ts:57-90`, `cloudflare/src/installation.ts:138-143`
- **Problem:** The schema is `CREATE TABLE/INDEX IF NOT EXISTS` with no `user_version` and no `ALTER`. A deploy that adds a column or index leaves the live object on the old shape. Tests still pass because every test object is fresh, while production requests fail. `rollups.payload` carries `v: 1`, but nothing reads it, so a changed rollup shape would mix with old rows.
- **Recommendation:** Keep a numbered migration list applied in `blockConcurrencyWhile` and gated on `PRAGMA user_version`. Add one test that opens an object created with the previous schema.
- **Fix with:** durable-state
- **Effort:** M

### STA-7 · P3 · Admin caller errors return 500 with the raw exception text

- **Area:** Errors
- **Where:** `cloudflare/src/installation.ts:155-175`, `cloudflare/src/installation.ts:403-417`
- **Problem:** A probe showed that an invalid host name, a non-JSON body, and rotating an unknown host each return 500 `internal`, with messages such as `Unexpected token 'o', "notjson" is not valid JSON`. The catch-all echoes `error.message` for any exception, so internal SQLite messages reach the client too. Tooling cannot tell a typo from a server fault.
- **Recommendation:** Return typed results from `createHost` and `rotateHost` (400 `invalid_request`, 404 `not_found`), map JSON parse failure to 400, and send fixed text on 500, logging the cause per STA-3.
- **Fix with:** error-model
- **Effort:** S

### STA-8 · P3 · Limits, retention, ranges, and enums are repeated across server, client, agent, and fixture check

- **Area:** Architecture
- **Where:** `cloudflare/src/installation.ts:250`, `cloudflare/src/installation.ts:252`, `cloudflare/src/installation.ts:269`, `cloudflare/src/installation.ts:279-280`, `cloudflare/src/installation.ts:295`, `cloudflare/src/aggregate.ts:8-17`, `cloudflare/src/aggregate.ts:121`, `cloudflare/src/protocol.ts:1`, `cloudflare/src/client/state.ts:5-20`, `agent/src/parse.rs:199`, `bpf/biolatency-collector.bt`, `scripts/check-fixtures.mjs:8-10`, `scripts/check-fixtures.mjs:36-37`, `scripts/check-fixtures.mjs:58-68`
- **Problem:** The 7 d and 90 d retention literals appear separately in tier selection and in the alarm. `history()` uses a literal 900 next to `MAX_POINTS`. The ingest cap repeats `MAX_BODY_BYTES`. The client repeats the range list and milliseconds, and `HistoryQuery.range` and `kind` are untyped strings. The filesystem allow-list, block bucket bounds, and error codes each live in two or three places with no parity check. A retention change in one place silently breaks tier selection, cleanup, or the fixture cost table.
- **Recommendation:** Export the retention, tier, range, and point constants from one server module that the client imports. Type the client query with `RangeKey` and `HistoryKind`. Add one test that checks the agent's filesystem list and the bucket bounds against the server's.
- **Fix with:** single-source-of-truth
- **Effort:** M

### STA-9 · P3 · Agent builds are not pinned and neither the agent nor the Worker can be rolled back

- **Area:** Build
- **Where:** `agent/scripts/build-static.sh:15-18`, `agent/scripts/build-static.sh:23`, `agent/scripts/build-static.sh:45`, `tools/zig-cc-x86_64-linux-musl`, `deploy/deploy-host.sh:119-121`
- **Problem:** Zig comes from `PATH` with no version check, and the wrappers need an undeclared `python3`. `cargo build` runs without `--locked`. The version in `Cargo.toml` never changes, and `rm -f "$dist"/*` removes the previous artifacts. The recorded identical-digest result is not enforced. `deploy-host.sh` overwrites `/usr/local/bin/stats` and keeps no previous copy, so an agent rollback means rebuilding an old commit with whatever Zig is installed. No Worker rollback procedure exists.
- **Recommendation:** Check the Zig version in `build-static.sh`, build with `--locked`, keep `/usr/local/bin/stats.prev` on deploy with a `make rollback-host-<key>`, and document the `cf` command that restores the previous Worker version.
- **Fix with:** none
- **Effort:** M

### STA-10 · P3 · Host deploy installs non-atomically and reports success before the agent uploads

- **Area:** Operability
- **Where:** `deploy/deploy-host.sh:119-121`, `deploy/deploy-host.sh:157`, `deploy/deploy-host.sh:66-68`
- **Problem:** The binary is installed straight to `/usr/local/bin/stats`, and the remote `mktemp /tmp/stats.XXXXXX` file is left behind if a later step fails. The only post-check is `is_active` immediately after the restart. With `Restart=always`, an agent that crashes on startup can still read as active. Nothing checks that the host's `lastReceivedAtMs` advances. `ssh` takes the target without `--`.
- **Recommendation:** Install to `stats.new` and `mv` it into place, trap-remove the remote temp file, and after the restart poll until `/api/v1/hosts` shows a fresh receipt for the host.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### STA-11 · P3 · Deploy paths skip gates or bypass them

- **Area:** Build
- **Where:** `Makefile:57-60`, `Makefile:78-79`, `package.json:17`, `cloudflare/package.json:15`, `cloudflare/cloudflare.config.ts:24`, `bench/bench.sh:4-8`
- **Problem:** `make deploy` does not run `fixtures`, and it uploads a bundle that `worker-bundle` rebuilt after the tests, not the one Playwright tested. Its prerequisites are unordered, so `make -j` would race two `vite build` runs. The `deploy` scripts in both `package.json` files run `cf deploy --prebuilt` with no tests and without `--mode production`. Without `STATS_DOMAIN` they also set `domains: []`; whether that detaches the custom domain is `unproven`. `make release` counts `bench.sh --selftest`, which only echoes fixed text, as a passing check.
- **Recommendation:** Delete both `deploy` scripts. Make `deploy` depend on `fixtures` and run tests and upload strictly in order on one bundle. Remove the selftest branch and its `release` step.
- **Fix with:** none
- **Effort:** S

### STA-12 · P3 · Access JWT signature rejection is untested

- **Area:** Tests
- **Where:** `cloudflare/test/access.test.ts:34-47`, `cloudflare/src/access.ts:79-91`, `cloudflare/test/ingest.test.ts:77-81`
- **Problem:** Every negative Access case signs with the real key and changes only claims or the header. None alters the signature or the payload after signing. There is also no case for a future `nbf`, for an `aud` array, or for a JWKS fetch failure returning 503. Making verification always succeed would leave the suite green. This check is the only gate on the admin routes. Separately, the abort test swallows any error from `state.abort()` in an empty `catch`.
- **Recommendation:** Add cases for a tampered signature, a tampered payload, a future `nbf`, an array `aud`, and a missing JWKS. Replace the empty `catch` with an assertion on the expected abort error.
- **Fix with:** test-audit
- **Effort:** S

### STA-13 · P3 · Agent upload loop, shutdown, and real sample shape are untested

- **Area:** Tests
- **Where:** `agent/src/runtime.rs:110-223`, `agent/src/linux.rs`, `agent/tests/fixtures.rs:253-324`
- **Problem:** Only `flush_once` and `sleep_interruptible` have tests. Nothing covers `upload_loop`, a stop followed by a final flush, or status classification. `linux.rs` compiles only on Linux, so the macOS run of `make agent-test` exercises none of the collectors. No test runs a real `sample()` through the fixture validator, and `serializer_uses_the_wire_names` checks only a few keys.
- **Recommendation:** Add a fake-sender `upload_loop` test for stop and final flush, and a Linux-only test that validates `sample()` output against the fixture validator.
- **Fix with:** test-audit
- **Effort:** M

### STA-14 · P3 · Agent stop time can exceed the init's stop timeout

- **Area:** Concurrency
- **Where:** `agent/src/runtime.rs:143-157`, `agent/src/config.rs:131`, `agent/contrib/systemd/stats.service`, `agent/contrib/supervise.sh:6-27`
- **Problem:** The 5 s final-flush deadline is checked only after a send returns, so the real bound is the in-flight upload plus one final upload, each up to `requestTimeoutMs`. The allowed maximum of 120000 gives about 240 s, which is past systemd's default 90 s stop timeout and ends in SIGKILL. `supervise.sh` never resets its backoff after a healthy run and defers TERM until a foreground `sleep` of up to 60 s finishes.
- **Recommendation:** Give the final upload its own short request timeout and cap `requestTimeoutMs` at 30 s. In `supervise.sh`, reset the delay after a run longer than 60 s and sleep in the background with `wait`.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### STA-15 · P3 · A block-latency snapshot can be attached to two samples or skipped

- **Area:** Data
- **Where:** `agent/src/runtime.rs:174-181`, `agent/src/block.rs:66-87`, `bpf/collector.sh`
- **Problem:** The collector rewrites the snapshot every 15 s. The agent samples every 15 s on an independent phase and attaches any snapshot younger than 30 s. Drift between the two phases can attach the same interval histogram to consecutive samples, which the server then sums twice, or skip one entirely. The snapshot has no sequence number and the agent remembers no mtime. `unproven` on a live host.
- **Recommendation:** Remember the last attached mtime (or add a snapshot sequence) and attach each snapshot at most once.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### STA-16 · P3 · Network interfaces past 16 are picked in directory order

- **Area:** Data
- **Where:** `agent/src/linux.rs:29-37`, `agent/src/linux.rs:135-164`
- **Problem:** `read_names` returns `read_dir` order, and the collector keeps the first 16 valid interfaces. On container hosts with many veth or bridge interfaces, the reported set can shift between samples, and each shift restarts series. Disks and mounts are sorted before truncation; interfaces are not. `unproven` on a live host.
- **Recommendation:** Sort the names, with physical interfaces first, before taking 16.
- **Fix with:** root-cause
- **Effort:** S

### STA-17 · P3 · Unauthenticated ingest is parsed inside the single Durable Object

- **Area:** Security
- **Where:** `cloudflare/src/index.ts:34-35`, `cloudflare/src/installation.ts:291-303`
- **Problem:** Access bypasses `/ingest/*`, and the Worker forwards every POST, with or without a token, to the one global object. The object reads up to 64 KiB and parses the JSON before it checks the bearer token. Junk POSTs queue on the single-threaded object that also serves the dashboard. The per-host rate limit applies only after authentication. Not load-tested.
- **Recommendation:** In the Worker, reject a missing or malformed bearer token and an oversized `content-length` before touching the stub, and add a Cloudflare rate-limit rule on `/ingest/*`.
- **Fix with:** security
- **Effort:** S

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
