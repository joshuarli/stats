# Local profiling

`make profile-local` profiles a Worker you build with the `cf` toolchain in
Stats' local stack, without deploying it. It runs the Worker in the same
Miniflare as `stats` and `stats-observe`, drives a workload, and prints per
operation: invocations, CPU p50/p95/total, wall p50/p95, SQLite rows
read/written and statements, R2 Class A/B operations, and a projected monthly
cost. The point is to see what a Durable Object's SQLite schema costs, since
rows written (including indexes, triggers, and FTS) are billed and
`cursor.rowsWritten` reports them.

## What the Worker publishes

The Worker and each of its Durable Objects publish one message per invocation
on the `stats.observe` diagnostics channel. The message is the same
`ServiceOperationMessage` the other observed services use, plus an optional
`r2` account:

```ts
import diagnostics from "node:diagnostics_channel";

const channel = diagnostics.channel("stats.observe");

const cursor = this.ctx.storage.sql.exec("INSERT INTO t (v) VALUES (?)", value);
cursor.toArray();
channel.publish({
  kind: "operation",
  traceId,                       // 32 lowercase hex chars, not all zero
  spanId,                        // 16 lowercase hex chars, not all zero
  operation: "store.insert",     // ^[a-z][A-Za-z0-9_.-]{0,63}$
  synthetic: false,
  rows: { read: cursor.rowsRead, written: cursor.rowsWritten, statements: 1 },
  r2: { classA: 1, classB: 0 }   // optional: R2 writes/lists are Class A, reads are Class B
});
```

Read `rowsRead` and `rowsWritten` after the cursor is consumed or closed; they
are final then. A Worker invocation that just forwards to its object publishes
`rows: null` and its own operation name. A name that does not match the
service's policy is rejected like any other malformed message.

## Build and run

Build the Worker with the toolchain Stats uses. The output directory holds
`worker.config.json`, `bundle/`, and `assets/` if it has any:

```sh
pnpm build   # or whatever builds your Worker with cf
make -C ~/d/stats profile-local PRODUCER=/path/to/.cloudflare/output/v0/workers/default
```

Options:

| Option | Meaning |
| --- | --- |
| `PRODUCER` | The built output directory (required) |
| `SERVICE` | The observation label; defaults to the built Worker's name. It must be a new name, not one of `stats`, `usr-memories`, or a `nanoshop-*` service |
| `WORKLOAD` | An ES module whose default export receives the producer origin. Defaults to `<dir>/workload.mjs` or `<dir>/../workload.mjs` |
| `DAILY` | How many times the measured workload runs per day (default 1000) |
| `PROFILE_ARGS` | Extra flags, such as `--json` or `--wait 60` |

Without a workload module the command prints the producer's loopback origin and
collects manual traffic for `--wait` seconds:

```sh
make -C ~/d/stats profile-local PRODUCER=<dir> PROFILE_ARGS='--wait 120'
```

### Injecting text variables

A producer sometimes needs a text binding before its workload can start, for
example a bootstrap token hash so its first request can create an operator
credential. `--producer-var NAME=VALUE` (repeatable) adds or overrides plain
text bindings on the hosted producer only; `make profile-local` takes the same
values in `PRODUCER_VARS`:

```sh
make -C ~/d/stats profile-local PRODUCER=<dir> PRODUCER_VARS='BOOTSTRAP_TOKEN_SHA256=<hex>'
```

Names must match `^[A-Z][A-Z0-9_]{0,63}$`, each value needs `=`, and a duplicate
name is refused. Values are passed verbatim and never printed; the command logs
only their names. This is local-only: it changes neither the deployed Workers
nor how the stack authenticates its own routes.

The same script runs directly:

```sh
cd cloudflare
node --experimental-strip-types scripts/profile.mjs \
  --producer-worker <dir> --service my-service --workload ./workload.mjs --daily 1000 --json
```

## How local producers are admitted

The service name is admitted only inside the local stack. Its collector copy is
built with `OBSERVE_LOCAL_SERVICES` set to that name, and
`src/observe/cloudflare/worker.ts` admits names in that list with the
`PROFILE_POLICY` (keep every invocation, capture its operation account). The
deployed `stats-observe` has no such variable, so production still drops any
script name outside `OBSERVED_SERVICES`; nothing in production ingest, auth, or
routing changes. The stack refuses a producer whose name is an existing
observed service, and a Worker whose output directory has a binding type other
than text, SQLite Durable Object, assets, or R2. It also refuses cron triggers,
which it does not fire.

## Reading the result

`GET /api/observe/<service>/profile?from=<ms>&to=<ms>` returns the profile the
command prints. Each operation row is one `(operation, stage)` pair over stored
invocations in the window. Percentiles are exact nearest-rank values over the
retained invocations.

Costs reuse `cloudflare/src/cost/pricing.ts` at its list prices, scaled from the
measured window to `DAILY` workload runs a day over a 30-day month:

- Worker stage: requests and CPU ms.
- Durable Object stage: requests, duration from summed wall time at 128 MB, and
  SQLite rows read and written at that table's row prices.
- R2 Class A/B operations are counted but not priced, because that table has no
  R2 operation tariff.

The projection is a list-price run rate, not a bill: it does not subtract the
plan's included allowances.

## Limits

Local workerd reports whole milliseconds of CPU and wall time, and small
invocations often read 0. Counts and row accounts are exact. The profile is
kept with the rest of the service's observation data for 7 days, bounded to the
newest 20,000 rows.
