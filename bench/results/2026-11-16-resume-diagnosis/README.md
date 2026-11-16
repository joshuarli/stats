# Performance resume diagnosis

The owner requested resumption from `docs/HANDOFF-STATS-PERFORMANCE.md`.
This bounded investigation used existing logs and read-only inspection on Lisa.
It started no fixture import, sampler, stress workload or recovery cycle.
It restarted no application or Engine and changed no production configuration.
Existing campaign attempt budgets remain unchanged.

## Production and source drift

At 2026-11-16 04:11:55 UTC, OpenOrange's selected Stats deployment remained
`stats:6cc06db247a3`, version 24. The local checkout was clean at
`a6d60e3de5c`, after the original handoff commit `fdaacb00227`.
Master now includes runtime changes, including Linux power protocol support
and dashboard changes. The original campaign statement that later commits
change only tooling and documentation no longer describes master.
These changes were not deployed during this investigation.

## Fixture observations

`stats-perf-scale-server` remained running with a 3,221,225,472-byte memory
limit. Its start time remained 2026-11-15 17:57:23 UTC.
The container reported 1,514 cumulative memory-limit events, zero OOM events
and zero OOM kills. Its remaining processes were the container init, a Node
process and `rivet-engine`. No fixture Worker was running.

The preserved private Engine log still contains the previously recorded
quorum failure and three filesystem fences. The log also contains four later
heartbeat warnings between 03:53:32 and 04:10:36 UTC on November 16.
Each warning reports renewal waiting on the object store. Each is followed
by a renewal-confirmed message. These warnings support investigating storage
latency. They do not establish the cause of the earlier import failures.

The log-directory free-space error belongs to the earlier startup attempt
at 17:56:10 UTC. The subsequent 17:57:23 startup recovered its log shard
and completed a disk probe. The preserved stderr file combines startup attempts.
Treating that missing-directory error as proof of the later fencing cause
would conflate different process lifetimes.

Read-only private Engine queries returned HTTP 200 for namespace listing.
The namespaces were `default`, `stats-scale-20261115` and
`stats-scale-rebuild-20261115`. Actor-name listings were empty in all three
while fixture Workers were absent. This inspection cannot classify the
historical duplicate actor identity across namespaces.

## Inventory availability

One production inventory sweep used the same namespace and actor-name query
shape as `bench/native-soak.py`. The name listing and the first actor page
for each of its eight names returned HTTP 200. No page had another cursor.
Counts were zero for both facet names and both cache names, one installation,
14 observation stores and one actor for each of the two cron names.

The historical inventory 503 did not reproduce in this sweep. One successful
sweep establishes neither continuous availability nor a repaired collector.
The stopped soak remains invalid. No latency or resource plateau acceptance
claim follows from these diagnostic observations.

## Remaining boundary

STUF-87 still requires a controlled reproduction separating resource limits,
configuration and Engine behavior. A useful next experiment needs a fresh
private Engine process and depot, pinned binary and bundles, explicit resource
limits, and exact acknowledged-row recovery checks. Preserve all failed states.
Define its attempt budget before starting it: the original rebuild allowance
was exhausted and the handoff explicitly prohibits another automatic rebuild.
Engine repair and upgrades remain outside the Stats campaign.

STUF-88 still needs failure-time endpoint and Engine evidence. A replacement
soak would not itself fix the missing resource coverage or historical 503s.
P2 sleep evidence, P6 combined scale acceptance, P7 overhead, P8 native plateau
and P9 repeated native recovery remain blocked as recorded in the handoff.
