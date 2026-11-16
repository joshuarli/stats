# Performance campaign closeout

The owner resumed unattended execution after the handoff and clarified that
exhausted experiment budgets should not trigger another approval handoff.
The campaign completed W7 closeout with blocked goals. The tenfold objective
remains unestablished. Acceptance thresholds were unchanged.

## Production functional smoke

Production selected `stats:6cc06db247a3`, node version 24, before and after
the checks. No candidate was accepted for deployment during resumption.
Later master runtime changes were not deployed as part of this campaign.

[The functional browser receipt](functional-smoke.json) records nine passing
checks through the normal tailnet production URL in a dedicated agent-browser
session. Each check requires three completed charts, exact response bounds,
matching displayed request, failure and issue counts, settled successful
summary responses, and successful journey outcomes.

| Check | Result |
| --- | --- |
| Initial 1h navigation | One successful summary read and populated charts |
| Uncached 6h, 24h and 7d | One additional summary read per range and matching charts |
| Cached 1h, 6h, 24h and 7d | Zero additional summary reads and cache journeys |
| Refresh | One additional successful summary read and matching charts |

These are functional checks, not new percentile acceptance distributions.
The Mac gate rejected concurrent load from an unrelated container benchmark
and a virtual machine. **perf gate deferred: host busy**. That work was left
alone. No time-based performance gate or release qualification is claimed.
The original accepted cohorts retain their recorded deployment, corpus,
sample-count and browser qualifications.

The first diagnostic probe compared cached charts with the last network
response rather than the response for the displayed bounds. Correcting that
probe exposed a second harness error: it expected `@eN` in the snapshot text,
while the CLI emits `[ref=eN]`. [The failed probe receipt](invalid-probe.json)
is retained and excluded. The corrected probe ran again from a fresh browser
session and completed all nine checks. Neither defect required a product fix.

The final probe scripts are retained in protected Lisa benchmark storage as
`functional-init.js` and `functional-smoke.mjs`. Their SHA-256 values are:

- `functional-init.js`: `ac8cda087cda322e2e5899a3249fae11769594ce1547e9eac8146d6da8c51c98`
- `functional-smoke.mjs`: `d64baefd05c88cf95c8a4667312298f916838a5860bcdc78c6325d2cabc0bc8b`

## Shared health and external blockers

[The health receipt](health.json) retains the relevant shared-health checks
and every failure. Stats services, Engine connections, production ingress,
the shared Engine and store health endpoints, and platform readiness pass.
Overall shared health is false for two reasons:

- `stats-next.17166969.xyz` returns HTTP 502. The failed fixture has no Worker.
- agentctl reports zero connected Engine nodes. This is outside Stats scope.

The [fresh private Engine reproduction](../2026-11-16-fresh-engine-reproduction/README.md)
rules out prior failed depot state and observed cgroup memory-limit events as
necessary conditions for the reproduced fencing. It does not classify
configuration versus Engine implementation. Its one private reopen preserved
the acknowledged count, not verified row identity. No second import ran.

STUF-87 and STUF-88 were updated and pushed in Stuff commit `8c6fd0e`.
STUF-86 retains sleep observability. Stats STA-128 retains the blocked overhead
and collector-failure study. No missing measurement was marked passing.
No replacement soak, production restart or shared Engine restart occurred.

## Draft branch retirement

The six `park/*` drafts were retired under W7's existing closeout instruction.
Their commit summaries were inspected. They remain unreviewed drafts, not
newly accepted implementations. Their complete histories were preserved in a
verified Git bundle before deleting the remote refs with expected-SHA leases.

Protected Lisa archive:
`/home/josh/.work/stats-perf-campaign/closeout-parked-drafts.bundle`.
Its SHA-256 matches the local archive:
`088b2b8e864b85454e9e5d57425f36d18ff6a782341eb6842aa28305395ff835`.

| Retired branch | Preserved head |
| --- | --- |
| park/native-dashboard-bench | 09363cad7747baac85dc9a0fc5330232f6472f93 |
| park/perf-live-reads | cfdb21b15ee5c8d581d36492c4e897f807d06e0c |
| park/perf-native-recovery | 4d68242edee8d4b109a9c08b99c24909c5cc9be6 |
| park/perf-overview | 626328f1770804ed2dbfcfe4b01ac84778f25e71 |
| park/perf-producer-drain | 6ed6dd0e93b05fd900a312b5e333cbb0b69bf5c4 |
| park/preview-production | 126ae9dfbaab33dfcc8dacb6c60cfd11796571e9 |

`git ls-remote --heads origin 'park/*'` returns no refs after retirement.
No worktree was removed. The unrelated btree, ci-pnpm and three upgrade
worktrees remain intact. Failed fixture state and protected corpus files
remain available. Browser sessions created for closeout were closed.

Verification includes the actual functional smoke, shared health report,
ticket validation, bundle verification, matching local/remote archive hashes,
remote-ref absence and `git diff --check`. Full tests and release gates were
not run because no runtime implementation changed in this closeout.
