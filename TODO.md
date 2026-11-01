Prefix: STA
Next: 31

### STA-27 · P3 · A valid Linux disk id with a 7-digit minor is rejected

- **Area:** Data
- **Where:** `cloudflare/src/protocol.ts:120`, `cloudflare/src/protocol.ts:225`, `agent/tests/fixtures.rs:80-83`, `docs/protocol.md:38`
- **Problem:** Linux `dev_t` allows a 20-bit minor, up to 1,048,575 (seven digits), but the Worker's `DISK_ID` regex allows at most six minor digits. The agent's `parse_diskstats` and the fixture validator accept any digit length, so an agent on a host with such a device sends a sample the Worker rejects as `invalid_sample`; every sample containing that device is lost. Probes against `parseBatch`: `8:999999` is accepted, `8:1000000` and `8:1048575` are rejected. No fixture covers the boundary.
- **Recommendation:** Accept the Linux `dev_t` bounds in both validators (major at most 4095, minor at most 1,048,575), add an accepted boundary fixture and a rejected out-of-range fixture to `fixtures/v1`, and state the bounds in `docs/protocol.md`.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### STA-28 · P3 · sampleIntervalMs and uploadIntervalMs accept values the service cannot serve

- **Area:** Config
- **Where:** `agent/src/config.rs:132-136`, `cloudflare/src/limits.ts:5`, `cloudflare/src/client/chart-data.ts:16-18`, `README.md:63-65`, `docs/architecture.md:43`
- **Problem:** The config accepts a 1,000 ms sample interval, but raw history uses a fixed 15,000 ms `stepMs` and `alignSeries` snaps to it. A supported 10,000 ms host loses every other point: points at 0, 10, 20, 30, and 40 seconds align to 0, 15, 30, and 45, and the 10-second value is overwritten by the 20-second value. The config also accepts a 1,000 ms upload interval, but the Worker allows six requests per host per minute; the agent is rate-limited and can overflow its queue. The README warns about the upload interval, but neither bound is enforced and the architecture doc says the sample minimum is 1,000 ms.
- **Recommendation:** Reject `sampleIntervalMs` below 15,000 and `uploadIntervalMs` below 10,000 in `config.rs`, matching the raw history step and the server's rate limit. Update the README and architecture text and add a config test. If sub-15-second sampling is ever required, the raw history step must become per-host before the limit is relaxed.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### STA-29 · P4 · Dead exports in the agent and Worker

- **Area:** Dead code
- **Where:** `cloudflare/src/protocol.ts:4-5`, `cloudflare/src/protocol.ts:267`, `cloudflare/src/auth.ts:16-22`, `agent/src/lib.rs:13`
- **Problem:** `sampleBytes`, `validHostId`, `validToken`, the `RejectCode` and `MAX_BODY_BYTES` re-exports in `protocol.ts`, and `pub use model::Sample` have no callers; `rg` finds only their definitions. The dead validators repeat the host and token patterns that `protocol.ts` and `bearerToken` actually enforce, so a future format change can drift.
- **Recommendation:** Delete them and keep the imports that `parseBatch` and the types still use.
- **Fix with:** delete
- **Effort:** S

### STA-30 · P4 · Block snapshot freshness and mode checks are untested

- **Area:** Tests
- **Where:** `agent/src/block.rs:67-85`, `agent/src/block.rs:140-178`
- **Problem:** `read_snapshot` rejects a snapshot older than 30 seconds or writable by group or other, and `bpf/README.md` states both conditions. The tests cover parsing, canonical decimals, and attaching each snapshot once, but not the age or mode rejection; removing either check leaves the suite green.
- **Recommendation:** Add tests for a stale snapshot and a group-writable snapshot. The owner check needs root to exercise and can stay covered by inspection.
- **Fix with:** test-audit
- **Effort:** S
