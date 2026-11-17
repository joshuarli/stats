# Verify the macOS development test in the offline sandbox

The development test copies `/bin/ps` into its disposable workspace, removes the setuid mode and signs the copy locally. The copy supplies process IDs, parent IDs and commands. On the tested macOS host the copy reports zero RSS, so a temporary `clang`-built `libproc` sampler reads resident sizes for the process tree. The test checks the sampler against its own process and requires a nonzero tree total. It retains the backend, no-workerd and shutdown checks. The fixture requires Apple's `codesign` and `clang` and is removed with the workspace.

Run the regression from the repository root with the pinned Node and dependencies installed:

```sh
cd cloudflare
TMPDIR="$PWD/../.work/tmp" ../scripts/offline-run.sh node scripts/run-tests.mjs --file test/scripts/development.test.ts
```

The unmodified test at `d695f11c` failed with `spawnSync ps EPERM` in this sandbox. The updated test passed on macOS with a nonzero RSS. A controlled change replacing `total += info.pti_resident_size` with `total += 0` made the test fail at its sampler assertion. Restore the source after that check. `make integration-local` also passed with the existing deny-outbound profile. Its local suite skipped the legacy upgrade test because the baseline build was absent.

Full macOS `make test` subsequently passed with the pinned Node 26.13.1 and pnpm 12.21.0, two guarded cores, one Cargo job and one Rust test thread. This includes the Rust agent, Node and Worker tests, all 320 dashboard cases, the offline local suite, four local browser checks and the repaired development test. The existing missing-baseline upgrade skip remains DSLP-8. These are correctness checks, not comparable performance measurements.

Two local harness adjustments were needed. Cargo searched the enclosing canonical workspace for the nested, excluded agent package; an empty `[workspace]` table was temporarily appended to this worktree's agent manifest, making its intended standalone workspace explicit. The original manifest was restored byte for byte after every run (SHA-256 `aecc4bb994ad8fbabc9eea57b3116ae81a432757872b3d9c5470eca9e58027eb`). The default eight browser workers also exceeded the one- and two-core guards; those interrupted runs are rejected. The passing run appended `--workers=1` to the dashboard test command through a task-local pnpm wrapper. It retained every test and assertion.

To reproduce the full check in a nested worktree, first select the pinned Node/pnpm and pass `make node-ready`. Save `agent/Cargo.toml` in a fresh directory under `.work/tmp`, install an EXIT trap that copies it back, and append an empty `[workspace]` table. Put this wrapper named `pnpm` in that scratch directory, set `STATS_VERIFY_PNPM` to the absolute real pnpm executable, and prepend the directory to PATH:

```sh
#!/bin/sh
for argument do
  if [ "$argument" = test:ui ]; then
    exec "$STATS_VERIFY_PNPM" "$@" --workers=1
  fi
done
exec "$STATS_VERIFY_PNPM" "$@"
```

Run `TMPDIR="$PWD/.work/tmp" CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 RUSTC_WRAPPER=kache cpu-guard --cores 2 -- make test`, then compare the restored manifest with its backup. The temporary workspace table and wrapper are verification fixtures; neither is a product change.
