# Cancelled deployment investigation

The owner cancelled `make deploy` on November 17, 2026, after the
`worker deploy` stage stopped showing progress. The exact blocked operation
remains unproven. This investigation is separate from private performance
qualification and does not authorize another production deployment.

## Retained observations

The owner's terminal reports fixtures at 0 seconds, Worker tests at 206
seconds, agent tests at 6 seconds, and agent builds at 154 seconds.
Those are individual observations, not controlled benchmark results.
`Makefile` runs these four gates sequentially before deployment.

The retained `.work/tmp/steps/worker-deploy.log` shows both Worker bundle
cache hits. Docker completes image creation for `stats:c9a71b2ba127`.
The dependency installation layer is cached. The log then records selection
of that image with runtime node version 25 and a completed Stats restart.
No deployed-smoke success line follows.

Cancellation runs the rollback trap. The trap selects
`stats:6cc06db247a3`, runtime node version 26, then reports:

```text
 * Stopping oo-app.stats ...Orange rollback failed; inspect oo-app.stats on the host
make[1]: *** [worker-deploy] Error 1
```

At 16:06 UTC, read-only inspection finds the old image selected at version
26, while container `oo-app-stats` still runs `stats:c9a71b2ba127` with
runtime node version 25. OpenRC reports `starting`. Public `/health`,
`/api/v1/hosts`, and `/api/v1/services` return HTTP 200 during follow-up
probes bounded by a ten-second request deadline. These checks do not
establish a completed deployment or completed rollback.

No local deploy, smoke, or matching deploy SSH child remains in the process
inspection. This observation does not establish how cancellation interrupted
the remote service transition. Production reconciliation awaits owner approval.

## Source findings at the cancelled revision

`scripts/step.sh` redirects the whole stage into one log. It displays no
substage progress while `deploy/orange/deploy.sh` builds the image, restarts
Stats, waits for health, checks the deployed service, and records activation.
Its success filter still names retired Cloudflare output.

The log places the stall after the successful restart. The subsequent
operations are the public health loop and `deploy/deployed-smoke.sh`.
The health loop bounds individual requests. Most smoke requests have neither
`--connect-timeout` nor `--max-time`. The dashboard loop's 90-second deadline
is checked only after `dashboard_ok` returns. A hung curl can therefore
outlive that deadline. This is a demonstrated missing bound in the source,
not proof of which request stalled in the cancelled deployment.

The rollback trap selects the previous image before restarting the app.
If cancellation interrupts that restart, selected and running images can
diverge. The observed mismatch requires reconciliation before a new deploy.

## Implemented command changes

The owner clarifies that the follow-up improves the deployment command,
without upgrading the shared Engine or authorizing production recovery.

`make deploy` now checks selected and running release identity before its
existing verification gates. `make stats-deploy-check` exposes that read-only
operation. The app deployment checks again before building a committed tree.
Both image and runtime node version must match. This rejects the observed
inconsistent state before spending time on builds or changing selection.

`deploy/orange/deploy.mts` owns image preparation, selection, restart, health,
smoke, verification and recording. Each stage has a deadline and visible
elapsed time. Silent subprocesses produce wait updates. The complete log
remains at `.work/tmp/steps/worker-deploy.log`. Help derives deadlines from
the same values that execution enforces.

Cancellation stops safe local work and joins its process group. An in-flight
image selection or OpenRC restart instead settles within its existing
deadline before rollback starts. Rollback ignores the cancelled signal,
has a total deadline, and verifies both the restored image and runtime node
version. Verification failure preserves the primary and cleanup errors.
An observed competing selection prevents automatic rollback. A failed selection
acknowledgement also requires inspection instead of assuming ownership.
The host retains image-conditional writes. No whole-deployment lock or
version-conditional host API is introduced.
The command preserves signal death for HUP, INT, TERM and QUIT.

`deploy/deployed-smoke.sh` bounds every HTTP request. Asset requests also
respect the remaining dashboard deadline. The full smoke still runs during
app deployment. The second identical smoke invocation in `make deploy` is
removed. The fixtures, Worker tests, agent tests and agent builds remain.

The original completed-deploy stdout line remains unchanged. Progress and
diagnostics use stderr. A marker-delivery failure retains the verified healthy
release, matching the previous deployment contract.

## Verification and remaining live qualification

The local suite covers successful activation, an admitted selection with a
lost response, failed health, failed smoke, cancellation, rollback failure,
rollback deadline exhaustion, concurrent selection, and failed marker delivery.
Real child-process cases cancel during smoke and restart under all four
signals. A separate case verifies that cancellation also stops a grandchild.
Logging rejects a symlink without overwriting its target.

The smoke suite uses the system curl against a loopback HTTP server that
accepts a connection and never answers. The request fails at its existing
ten-second limit, and the smoke exits with failure. Controlled smoke fixtures
also require bounded arguments for every curl request and retain all existing
API and asset assertions.

Reproduce with the pinned Node version:

```sh
node --test cloudflare/test/scripts/orange-deploy.test.ts cloudflare/test/scripts/dashboard-smoke.test.ts cloudflare/test/scripts/signals.test.ts
pnpm --dir cloudflare exec tsrs -p tsconfig.json --noEmit --fast
pnpm --dir cloudflare exec tsrs -p "$PWD/deploy/orange/tsconfig.json" --noEmit --fast
make lint
```

The deployment command also runs in a network-isolated Linux production-image
container against the same local fixtures. Verification covers macOS arm64
and Linux amd64. No production activation or end-to-end deployment timing is
performed by this investigation.

The final deployment suite passes 25 cases on each platform. The smoke and
existing signal suites pass another 13 cases on macOS. Application and native
CLI typechecks pass. `make lint` includes the native CLI's own Node type context
and passes. The full repository release gate remains unrun.

The new read-only `make stats-deploy-check` is exercised against Lisa. It
rejects the selected old image at node version 26 and running new image at
node version 25 without building or changing production. STA-129 stayed open
for owner-authorized reconciliation and one live qualification of the command.

STA-129 closed on 2026-11-21 as superseded. The November 18 ordered restart
aligned Lisa's selection to the running `stats:c9a71b2ba127`. Stats then
moved to the Threadripper standby writer and left Lisa's Docker runlevel
(see [Lisa recovery](lisa-operational-recovery.md#live-stats-failover)).
The standby deploys through `make standby-deploy`, and failback
targets native Stats on Lisa ([native Lisa](native-lisa.md)). The Docker
deployment command has no remaining production target to qualify.
The exact request that stalled originally remains unproven. No deployment
speedup is established by this investigation.
