# STA-103: Isolate Node observations by service

Status: implemented with conservative legacy quarantine

## Summary

Give each Node service its own maintained observation store, matching the
ownership boundary of Cloudflare's `ObservationStore` Durable Objects. Prefer
separate SQLite files behind a service-bound store registry; decide the disk
layout and migration before implementation. This proposal does not change host
ingest, the application-event wire format, or authentication.

## Motivation

At `9095d85`, `openNodeInstallation` creates one `ObserveService` over the
installation database. `observeHandler` removes the service prefix from the
URL and passes that shared object to `handleApi`. External-event queries take
a service argument, but issue reads, state changes, artifacts and other store
operations assume their database already belongs to one service.

A local HTTP reproduction registers alpha and beta, posts one coded failure
only to alpha, then reads both issue lists through the Node auth adapter.
Both return alpha's issue, although beta's external-event list is empty.
Resolving that fingerprint through beta returns 204 and changes alpha's issue
to resolved. The failure is incorrect service ownership within one installation;
it does not require an authentication bypass or separate tenants.

## Design

1. **Bind ownership before invoking the shared API.** Resolve a service
   admitted by the existing route policy to a store object. Use the same resolution for ingest,
   issue reads and mutations, artifacts, operation summaries and deployment
   comparison reads. A caller cannot supply a different service after binding.
   Names outside that policy must not create stores or files.
2. **Preserve the existing per-store core.** Keep one `InstallationCore` for
   hosts and service registration. Put observation databases under a dedicated
   directory beneath `STATS_DATA_DIR`, using a path derived only from validated
   service names. Open each store at most once per installation; retain the
   existing exclusive-writer guarantee for every file. Keep symbolicator
   caches, deduplication, issue limits and artifact limits within that owner.
3. **Own the full lifecycle.** The registry holds the maintained service, its
   connection and cleanup schedule. Arm cleanup on startup and ingest, follow
   its next expiry and backlog, and stop callbacks before closing connections.
   Coordinate with STA-108; merely exporting `ObserveService` must not discard
   the maintenance capability. Decide a bound or eviction policy for open stores
   before allowing service registration to grow without limit.
4. **Migrate explicitly.** Back up the installation database before moving
   observations. External events carry a service identity; partition those
   rows and rebuild derived state only where ownership can be established.
   Restore each proven owner's saved issue state, `state_at` and `resolved_at`
   after rebuilding occurrences; replay alone would reopen resolved issues. Audit every legacy table and artifact before choosing its treatment. Keep
   ambiguous legacy state unavailable and recoverable for inspection; never
   copy an unowned issue into every service. Record migration completion so a
   restart cannot duplicate rows or repeatedly rebuild issue state.
5. **Document the operational change.** Backup and restore must include the
   installation file and all service stores. Describe a consistent stopped
   backup or an equivalent coordinated snapshot. Update the current single-file
   Node description only when the implementation lands.

Acceptance should use the real Node HTTP server and SQLite. Two services must
remain independent with identical error codes, event IDs, release identifiers
and artifact names. Verify list/detail reads, resolution, deduplication,
capacity and expiry, then close and reopen. Exercise an interrupted migration
and a resolved-issue migration, proving that issue state survives and ambiguous
old state is neither lost nor assigned by guesswork.
Keep the Cloudflare per-object behavior and auth rejection paths unchanged.

## Alternatives considered

- **One SQLite file with a service key on every observation table.** This
  preserves the current backup shape and uses one connection, but requires
  service-aware primary keys, joins, mutations, limits and caches throughout
  the shared core, including its Cloudflare adapter. It is viable if the
  single-file operational constraint outweighs that broader change.
- **Filter issue lists at the HTTP layer.** Insufficient: detail lookup,
  resolution, fingerprints, artifacts, caches and capacity would still share
  ownership. It also leaves ingestion merging state before a read can filter it.

## Open questions

- Is a database per service acceptable, or must Node remain a single-file
  installation? Confirm this before selecting the migration and backup format.
- How much legacy issue state must survive when ownership cannot be recovered
  from retained events? Choose an explicit quarantine/rebuild policy.
- What service-count and open-connection bounds fit the intended Node fleet?

## Decision

Use one SQLite file per service under `stats.sqlite.observe`, with a hard limit
of 256 open stores. The installation lock protects the registry. Each file also
holds an exclusive writer lock. The registry owns startup cleanup, expiry timers
and shutdown. API routing binds the store before executing observation operations.

Migration copies external events and rate windows by service. Application issue
fingerprints include service identity, so retained coded events establish which
issues and occurrences can move. The copy preserves issue state and timestamps.
A destination transaction records completion together with imported rows.
The source tables remain intact in `stats.sqlite`, including artifacts, rollouts,
counts, health and other legacy rows without proven ownership. These rows are
unavailable through service APIs and remain recoverable for inspection.

Back up and restore the entire data directory while the server is stopped.
