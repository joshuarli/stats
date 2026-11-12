# Develop stats locally

## Bootstrap the checkout

Use the Node version in `.node-version` and pnpm 12.18.0. Run these commands
from the repository root:

```sh
make work-ready node-ready
pnpm install --frozen-lockfile
pnpm --dir cloudflare exec playwright install chromium
make fixtures
make dev-doctor
```

Dependency and browser downloads happen during bootstrap. Fixtures are committed.
`make fixtures` validates them. Regenerate them only for a deliberate protocol change.

## Start development

```sh
make dev
```

Open the printed URL. The server binds a free loopback port. To request a fixed
port, run `make dev DEV_ARGS='--port 8789'`. A conflict fails instead of reusing
another server. `make dev-local` is an alias.

Frontend edits hot-update through Vite. Worker and observe edits automatically
build and replace the backend. A compilation error leaves the previous backend
serving. Fix the error to recover automatically. A backend activation failure
reports a separate error and retains the state directory.

The frontend proxy supplies a short-lived test Access identity to the backend.
The backend still validates the JWT and rejects anonymous data requests.
The local UI uses disposable test identity. No production credentials are needed.

Read the `dev-ready` JSON line or its `statusFile` for the run ID, URLs, ports,
state directory, artifact identities and resolved runtime versions. Tokens are
never printed. Read `dev-build-error` and `dev-activation-error` separately.

SIGINT and SIGTERM stop the frontend, watchers, backend and owned build children.
The backend receives a shutdown message and finishes disposal before replacement.
No two backend runtimes write the same development state concurrently.

## Keep or reset state

Development state lives in `.work/local/state`. Restarting or editing code keeps
history and fixture identity. Only an empty installation is seeded at startup.

Use separate state directories for simultaneous instances:

```sh
make dev DEV_ARGS='--state ../.work/local/experiment --port 0'
```

Paths in `DEV_ARGS` are relative to `cloudflare/`. State must remain inside this
checkout's `.work/` directory. State symlinks are refused. A second owner of the
same state fails with an ownership timeout.

Stop the default instance, then reset only its state:

```sh
make reset-local
```

To reset a named state, run
`make dev DEV_ARGS='--state ../.work/local/experiment --reset'`.
Reset uses the same ownership lock and refuses a live owner.

To host producer fixtures, pass `--producer DIR` or
`--producer-worker DIR --service NAME`. Repeat `--producer-var NAME=VALUE` to
inject text bindings. Values are not printed. See [profiling](profiling.md) for
producer export and workload prerequisites.

## Select tests

Use the shared runner from the repository root:

```sh
node cloudflare/scripts/run-tests.mjs --list --json
node cloudflare/scripts/run-tests.mjs --file test/ingest/conformance.test.ts
node cloudflare/scripts/run-tests.mjs --file test/node/parity.test.ts
node cloudflare/scripts/run-tests.mjs --file test/ingest --name 'Rust-encoded'
node cloudflare/scripts/run-tests.mjs --suite browser --file test/ui/local-stack.spec.ts
```

Files are relative to `cloudflare/`. `--file` accepts a file, directory, or quoted
glob. Repeat it to select several paths. `--name` passes the underlying runner's
name filter. Unmatched file selectors fail. Node name filters with no matching
test also fail. `--jobs 1..8` bounds runner concurrency and defaults to two.

Pure ingest tests need no Worker output or workerd process. Artifact tests obtain
fresh outputs automatically. Browser specs own only the servers they use and
never reuse a server from another invocation. Browser state and results have
unique directories under `.work/tmp/`. WebP goldens remain beside their specs.

The default inventory includes profile tests. Both `make test` and `make check`
run them. Agent, Node end-to-end, browser and external routes are listed
explicitly. The full Make gates include the first three through their targets.

To run external service checks, prepare Tansu and Niceforge, then set
`TANSU_DIR` and `NICEFORGE_DIR` and select `--suite services-external`.
The Nanoshop checkout route requires `NANOSHOP_DIR` and
`--suite producer-external`. Neither external route counts as default coverage.

## Prepare or measure builds

```sh
node cloudflare/scripts/build-all.mjs
node cloudflare/scripts/build-all.mjs --clean
make bench-dev BENCH_ARGS='--runs 5 --out .work/tmp/dev-loop.json'
```

Build preparation hashes source dependencies, dirty and imported untracked files,
public assets, served docs, configuration, lockfiles, installed resolution,
Node, platform, mode, build helpers and allowed build environment values.
`STATS_DOMAIN` affects the stats build. Other ambient environment values are not
forwarded as build configuration. Valid unchanged outputs report a cache hit.

Builders use separate snapshots and one SQLite ownership lock per output.
Only successful complete generations become current. Tests receive fixed
generation paths. SQLite releases ownership when a builder dies. Generated types
and output contents are checked before reuse. Old generations remain in scratch
because a running consumer may still use them.

The benchmark requires committed tracked changes and an installed offline package
cache. It creates an isolated local clone, restores its temporary edits and
removes the clone afterward. Cold trials remove generated outputs and start new
state. Warm trials reuse both. The report includes real browser/request checks,
test counts, compilation counts, runtime attribution and process-tree RSS.
Busy-host performance checks fail instead of producing a passing measurement.

## Validate an upstream candidate

Run `node cloudflare/scripts/compatibility-candidate.ts` after committing the
implementation. This command needs network access for published package and
GitHub metadata. It does not run as part of `make dev`.

The command selects the Vite **v2 beta** channel and the supported companion
packages in an isolated local clone. It checks the resolved graph, dates,
configuration, generated types and the shared `test:compat` smoke route.
It retains the version/lock/policy diff, inventory, report and logs under
`.work/tmp/`. It never promotes the candidate into the working checkout.

The `cloudflare compatibility candidate` workflow runs this command daily and
on manual dispatch. It uploads the proposal and results for review. It creates
no notification task and does not deploy. See the implementation constraints
and measured evidence in [development-loop verification](dev-loop-results.md).
