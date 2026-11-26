Prefix: STA
Next: 146

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.

### STA-145 · P4 · Read or stop storing native runtime series

- **Area:** Metrics · Storage
- **Where:** cloudflare/src/metrics/store-core.ts:54 (`nativeSeries`), cloudflare/src/metrics/catalog.ts (`nativeCatalog`)
- **Problem:** Only tests read the native runtime families that commit aa0828f7 started storing, so about 8,640 samples a day are written with no consumer.
- **Recommendation:** Add the read route and dashboard view that motivated them, or stop writing them and drop the families.
- **Fix with:** dead-code-archaeology
- **Effort:** S

### STA-143 · P3 · Run Stats agents in the Stuff and Stats guests

- **Area:** Operations · Hosts
- **Where:** `stuff-primary` and `stats-recovery-vm` guests on threadripper; deploy/hosts.json; `make add-host`
- **Problem:** Neither guest runs a Stats agent, so the CPU, memory, disk and I/O of Stuff and Stats themselves never reach Stats; the `stuff` service row still names the old Lisa host and no unit, and `stats` names the host-side VM unit only. Stuff's three instances run as separate OpenRC services, while a service row names one unit.
- **Recommendation:** Enroll both guests as hosts, point `stuff` and `stats` at them, and decide how a service spanning several units (reader-a, reader-b, publisher) is attributed: a shared parent cgroup or a list of units per service.
- **Fix with:** none
- **Effort:** M

### STA-144 · P4 · Re-enroll or retire tim

- **Area:** Operations · Hosts
- **Where:** docs/operations.md (`check hosts --hosts lisa,threadripper,sentry,tim,m1-max`); `/var/lib/stats-node/main/RESET.json`
- **Problem:** The 2026-11-26 registration rebuild did not include `tim` (offline then and at 10:00 UTC), so the documented roster check exits 7 with `tim: missing`.
- **Recommendation:** When tim is online, register it from its own `hostId` and token verifier as was done for m1-max; if it is retired, drop it from the roster recipe.
- **Fix with:** none
- **Effort:** S

### STA-142 · P3 · Design per-service disk usage

- **Area:** Agent · Protocol · Design
- **Where:** [RFC](docs/rfc/STA-142-service-disk-usage.md); agent/src/config.rs (`services`); docs/protocol.md
- **Problem:** Stats reports disk usage per mounted filesystem only, so space a service uses on a shared filesystem cannot be attributed to it; Stuff's 20 GB had to be measured by hand. A periodic walk was rejected because its cost grows with file count.
- **Recommendation:** Decide among project quotas, per-service volumes, filesystem accounting, change-event accounting and service-reported usage as laid out in the RFC, then implement the chosen mechanism with its protocol change.
- **Fix with:** architect
- **Effort:** L

### STA-141 · P3 · Repoint the parked Lisa producers at the native Stats origin

- **Area:** Operations · Producers
- **Where:** Lisa `/etc/openorange/platform.env` (`STATS_ORIGIN`, `STATS_INGEST_TOKEN`), `/etc/openorange/apps/agentctl.env` (`APPLICATION_EVENTS_ENDPOINT`); docs/operations.md#production-in-the-threadripper-guest
- **Problem:** Both still send to the retired Lisa Stats container at `172.29.80.20:8080`, so OpenOrange platform and agentctl telemetry is dropped. A reissued `oo-platform` ingest token is in `~/.config/stats/services/oo-platform.json`; agentctl's existing token is still valid.
- **Recommendation:** When the parked apps are next changed, set the origin and endpoint to `https://stats.17166969.xyz` and install the `oo-platform` ingest token through a root-only env file, never argv, then restart. Confirm `statsctl observe application` shows their events.
- **Fix with:** none
- **Effort:** S

### STA-135 · P1 · Keep the standby Engine out of its alarm retry loop under host CPU contention

- **Area:** Operations · Engine
- **Where:** docs/openorange.md#standby-incident-2026-11-21; the guest's `live-stats-engine` container; deploy/orange/recovery/stats-recovery-vm.openrc
- **Problem:** On 2026-11-21 Threadripper reached load 68 on 32 cores from unrelated builds plus an 8.5 GB copy onto its 95%-full disk. At 02:10:00 the Engine's storage host refused volume alarms as overloaded; the alarm frontier filled (16 of 16), alarm callbacks and envoy registration missed their deadlines, and three Engine workers spun at full CPU. Ingest returned 503 from 02:10:51 to 03:33. Engine restarts, an Engine CPU cap, and raising qemu's priority did not clear it while the host stayed saturated; once host load fell to 12 the Engine went idle and `native-stats` registered on the first start. The envoy-lost pattern also occurred on 2026-11-20 at 02:41, 09:28 and 10:35. Lisa's primary Engine (serving the Stuff registries) hit the same loop on 2026-11-21 at 05:10 UTC, when three concurrent cold Rust builds in containers raised load to 16 on 8 cores: `command_capacity` refusals, `request_deadline_exceeded` on envoy registration and alarm callbacks, `rivet-engine` at 750–800% CPU, and HTTP 500 from pypi.17166969.xyz. Unlike the standby incident, it did not recover once host load fell: after the builds stopped, it stayed at about 800% CPU with load near 8 and the registry still returned 500 for 10 minutes. `rc-service oo-engine restart` at 05:23 cleared it. The Engine settled near 30% CPU and the registry returned 200. That restart also restarted oo-app.stuff, oo-app.discover and oo-app.agentctl. Status (2026-11-22): One mechanism is reproduced and repaired. Unset, the Engine sizes its log shard from free disk at each start; within about 2% of the shard's resident size every write misses its deadline and the app never registers. Reproduced twice on the restored capture, survived three of three cycles with `storage.log_shard.max_disk_bytes` 1 GiB and `storage.cold_store.disk_cache_bytes` 512 MiB declared (Stuff `b9cd9232`), and applied to production at 16:00 UTC ([record](bench/results/2026-11-22-engine-degradation/README.md)). Still open: the 400% CPU spin of the 2026-11-21 22:40 loop and the 01:45 relapse, which no drill reproduced; the sustained soak watches for it. On 2026-11-25 at host load 74–99 the loop returned: data API 503 with `depot.request_deadline_exceeded`, Engine at 394% CPU with alarm and envoy-registration deadline failures, then a writer VM exit at 04:06:52 that the host watchdog restarted. After boot the app still missed registration. The declared log-shard and cold-cache sizes were already applied and inspection showed no drift; the VM's qemu threads were reniced to -10 live and that is now persisted in the VM unit's `start_post()`. Leased trials of an 8-CPU Engine cap, `storage.command_timeout_ms=30000`, `storage.max_background_cold_reads=16` and `storage.alarms.max_operations=64` each failed to clear the loop and were reverted. A perf profile of the live spin showed SlateDB row-iterator initialization, `sqlite_prefetch::OverflowMap::covering`, BTreeMap churn, FDB tuple decoding and `Topology::permits_worker` dominating userspace (docs/openorange.md#load-contention-2026-11-25); the Engine container recreation and guest reboot also failed to clear it. Service recovered at 08:34 UTC after unlimited supervised app retries, with synthetic ingest readback and all five hosts fresh; the original depot was retained. Close this when the soak passes without the spin, or narrow the read/decode loop to a reproducible upstream case.
- **Recommendation:** The VM's cgroup now reserves CPU weight, memory without swap and disk latency (docs/openorange.md#standby-incident-2026-11-21). A 10-minute drill at host load 76–81 passed with baseline latency, and the guest now has 8 vCPUs with the Engine capped at 4. Stuff's `docs/openorange-engine-degradation.md` (2967626c) traces each refusal to source at Rivet `e5ed3911` and ranks the remaining levers: raise `storage.max_background_cold_reads` (4), then `storage.alarms.max_operations` (16), then set `storage.command_timeout_ms` (unset; commands time out at 5 s); code changes to the inventory read edge's retries and RivetKit's fixed 30 s registration limit come last. The full frontier queues rather than refuses, and the 100% CPU spin is not explained by source. On 2026-11-21 a copy of the standby guest ran in its own cgroup on Threadripper's CPUs 12-15,28-31 with weight 100 and no outbound network (`deploy/orange/recovery/contention-drill.sh`, load from `deploy/orange/recovery/contention-load.mts`). The copied depot was crash-inconsistent (`ManifestMissing`), so the Engine started on a fresh depot with namespace `stats-prod` and pool `default`. Run 1: 6 hosts, 14 services at 20 events per 2 s, 32 busy loops for 13 minutes at host load 55-67. All 7,984 requests succeeded (p99 at most 3.3 s) and the Engine logged no warnings. Run 2: 30 hosts, 40 services at 100 events per second, 64 busy loops for 10 minutes at host load up to 158. The guest starved (event timeouts, 221 frame connection errors, p99 30 s) and stayed degraded after the loops stopped while unrelated builds held load near 100. The Engine never refused alarms, filled its frontier or missed a registration deadline, and it never restarted. Production health stayed at 200 in about 60 ms throughout. CPU contention alone therefore does not reproduce the loop. Remaining: repeat with a consistent copy of the standby depot (an Engine-only fence under the guest lease) and with disk-write contention on the image's filesystem. Profile with perf once the loop appears, then try the config levers one at a time against that reproduction and apply the winners to `live-stats-engine` through a tracked definition with its limits. On 2026-11-21 22:40 UTC the live standby entered this loop at host load 4.4 with the data API at 503; stopping native-stats dropped Engine CPU from about 400% to about 1% in 70 seconds and restarting restored 200 with no warnings. The spin is sustained by application registration pressure, not host load alone. Root cause and the config levers remain open; see [the live record](bench/results/2026-11-21-standby-loop/README.md). On 2026-11-22 at 01:35 UTC a warm rsync of the live 3.7 GiB depot on the guest's own disk, with the Engine and app running and host load low, was followed within 58 s by a typed SQLite storage read failure and within 72 s by registration loss; the Engine then exited with code 1 when native-stats stopped and ignored docker stop for 20 s. That is the first disk-I/O trigger seen for this failure; repeat it as the disk-contention case with the read rate measured ([capture record](bench/results/2026-11-22-engine-capture/README.md)). At 01:45 UTC on 2026-11-22, eight minutes after the failed capture restarted the Engine and app, the loop returned for 37 minutes (400% CPU, envoy connects refused as storage could not register, data API 503) and nothing alerted; stopping native-stats again cleared it in about 45 s. The recovery was followed by bursts of volume alarm callback failures, unstructured depot command failures, flush-slot waits and one log-shard warning at 200 MB of the 257 MB storage.log_shard.max_disk_bytes budget. A consistent, validated capture now exists for the reproduction: sim-20261122T0236Z, off-host in ~/backups/openorange/stats/standby-sim-20261122T0236Z on the workstation (actor inventory equal to production's). On 2026-11-22 heavy writes to Threadripper's disk from a separate test VM and docker save (04:45-04:49 UTC) produced late topology heartbeats and alarm callback failures in the production Engine and raised data API latency from about 60 ms to 1.4-1.9 s until they stopped; the VM's io.latency reservation did not prevent it ([guest recreation record](bench/results/2026-11-22-guest-recreation/README.md)).
- **Disposition (2026-11-26):** retired by replacement, not repaired. Production Stats no longer runs the Engine or RivetKit (native Node since 04:57 UTC), so this loop can no longer take Stats down. The spin's cause is still unknown; the evidence above stays as the record. Lisa's Engine still serves the parked apps.
- **Fix with:** root-cause
- **Effort:** M

### STA-138 · P1 · Keep the standby app restarting until it registers after an Engine restart

- **Area:** Operations · Engine
- **Where:** the guest's `/etc/init.d/native-stats`; bench/standby-soak-faults.py; bench/results/2026-11-22-standby-soak/README.md#outage
- **Problem:** On 2026-11-22 at 23:36 UTC the soak's Engine restart left production returning 502 for about 18 h 22 min. The app repeatedly missed RivetKit's 30 s registration limit while the Engine refused envoy connects, and its supervisor stopped retrying at 23:39. `rc-service native-stats start` had already returned success, so the fault runner recorded no error. A single leased start at 17:58 UTC on 2026-11-23 recovered service with no acknowledged write lost. Status (2026-11-23): Root cause: the guest's `/etc/rc.conf` allows 5 respawns per 30 minutes, which matches the six failed starts. The tracked unit now retries without limit, backing off from 5 s to a 60 s cap. `deploy/orange/recovery/guest/test-native-stats-respawn.sh` fails on the old unit after six starts and passes on the new one under OpenRC 0.63.2 with a stub child. The unit was activated on the standby at 19:24 UTC under the rollout lease: the live supervisor runs `--respawn-max 0`, health returned within 8 s, and 10 of 10 synthetic checks passed. The leased command exited 1 although each service step reported `ok`; the cause is unknown, and the lease was released.
- **Recommendation:** Exercise an Engine restart with the real app on a disposable guest from the restored capture. Make Engine restarts wait for every expected host to report rather than the service manager's exit status. Then run a new soak under a new definition, including a working app RSS probe. Deliver outage alerts through STA-130.
- **Fix with:** root-cause
- **Effort:** M

### STA-128 · P2 · Measure observation overhead after the tenfold fixture is usable

- **Area:** Performance
- **Where:** docs/roadmap.md#campaign-performance W4; bench/results/2026-11-15-scale-prep-review/README.md; Stuff STUF-87
- **Problem:** STUF-87 is repaired in merged Stuff PR39. The single fresh preparation verifies all 203,950 events. The first full overhead study aborts in its disabled round after two incomplete browser journeys; a bounded full-length diagnostic does not reproduce them. Distinct per-variant documents fix independently demonstrated delivery-counter contamination. Profiled diagnostics preserve exact outcomes and zero delivery failures, but establish no overhead bound. Native canonical insertion batching passes five component pairs with full readback and reduces median whole-container CPU 38.8 percent; this is not P7 acceptance. Nine Engine-only recovery cycles pass before the tenth TERM exits 1; STUF-90 tracks the unproven lease-fence trigger. Preserve the failed depot and original attempt budgets. Current evidence and next conditions are in docs/roadmap.md#campaign-performance.
- **Recommendation:** The fresh tenfold fixture is prepared and its single preparation allowance is consumed; reuse it. Preserve failed state and the original campaign thresholds. Run five interleaved enabled/disabled rounds with representative ingestion and ten real dashboard clients, separating Stats CPU from Engine CPU. Require less than 3 percent CPU and 5 percent latency overhead, preserve failed outcomes, verify collector failure leaves application results unchanged, and report inconclusive when same-variant spread exceeds either threshold.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-130 · P3 · Deliver observer alerts

- **Area:** Operations
- **Where:** deploy/observer/observer.mjs; docs/openorange.md#independent-observer
- **Problem:** The observer on Threadripper's host records alert transitions with `delivery: unconfigured`, so a sustained health, host or ingest failure reaches nobody. The VM crash watchdog (`673975b`) restarts the standby guest. The owner accepted that a Threadripper outage stops both the writer and the observer, and deferred alert delivery on 2026-11-21.
- **Recommendation:** When the owner names a destination, deliver each outbox transition durably with retry, keeping the token out of argv. A hosted dead-man check would also cover a Threadripper outage.
- **Fix with:** error-model
- **Effort:** S

### STA-137 · P3 · Typecheck the canary and qualification harness

- **Area:** qualification harness
- **Where:** deploy/orange/canary/*.mts, deploy/orange/qualification/promotion.mts, deploy/orange/tsconfig.json
- **Problem:** deploy/orange/tsconfig.json includes neither the canary modules nor promotion.mts, so type errors there go unnoticed. A probe including qualification/promotion.mts and canary/*.mts reports 8 errors in those files (evidence.mts: engineName on the narrowed session, a spawn overload, an unknown digest; fault-proxy.mts and workload.mts: Uint8Array<ArrayBufferLike> where ArrayBuffer is required; promotion.mts: a spawn overload and a never-typed collector child) and 4 in cloudflare/src/history-frame.ts, whose extensionless relative imports fail under the deploy tsconfig's NodeNext resolution. The misnamed gateway-secret header in recover() was fixed on 2026-11-22; it was the one live defect found.
- **Recommendation:** Choose how deploy/orange typechecks imported cloudflare sources (their own bundler-resolution project reference, or explicit extensions), then add the canary and qualification modules to the deploy/orange typecheck and repair the 8 harness errors without changing harness behaviour.
- **Fix with:** typing-audit
- **Effort:** M

