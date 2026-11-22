# Qualifying two different Stats builds (2026-11-22)

Simplification campaign S5, first-checkpoint deliverable "a comparison
harness that can run two different Stats builds". `promotion.mts` previously
gave both sides the working tree's Worker bundles and one collector, so it
could compare runtimes but never one Stats build with another.

## Change

- `deploy/orange/app-release.mts` builds the committed tree into an app
  release directory: both Workers, their descriptors and the collector. That
  is the directory `make standby-deploy` stages, digested as
  `stats-app-manifest/1`. The TypeScript digest matches Stuff's
  `oomanifest.app_digest` on a golden tree (`qualification/manifest.test.mts`).
- `promotion.mts` requires `--baseline-app` and `--candidate-app`. Holding a
  layer constant means passing the same directory to both sides.
- `qualification/identity.mts` names the result by the layer that differs:
  runtime identities for a runtime change, app identities for an app change,
  `RUNTIME+APP` for both. Identical artifacts are refused, including relabelled
  identical bytes.
- Each side runs its own app release's collector, and its recovery check
  restarts that side's app release.
- Infrastructure sources take the side's identity only after they report the
  side's runtime release and, for Worker targets in an app or combined
  experiment, its app release.

Commits: Stats `9823e70ee76` (harness), `f0b51ef498c`, `e412704b6bc` and
`13c20433286` (fixes below).

## Run (Threadripper, native Linux, smoke profile)

- Baseline app: `app-313c0c901c20`, built from `stats-9823e70ee766`.
- Candidate app: `app-70a68d78f53f`, built from `stats-7004922b8f98`.
- Runtime on both sides: `rt-2c70c316ce8d`, archive `sha256:6cb79216…`
  matching its build record.

| | Baseline | Candidate |
| --- | --- | --- |
| Requests attempted / succeeded / body mismatches | 10 / 10 / 0 | 10 / 10 / 0 |
| Acknowledged writes / read back / lost | 2 / 2 / 0 | 2 / 2 / 0 |
| Duplicate mismatches | 0 | 0 |
| Sources | `stats`/`stats-self` as `app-313c0c901c20` | `stats`/`stats-self` as `app-70a68d78f53f` |
| CPU s / peak memory / restarts | 0.87 / 649 MiB / 0 | 0.73 / 659 MiB / 0 |

Recovery: the baseline app was restarted on the candidate's state copy and
read back exactly (`readbackVerified: true`). `statsctl verify release`
judged `pass` with no reasons, and `--replay` reproduced `pass`.

The manifests bind each side's runtime archive and manifest, app release,
Worker and collector digests, and the container image. The two builds have
identical Worker bundles and differ in their descriptors (release name), so
this run establishes that the harness qualifies two distinct app builds. It
is not a performance comparison: the smoke profile is 10 requests per side,
and no infrastructure source was evidenced in its 1 ms measured window, so
the source-attribution rule did not run against real infrastructure evidence.

Evidence: `~/.local/state/openorange/qualifications/sim-s5-app-20261122/` on
the workstation (`evidence/`, `evidence.sha256`, run and build logs).

## Defects found on the way

1. The collector's release file carried the experiment identity as its
   runtime release; the collector accepts only `rt-` identities and both
   collectors crashed with `invalid_batch` (fixed in `f0b51ef498c`).
2. `promotion.mts` removed its scratch in `finally`, and the root-owned canary
   files made that throw EACCES, replacing the run's own error. Cleanup failure
   is now reported without masking the cause.
3. The recovery check regenerated the baseline from the working tree's Worker
   build, testing a different app than the baseline (fixed).
4. Not fixed, filed as STA-137: the canary and qualification modules are not
   typechecked (217 errors in a probe that includes them), and `recover()` looks
   up the gateway secret as `X-Stats-Gateway-Secret`, which does not exist; it
   works only through its fallback to the first header value.

## Reproduce

```sh
node --experimental-strip-types deploy/orange/app-release.mts --out .work/tmp/apps/base
# commit, then
node --experimental-strip-types deploy/orange/app-release.mts --out .work/tmp/apps/cand
# on native Linux with Docker, from a checkout of the harness commit
TMPDIR="$PWD/.work/tmp" node --experimental-strip-types deploy/orange/qualification/promotion.mts \
  --baseline RUNTIME_DIR --candidate RUNTIME_DIR \
  --baseline-app .work/tmp/apps/base --candidate-app .work/tmp/apps/cand \
  --profile deploy/orange/qualification/profiles/smoke.json --out EVIDENCE_DIR
node --experimental-strip-types cloudflare/src/cli/statsctl.ts verify release --evidence EVIDENCE_DIR --replay --json
```

Root-owned canary scratch still needs a root container to remove.
