# Command cancellation proof

Base: `034a833fa7c75ee1c2fae9d2a45d1db954ccaaa8`, macOS arm64, Node 26.13.1, pnpm 12.21.0. The original helper blob was `d0bcdb1ede89bb2cfe3da700659b2afcf8ae4407` and the original test blob was `2a6fdff4067e7df01c55448787e23f0567e37fc5`.

The leader exits on SIGTERM while the ready grandchild handles SIGTERM and stays alive. The original close handler clears the scheduled SIGKILL, so the grandchild remains active beyond the five-second grace period. The test waits for the handler's readiness before aborting and observes actual process state until termination or 5.5 seconds; a zombie is not active. Its cleanup kills a still-active owned descendant. On cancellation or deadline, the new close handler kills the remaining group before clearing escalation; while the leader remains alive, the existing grace timer still applies. The cancellation reason remains the primary error.

Final source SHA-256:

- `deploy/orange/command.mts`: `11e914a10b2d749a7b89b4447701ad91b4e949894bb94bcbb47eaa78cadba392`
- `cloudflare/test/scripts/orange-deploy.test.ts`: `37dec88cba82a81552deac01cc8f72c628597eb0faeea159dfb3710cdf340549`

Each test or lint command below acquired one atomic heavy slot, released it on exit, and used this environment:

```sh
export PATH="/Users/josh/repos/stats/.work/toolchain/node-v26.13.1-darwin-arm64/bin:$PATH" TMPDIR="$PWD/.work/tmp" CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 PYTHON_CPU_COUNT=2
```

- Before the fix, `cpu-guard --cores 2 -- node --test --test-name-pattern='command cancellation also terminates an owned grandchild' cloudflare/test/scripts/orange-deploy.test.ts` exited 1: `grandchild 77461 remains active: S` after 5.6s.
- With the fix, `for n in 1 2 3 4 5; do cpu-guard --cores 2 -- node --test --test-name-pattern='command cancellation also terminates an owned grandchild' cloudflare/test/scripts/orange-deploy.test.ts || exit $?; done` exited 0: five passes.
- For the negative control, under the mutation lock and a heavy slot, the fixed helper was copied to `.work/tmp/command-cancellation-fixed.mts`, its `if (escalation) kill("SIGKILL");` line was removed, and the same single-test command exited 1: `grandchild 79686 remains active: S` after 5.6s. A shell exit trap restored the fixed helper. This was an intentional fault, not an ordinary check during mutation.
- `cpu-guard --cores 2 -- node --test cloudflare/test/scripts/orange-deploy.test.ts` exited 0: 27 passed, including success, nonzero exit, cancellation identity, deadline, graceful leader cleanup and fake SSH/systemctl rollback cases.
- `cpu-guard --cores 2 -- make lint` exited 0. An earlier run exited 2 on `no-unsafe-finally` in test cleanup; the cleanup was corrected before the final run.
- `git diff --check` exited 0.

The witness uses local fake processes only. Linux state observation is implemented via `/proc`, but these runs were on macOS using `ps`; Linux and remote CI were not run. No deployment, real services, performance workload or production effects were exercised.
