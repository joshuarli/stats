# Development loop verification

## Scope and starting evidence

The November 12 handoff is being implemented from `8d7af45`, with the
STA-116 packaged Node regression already fixed. The handoff remains an
untracked owner document. No production deployment is part of this work.

The original aggregate Node list declares 74 files. It contains 24 stale paths
and omits 36 ordinary current files. Node 26 silently ignores the stale paths
when other paths match. The original aggregate ran, then failed in
`test/local/bench.test.ts`: its two collection runs reported different
`observationRowsPerInvocation` values (3.2 and 3.75). This is baseline evidence,
not a passing gate. Full output is in `.work/tmp/original-test-runner.log`.

## Acceptance record

- Test ownership: directory discovery with explicit artifact and opt-in exceptions.
  Both aggregate runners use the same selection and process owner. Profile tests
  belong to the default route and therefore to both `make test` and `make check`.
- Baseline measurement: pending, on the repaired inventory and original pins.
- Dependency group and actual runtime attribution: pending.
- Build freshness, writer ownership and failed-generation handling: pending.
- Frontend HMR, Worker reload, persistent state and readiness: pending.
- Browser ownership and concurrent-run isolation: pending.
- Compatibility workflow, documentation and full gate: pending.
