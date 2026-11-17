# Development shutdown investigation

The Linux CI job 134245006295 for run 44141444620 failed at the first shutdown assertion with `process 9994 remains`. The job log does not contain that PID's original command, parent, start time, state, or later identity. It cannot distinguish a live descendant, an unreaped process, or a reused PID. The assertion waits up to five seconds before calling `kill(pid, 0)`.

The fixture sends SIGTERM to the first development process group and awaits the direct child's `close` event. `dev.ts` starts its backend in a separate process group, sends it an IPC shutdown message, and awaits its `close` event. The backend stops its OpenOrange session. The fixture snapshots every descendant before shutdown, including grandchildren and detached descendants. The direct child's `close` event alone does not identify the state of every PID in that snapshot.

On macOS, the unmodified focused test passed once. A subsequent diagnostic version failed on PID 15311, originally the backend child of dev PID 15290. After shutdown `ps` reported `15311 1 ?Es ... (node)`. A later `ps -p 15311` found no process. The copied, signed `ps` runs inside the offline sandbox, so this state does not establish whether Linux PID 9994 was a zombie or a live process. The development log from that failure had no `dev-stopped` event. The cause remains unverified.

The test now prints the pre-shutdown and post-shutdown rows on assertion failure. On Linux it also records `/proc/<pid>/stat`, whose state, parent PID and start time can distinguish reaping and PID reuse. A missing stat row is reported explicitly. The original PID assertions, deadline and second-workspace checks remain in place. Compare the original and final start times before treating a surviving PID as the same process. Record the ownership chain and exit status as well if the Linux failure recurs. Do not infer a live leak or weaken the assertion from PID existence alone.

## Reproduce the focused test

Use the pinned Node and existing project dependencies. From the repository root, with `.work/tmp` present, run:

```sh
PATH="/Users/josh/repos/stats/.work/toolchain/node-v26.13.1-darwin-arm64/bin:$PATH" \
TMPDIR="$PWD/.work/tmp" CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 RUSTC_WRAPPER=kache \
cpu-guard --cores 2 -- sh -c 'cd cloudflare && ../scripts/offline-run.sh node scripts/run-tests.mjs --file test/scripts/development.test.ts'
```

The initial scratch-copy runs used an altered home environment and symlinked dependencies. Those setup results are rejected as verification evidence. The scratch-copy failure remains a recorded observation: PID 15311 had the same `lstart` before and after shutdown, but its state at the assertion is not established.

The corrected setup installed the existing lockfiles in the assigned worktree, with the pinned Node and pnpm, without lifecycle scripts:

```sh
PATH="/Users/josh/repos/stats/.work/toolchain/node-v26.13.1-darwin-arm64/bin:$PATH" TMPDIR="$PWD/.work/tmp" CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 RUSTC_WRAPPER=kache cpu-guard --cores 2 -- pnpm install --frozen-lockfile --ignore-scripts
PATH="/Users/josh/repos/stats/.work/toolchain/node-v26.13.1-darwin-arm64/bin:$PATH" TMPDIR="$PWD/.work/tmp" CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 RUSTC_WRAPPER=kache cpu-guard --cores 2 -- pnpm --dir deploy/orange install --frozen-lockfile --ignore-scripts
```

Both commands exited 0. The second command unexpectedly changed `deploy/orange/pnpm-lock.yaml` despite `--frozen-lockfile`; the investigation restored the file from HEAD and verified no diff. No dependency change is included.

The first focused run in the real worktree exited 1: `kill(19180, 0)` succeeded for the snapshotted backend PID after the five-second wait. The subsequent diagnostic `ps` contained no row for 19180. The dev log did not contain `dev-stopped`. These observations do not show the process state at the assertion or why the dev process exited. After adding the dev process exit code, signal and `dev-stopped` status to failure diagnostics, the focused command above exited 0 with one test passed and none skipped. This pass does not explain the earlier failure.

The following command exited 0 in the real worktree:

```sh
PATH="/Users/josh/repos/stats/.work/toolchain/node-v26.13.1-darwin-arm64/bin:$PATH" TMPDIR="$PWD/.work/tmp" CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 RUSTC_WRAPPER=kache cpu-guard --cores 2 -- make lint
```

The earlier direct attempts before installation exited 1 with `ERR_MODULE_NOT_FOUND` for `@playwright/test`. The rejected scratch lint attempts failed on a symlinked task-state directory and then unresolved types in `playwright.config.ts`. They do not establish a product defect.

For a Linux recurrence, preserve the failure output including the pre- and post-stop `/proc` stat rows and dev exit diagnostics. Compare PID start times and inspect state and parent PID. If the process vanishes between `kill(0)` and the post-stop snapshot, capture those observations at the assertion boundary before choosing a repair. This diagnostic is not a verified shutdown repair.

## Verify the zombie observation

The following controlled macOS witness forks a child, leaves it unreaped until commanded, and then reaps it. Both processes belong to the witness. The commands create files only under `.work/tmp`.

```sh
mkdir -p .work/tmp
cat > .work/tmp/zombie-witness.c <<'C'
#include <stdio.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
  pid_t child = fork();
  if (child < 0) return 2;
  if (child == 0) _exit(0);
  printf("%d\n", child); fflush(stdout);
  (void)getchar();
  return waitpid(child, NULL, 0) == child ? 0 : 3;
}
C
cat > .work/tmp/zombie-witness.mjs <<'JS'
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
const parent = spawn(process.argv[2], [], {stdio: ['pipe', 'pipe', 'inherit']});
try {
  const [data] = await once(parent.stdout, 'data');
  const child = Number(String(data).trim());
  const deadline = Date.now() + 5000;
  let state = '';
  do {
    state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(child)], {encoding:'utf8'}).trim();
    if (state.startsWith('Z')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  if (!state.startsWith('Z')) throw Error(`expected zombie, got ${state}`);
  process.kill(child, 0);
  console.log(`unreaped child: state=${state}; kill(0)=success`);
  parent.stdin.end('\n');
  const [code] = await once(parent, 'close');
  if (code !== 0) throw Error(`parent exit ${code}`);
  try { process.kill(child, 0); throw Error('reaped PID remains'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  console.log('reaped child: kill(0)=ESRCH');
} finally {
  if (parent.exitCode === null) {
    parent.stdin.end('\n'); parent.kill('SIGKILL');
    await once(parent, 'close').catch(() => {});
  }
}
JS
PATH="/Users/josh/repos/stats/.work/toolchain/node-v26.13.1-darwin-arm64/bin:$PATH" \
TMPDIR="$PWD/.work/tmp" cpu-guard --cores 2 -- sh -c \
  'clang -o .work/tmp/zombie-witness .work/tmp/zombie-witness.c && node .work/tmp/zombie-witness.mjs .work/tmp/zombie-witness'
```

The witness exited 0 and printed `unreaped child: state=Z; kill(0)=success`, then `reaped child: kill(0)=ESRCH`. This demonstrates the assertion's ambiguity, not the cause of the CI failure.
