# Musl runtime artifact, 2026-11-20

The runtime was built on macOS arm64 with Docker's linux/amd64 emulation. The image was `node:26.13.1-alpine`, manifest digest `sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5`. The container used Node 26.13.1 and pnpm 12.21.0. Stuff `origin/main` was `4dff3f6c47399b8ac018aafe5768438d9abbf147`.

## Artifacts

The following commands exited 0, with `TMPDIR=$PWD/.work/tmp`:

```sh
sh deploy/orange/runtime-artifact/build.sh --out .work/tmp/artifact-baseline
sh deploy/orange/runtime-artifact/build.sh --candidate "$HOME/.local/share/openorange-releases/open-orange-1.0.2-laputa.1/open-orange-1.0.2-laputa.1.tgz" --out .work/tmp/artifact-A
sh deploy/orange/runtime-artifact/build.sh --candidate "$HOME/.local/share/openorange-releases/open-orange-1.0.2-laputa.1/open-orange-1.0.2-laputa.1.tgz" --out .work/tmp/artifact-B
cmp .work/tmp/artifact-A/artifact.json .work/tmp/artifact-B/artifact.json
cmp .work/tmp/artifact-A/runtime.tar .work/tmp/artifact-B/runtime.tar
```

The baseline closure digest was `sha256:13b896622da56c58cbf63d7f399d4a0b446cbe201d8dce4b0c7ad78a9ce8e6f8`, matching the live standby's read-only digest. Its tar SHA-256 was `63efb17d23ddc101b6e6b8ac96fbe92c0c62844a5a8e966e175cfd8ca7fa59da`. The live and built identity fields matched: package SHA-256 `905ea47add0faa162bb8402882a9051f6ebaaafefd6b1f835f0ccad4a9a91d9f`, lock SHA-256 `13eafaa9b99d47e67fc1bc1df5c249c9d174756165d93118a62e37f24159104a`, entry point SHA-256 `d91f5934167f41d0f4f976b558bdea980c0324787ab8092b118b92814672ecdd`, OpenOrange `1.0.2`, rivetkit `3.1.2-rc.1`, and musl addon SHA-256 `4f74803b8b73adf56488f2e84ffdb0a30715cbc06d4c782bbe6c8058c483c07e`.

Both candidate closure digests were `sha256:4f8480e3299b926ba32d88f6cff81b33f58cebdd2fe18db2dabd92ee935fa11c`. Both tar SHA-256 values were `6e389779acf695691e7b16edc95a0b73669955e26a2631a397a019be34de3d09`. The candidate lock SHA-256 was `922ac225f243426c9380710809cc66080c449b26f4454f5ff9ad3f1816e529fb`. The owned tarball SHA-256 was `2a3932cd31115bf01bfcbd84d2a836fd66889203e7dd7d5d5e86c07cde2c8dfb`. The archive contains `@rivetkit/rivetkit-napi-linux-x64-musl/rivetkit-napi.linux-x64-musl.node`. Python 3.14 extracted the archive with `tarfile.extractall(filter='data')`, as the adapter does, and the adapter function recomputed the candidate digest above.

## Canary

`make worker-bundle observe-bundle` exited 0. The paired canary uses extracted archives mounted read-only into separate Alpine containers. It runs the shared workload, observes delivery and resources, checks state-copy recovery, and uses the actual `statsctl verify release` and replay. Its candidate manifest includes the candidate `runtime-closure` digest. A separate container runs the external Engine from the candidate closure and checks metrics for both `stats` and `stats-observe`.

```sh
TMPDIR="$PWD/.work/tmp" node --experimental-strip-types --test deploy/orange/runtime-artifact.test.mts
```

The test exited 0. Both verdict and replay were `pass`; both Worker metrics contained the expected worker identity and start time. The final run took 100.7 seconds wall time. An earlier run passed the release verdict and replay but failed the host metrics fetch because the listener was container-local. The final probe runs inside the container. This is an emulated local qualification, not a performance comparison. The test prints the retained evidence directory under `.work/tmp` for replay. No live standby mutation or rollout was performed.
