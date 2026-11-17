# Verify the macOS development test in the offline sandbox

The development test copies `/bin/ps` into its disposable workspace, removes the setuid mode and signs the copy locally. The copy supplies process IDs, parent IDs and commands. On the tested macOS host the copy reports zero RSS, so a temporary `clang`-built `libproc` sampler reads resident sizes for the process tree. The test checks the sampler against its own process and requires a nonzero tree total. It retains the backend, no-workerd and shutdown checks. The fixture requires Apple's `codesign` and `clang` and is removed with the workspace.

Run the regression from the repository root with the pinned Node and dependencies installed:

```sh
cd cloudflare
TMPDIR="$PWD/../.work/tmp" ../scripts/offline-run.sh node scripts/run-tests.mjs --file test/scripts/development.test.ts
```

The unmodified test at `d695f11c` failed with `spawnSync ps EPERM` in this sandbox. The updated test passed on macOS with a nonzero RSS. A controlled change replacing `total += info.pti_resident_size` with `total += 0` made the test fail at its sampler assertion. Restore the source after that check. `make integration-local` also passed with the existing deny-outbound profile. Its local suite skipped the legacy upgrade test because the baseline build was absent.

On this nested worktree, `make test` stopped at `agent-test`: Cargo selected the primary checkout's workspace and rejected the nested agent package. A retry produced the same error. A full `make test` remains unverified in a checkout where Cargo can resolve the agent independently.
