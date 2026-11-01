Prefix: STA
Next: 25

### STA-3 · P2 · Upload failures and data loss are invisible while the system runs

- **Area:** Operability
- **Where:** `agent/src/runtime.rs:88-92`, `agent/src/runtime.rs:122-124`, `agent/src/runtime.rs:143-157`, `agent/src/queue.rs:36-39`, `agent/src/main.rs:134-137`, `cloudflare/src/installation.ts:277-283`, `cloudflare/src/installation.ts:416-417`, `cloudflare/cloudflare.config.ts`
- **Problem:** The agent discards every error message and prints counts only on exit. After a rotation or revocation it keeps sampling and keeps dropping every batch, and the owner learns nothing until SIGTERM. Agent-side drops are mixed into the server's `rejected` count, and final-flush drops are not counted at all. The Worker has no `console.*` call and no observability, so alarm failures and 500s leave no trace. The only live signal is staleness after 45 s, and a host whose batches are all rejected never goes stale.
- **Recommendation:** Log each failed flush (rate-limited, no token), count local drops separately, and log Worker errors with a fixed shape. How the agent handles 401 and whether to enable Workers Logs are owner calls in the RFC.
- **Fix with:** error-model
- **Effort:** M
- **Design:** [docs/rfc/STA-3-runtime-failure-visibility.md](docs/rfc/STA-3-runtime-failure-visibility.md)
