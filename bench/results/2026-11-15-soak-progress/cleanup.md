# Worktree cleanup proof record

## Scope and evidence

- Repository: `/Users/josh/repos/stats`.
- Campaign head used: `d4a433731fa766bee79c2b546b9b38ec7517f3e1`.
- Coordinator confirmed both target lanes complete and no process, agent, or session uses either checkout.
- Cleanup procedure: `/Users/josh/usr/dotfiles/base/.agents/skills/cleanup/SKILL.md:10-12` requires porcelain inventory, integration and cleanliness checks, and `worktree-retire`; lines 18-22 require a final inventory and this report's evidence.

## Before retirement

- Command: `git -C /Users/josh/repos/stats worktree list --porcelain` — exit 0. It listed both requested worktrees, plus the integration checkout and unrelated worktrees. Initial integration checkout HEAD was `71a2b7e456f13b07243d51d02b68b5577856947a`; campaign-retire HEAD was the supplied campaign head.
- Commands: `git -C <target> status --short --branch` and `git -C <target> rev-parse HEAD` — exit 0. Native output: `## perf/native-scale-review`, HEAD `a98fe56480bd875777512d2aeabf242c0d82bd8b`; soak output: `## perf/soak-analysis...master [behind 1]`, HEAD `d4a433731fa766bee79c2b546b9b38ec7517f3e1`. Neither status showed modifications or untracked files.
- Commands: `git -C <target> ls-files --others --ignored --exclude-standard` — exit 0 for both; no output, so no untracked or ignored files were reported.
- Integration check: `git -C /Users/josh/repos/stats cherry d4a433731fa766bee79c2b546b9b38ec7517f3e1 a98fe56480bd875777512d2aeabf242c0d82bd8b` — exit 0; decisive output `- a98fe56480bd875777512d2aeabf242c0d82bd8b`, patch-equivalent to the campaign head. The commit's subject and four-file change summary matched the supplied cherry-pick `b15839f2a32`.
- Integration check: `git -C /Users/josh/repos/stats merge-base --is-ancestor d4a433731fa766bee79c2b546b9b38ec7517f3e1 d4a433731fa766bee79c2b546b9b38ec7517f3e1` — exit 0; soak HEAD is the campaign head itself.
- Disk command: `du -sk /Users/josh/repos/stats/.work/wt/native-scale-review /Users/josh/repos/stats/.work/wt/soak-analysis` — exit 0; respectively `40192 KiB` and `40224 KiB` (`80416 KiB` total).
- The separate integration checkout initially had `M pnpm-lock.yaml`; it was not edited by this task. This checkout (`campaign-retire`) was clean before report creation and remains in place.

## Retirement commands and exact results

1. `worktree-retire /Users/josh/repos/stats/.work/wt/native-scale-review --into d4a433731fa766bee79c2b546b9b38ec7517f3e1` — exit 0:

   ```text
   removed /Users/josh/repos/stats/.work/wt/native-scale-review (patch-equivalent of d4a433731fa766bee79c2b546b9b38ec7517f3e1)
   kept branch perf/native-scale-review (not an ancestor of d4a433731fa766bee79c2b546b9b38ec7517f3e1)
   ```

2. `worktree-retire /Users/josh/repos/stats/.work/wt/soak-analysis --into d4a433731fa766bee79c2b546b9b38ec7517f3e1` — exit 0:

   ```text
   removed /Users/josh/repos/stats/.work/wt/soak-analysis (ancestor of d4a433731fa766bee79c2b546b9b38ec7517f3e1)
   deleted branch perf/soak-analysis
   ```

The retained `perf/native-scale-review` branch is outside this task's requested worktree retirement result and was left by the tool. `perf/soak-analysis` was deleted by the tool while retiring its ancestor worktree. The integration checkout, campaign-retire checkout, and all unrelated worktrees were retained.

## Required final inventory and disk state

- Command: `git -C /Users/josh/repos/stats worktree list --porcelain` — exit 0. Exact output:

  ```text
  worktree /Users/josh/repos/stats
  HEAD e8e4388ef6f08a69771898542786d05cea8c53c7
  branch refs/heads/master

  worktree /Users/josh/repos/stats/.work/wt/btree
  HEAD f3efac3a7f40aa7cc31343633fbb2ec162b39d28
  branch refs/heads/refactor/btree-to-hash

  worktree /Users/josh/repos/stats/.work/wt/campaign-retire
  HEAD d4a433731fa766bee79c2b546b9b38ec7517f3e1
  branch refs/heads/chore/campaign-retire

  worktree /Users/josh/repos/stats/.work/wt/ci-pnpm
  HEAD 04a134efb8a2c4affd3556a6d8581be10a8a845f
  branch refs/heads/repomod/fix/7ec736dab90843dcbce1f6d6870e7b22

  worktree /Users/josh/repos/stats/.work/wt/upgrade-npm-deps
  HEAD 5b50033ad6c0a4280ab448ac14aa181a091d71f3
  branch refs/heads/upgrade/npm-deps

  worktree /Users/josh/repos/stats/.work/wt/upgrade-stats
  HEAD 5147cf3cb2417a9c624e3e75d27a0ba5735d118d
  branch refs/heads/upgrade-the-world/stats

  worktree /Users/josh/repos/stats/.work/wt/upgrade-todos
  HEAD 3e089e6c99de4440f1b0a38d7bc12a43034cd6af
  branch refs/heads/upgrade-the-world/todos
  ```

- Command: `for p in <native-path> <soak-path>; do if test -e "$p"; then du -sk "$p"; else printf 'absent %s 0 KiB at retired path\\n' "$p"; fi; done` — exit 0. Both paths printed `absent ... 0 KiB at retired path`; post-retirement size at each path is 0 KiB, with `80416 KiB` previously present in total.
- Command: `git -C /Users/josh/repos/stats branch --list 'perf/native-scale-review' 'perf/soak-analysis'` — exit 0; output contains only `perf/native-scale-review`.
- All unrelated worktree paths in the initial inventory remain in the final inventory. No scratch, fixture, remote, production, or other checkout was touched.

## Retained reasons and parent verification

- `/Users/josh/repos/stats`: retained as the integration checkout. The parent advanced it through `71a2b7e456f`, `721235cc057` and `e8e4388ef6f` while the cleanup worker ran, adding the follow-up ticket, campaign links and the analyzer verdict correction. These commits preserve the integration proof against `d4a433731fa`. The initial modified `pnpm-lock.yaml` was left alone.
- `/Users/josh/repos/stats/.work/wt/campaign-retire`: retained as the active task checkout at campaign head `d4a433731fa766bee79c2b546b9b38ec7517f3e1`.
- `/Users/josh/repos/stats/.work/wt/btree`, `ci-pnpm`, `upgrade-npm-deps`, `upgrade-stats`, and `upgrade-todos`: retained; all are outside the two-path authorization.
- No requested worktree was refused. No ignored or untracked data was reported by the pre-retirement checks. No tests were requested or run.
