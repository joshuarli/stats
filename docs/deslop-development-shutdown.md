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

The worktree used for this investigation had no installed dependencies. The two direct attempts exited 1 with `ERR_MODULE_NOT_FOUND` for `@playwright/test`. The native runs used a `git archive HEAD` copy under `.work/tmp/repro`, symlinks to already installed project-local root, cloudflare and Orange `node_modules`, a scratch HOME, and `PLAYWRIGHT_BROWSERS_PATH` pointing to the installed browser. They retained the offline sandbox. The first diagnostic failure above used the same focused command in that copy. A later run of the final diagnostic version passed. This is not a Linux reproduction.

To reproduce the scratch setup on this host, run these commands before the focused command, then run that command from `.work/tmp/repro` with the scratch HOME and browser path shown:

```sh
mkdir -p .work/tmp/repro .work/tmp/home
git archive HEAD | tar -x -C .work/tmp/repro
ln -s /Users/josh/repos/stats/.work/wt/asb/node_modules .work/tmp/repro/node_modules
ln -s /Users/josh/repos/stats/.work/wt/asb/cloudflare/node_modules .work/tmp/repro/cloudflare/node_modules
ln -s /Users/josh/repos/stats/.work/wt/asb/deploy/orange/node_modules .work/tmp/repro/deploy/orange/node_modules
mkdir -p .work/tmp/repro/.work/tmp
cd .work/tmp/repro
HOME="$(cd ../home && pwd)" PLAYWRIGHT_BROWSERS_PATH=/Users/josh/Library/Caches/ms-playwright \
PATH="/Users/josh/repos/stats/.work/toolchain/node-v26.13.1-darwin-arm64/bin:$PATH" \
TMPDIR="$PWD/.work/tmp" CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 RUSTC_WRAPPER=kache \
cpu-guard --cores 2 -- sh -c 'cd cloudflare && ../scripts/offline-run.sh node scripts/run-tests.mjs --file test/scripts/development.test.ts'
```

The diagnostic copy's `make lint` did not pass. pnpm first rejected a symlinked task-state directory. After placing task state in the scratch copy, type-aware lint reported unresolved error types in `playwright.config.ts`. The diagnostic is not a verified shutdown repair.

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
