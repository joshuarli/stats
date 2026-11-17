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

## Source findings

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

## Continue the investigation

Preserve the current selected image, running image, runtime node version,
OpenRC state, and cancelled-stage log before changing production.
After owner authorization, reconcile only the Stats app to the selected
image and verify readiness and the activation record.

Reproduce cancellation and a blocked HTTP request with local command stubs.
Verify that signal handling joins child processes, bounds rollback, preserves
the original failure, and reports any remaining selected-versus-running
mismatch. Keep the production checks and their assertions intact.

Add visible substage progress and bounded smoke requests before another
deployment attempt. Measure the complete authorized workflow separately from
diagnostic tracing. Report predeployment verification, build and transfer,
restart, readiness, smoke, and recording costs independently. No deployment
speedup is established by this investigation.
