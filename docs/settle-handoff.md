# Settle handoff

Date: 2026-11-23. Default branch: `master`. Remote: `origin`
(`git@github.com:joshuarli/stats.git`). Work started from `origin/master`
`2f63d6998e5`; this handoff doc is the only commit added on top.

## State at handoff

- `master` is clean and in sync with `origin/master`. **No branches were merged.**
- `.git` was reduced from **9.2G to 324M**: the `blob:none` partial clone had
  accumulated 967 overlapping promisor packs. Fixed with
  `git repack -Ad --no-write-bitmap-index` then
  `git -c repack.writeBitmaps=false gc --prune=now`.
  **Bitmaps must stay off** — the partial clone has no full local object closure,
  so `git repack -Ad` without that flag fails with `failed to write bitmap index`.
- 17 live worktrees, all clean. The dead `stats-legacy-baseline` record was pruned.
- Stash `stash@{0}` = `stats-covering-index-candidate` on `feat/runtime-hardening`
  (base `506b622`), 3 files / +52 -7. Do not apply, drop, or convert without an
  owner decision.
- Open PR #37 (draft): `ci/deslop-ingest-gate`, no local branch.

## Unmerged local branches (13)

Each is 100–600 commits behind master; counts are `git cherry master <branch>`
`+` lines (genuinely unmerged patches). Merge bases are 2026-11-13 → 11-20.

| Branch | + | Merge base | Unique work |
| --- | --- | --- | --- |
| `archive/openorange-cf-export` | 2 | 11-13 | `14cbc35` DO export/import API; `2533333` backup paging retry |
| `archive/openorange-native-project-ui` | 1 | 11-14 | `100f622` partial native dashboard lane |
| `ci-yml` | 1 | 11-14 | `7e65590` add CI workflow |
| `fix-ci-jaq` | 9 | 11-14 | repomod actions fixes, pnpm pin, jaq/ripgrep install |
| `fix-pw-install` | 9 | 11-14 | same repomod/pnpm set; `3ec23e9` Playwright chromium install |
| `repomod/fix/7ec736dab…` | 5 | 11-14 | first five of the repomod/pnpm set |
| `test/perf-native-recovery` | 1 | 11-15 | `4d68242` parked perf-native-recovery changes |
| `feat/perf-overview` | 1 | 11-15 | `626328f` parked perf-overview changes |
| `fix/perf-producer-drain` | 1 | 11-15 | `6ed6dd0` parked perf-producer-drain changes |
| `test/perf-live-reads` | 1 | 11-15 | `cfdb21b` parked perf-live-reads changes |
| `test/preview-production` | 1 | 11-15 | `126ae9d` parked preview-production changes |
| `campaign/drop-services` | 1 | 11-20 | `01302b7` drop unexecuted rivet services package |
| `deslop/finish` | 15 | 11-20 | deslop docs/fixes + `ab8b2cd` move tickets to TODO.md |

Shared commits: `fix-ci-jaq`, `fix-pw-install`, `repomod/fix/7ec736dab…` and
`ci-yml` all contain `0a86bf9`, `7730c0e`, `7825bd3`, `fcbebdc`, `04a134e`,
`7e65590`, `dc4ffb5`, `8a5a60d`. Merge one and the others' `+` counts shrink.

Remote-only branches also carrying unmerged work: `fix-node-ready` (+8), and
`park/perf-overview`, `park/perf-live-reads`, `park/perf-native-recovery`,
`park/perf-producer-drain`, `park/preview-production` (+1 each, the parked perf
work above under different names). `park/native-dashboard-bench` and
`repomod/fix/471b1c44…` have no unmerged patches.

## Trial-merge evidence

`git merge --no-edit archive/openorange-cf-export` produced 9 conflicts:

```
cloudflare/src/cli/commands/backup.ts          (add/add)
cloudflare/src/cli/commands/index.ts           (content)
cloudflare/src/core/export/http.ts             (add/add)
cloudflare/src/core/export/snapshot.ts         (add/add)
cloudflare/src/core/http.ts                    (content)
cloudflare/src/observe/cloudflare/store-object.ts (content)
cloudflare/test/cli/target.test.ts             (content)
cloudflare/test/node/snapshot.test.ts          (add/add)
deploy/orange/backup.test.mts                  (add/add)
```

The merge was aborted cleanly. Expect ~100+ conflicts across the full set.

## Procedure

1. Re-read `/settle`. Start from clean `master` in the primary checkout.
2. Merge order: oldest divergence first, stacked branches after their base.
   Merge the shared repomod/CI set before the other CI branches so later merges
   are smaller.
3. Use `git merge --no-edit <branch>` — no squash, no rebase. Merge commit
   subjects follow `chore(merge): integrate <branch>`.
4. Resolve each conflict so both sides' intent survives; do not pick one side
   wholesale.
5. After each merge run the narrowest checks covering the changed files per
   `AGENTS.md` (`make agent-test`, `make cloudflare-test`, `make dashboard-test`,
   `make lint` as applicable). Fix failures on master in a separate commit. If a
   branch cannot pass without an owner decision, `git merge --abort` (or revert)
   and leave it out with a reason.
6. Push `master`; push any branch left unmerged with `git push -u origin <branch>`
   (never `--force`). If branch protection rejects the push, push to
   `settle/<date>` and open no PR.
7. Retire merged lane worktrees with `worktree-retire`, then preview and run
   `git-branch-consolidation --delete origin master`.

## Decision still needed

These are mostly `archive/*`, parked `test/perf-*` and stale CI/repomod work —
100–600 commits behind and largely superseded on master. Decide whether they
should be resurrected into the production default branch at all before merging.
