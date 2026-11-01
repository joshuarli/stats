Prefix: STA
Next: 31

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
