# STA-3: Runtime failure visibility

Status: draft

## Summary

While it runs, neither the agent nor the Worker says anything when it drops,
rejects, or fails to store data. This RFC proposes one stderr line per failed
upload on the agent, a separate count for samples the agent dropped, and
structured error logs on the Worker. It also asks the owner to settle how a
rejected credential and Workers observability should be handled.

## Motivation

- `agent/src/runtime.rs:88-92` discards the message of every `Retryable` and
  `Permanent` error. A `Permanent` error drops the batch and returns no retry,
  so the upload loop moves straight on to the next batch.
- The only output is the summary that `agent/src/main.rs:134-137` prints on
  exit. After a rotation or revocation, the agent keeps sampling and keeps
  discarding batches until someone stops it.
- `report.rejected` adds agent-side permanent drops
  (`agent/src/runtime.rs:122-124`) to the rejections the server reported.
  Requeue overflow (`agent/src/queue.rs:36-39`) is counted as `dropped`.
  Drops during the final flush (`runtime.rs:143-157`) are not counted at all.
  None of these counts reach the server.
- `cloudflare/src/*.ts` has no `console.*` call, and `cloudflare.config.ts`
  enables no observability. An alarm failure (`installation.ts:277-283`) or a
  500 in `Installation.fetch` (`installation.ts:416-417`) leaves no trace an
  operator can find later.
- The one signal an operator gets is a host going stale 45 s after it stops
  uploading, and a host that uploads but has every batch rejected never goes
  stale.

## Design

Agent:

1. Log one stderr line per failed flush: the error class, the HTTP status when
   there is one, and the message. Never include the token or the body. When a
   failure repeats, log only the first one and then a count every 60 s.
2. Count `dropped_local` (overflow, requeue overflow, permanent drops, final
   flush leftovers) separately from `rejected_by_server`, and print both on
   exit.
3. When the server returns 401 or 403, take the action chosen in Open
   question 1.

Worker:

1. Call `console.error` with a fixed JSON shape (`event`, `hostId` when known,
   `code`) for ingest rejections other than `duplicate`, for alarm exceptions,
   and for the 500 catch-all. The client-facing message for a 500 becomes
   fixed text (see STA-7).
2. Add `observability` to `cloudflare.config.ts` if Open question 2 says yes.

## Alternatives considered

- **Send loss counters to the server as a new metric group.** This puts loss
  on the dashboard, but it needs a protocol v1 change (unknown fields are
  rejected) or a v2. It can follow once local logs exist.
- **A disk spool, so that drops never happen.** This adds durable state on
  every host, and the problem is not loss itself but loss nobody can see.

## Open questions

1. What should the agent do when the server answers 401 or 403?
   (a) Keep the batch and back off at the 60 s cap until the token file
   changes, then reload it. (b) Exit non-zero so the supervisor or init
   reports the failure. (c) Keep today's drop and only log it.
   Recommendation: (a). A rotation then loses nothing, and the token-file
   reload turns rotation into a file replace with no restart.
2. Should the Worker enable Workers Logs (`observability.enabled`)? The cost
   depends on the plan, and the account is on the free plan. Recommendation:
   yes, with sampling sized to the plan's log allowance, once the spend
   alarms listed in `docs/operations.md` exist.

## Decision

None yet.
