# Recreating the standby writer from a tracked build (2026-11-22)

Simplification campaign S1 case 7: "A clean disposable guest can recreate,
reboot and recover the declared deployment, then ingest, read history and
replay duplicates correctly." **Passed on 2026-11-22 at 14:22 UTC** (run
`s1c7-20261122k`, below), after the earlier runs found seven gaps in the
tracked definition. The first attempts were stopped because the recreation's
disk writes degraded the production writer on the same host; the passing runs
kept every bulk write in RAM.

## Decision

The owner approved settling the guest-build question by recommendation.
Chosen: a tracked build for the current native layout, not a move to Stuff's
`oo` platform. Moving the writer is a writer handoff, which this campaign does
not authorize, and a topology change needs its own measured case.

## The build

`deploy/orange/recovery/guest/` (beside the tracked VM unit):

- `packages`: the live guest's `/etc/apk/world`, with `nodejs-current=26.13.1-r0`.
- `native-stats.openrc`: the live unit, byte for byte.
- `provision.sh`: runs as root on an Alpine 3.24 cloud guest with no network.
  Installs packages from a local repository; creates the service account and
  directories with the live owners and modes; generates `RIVET_TOKEN` (also
  the Engine admin token), `GATEWAY_SECRET` and the platform-bridge token on
  the guest; restores a sealed capture after checking every file and the exact
  file set against `depot.sha256`; creates the Engine from Stuff's declaration
  (`standby-engine create-args`) and seeds its state root; installs the runtime
  and app as rollout releases (`rt-…`, `app-…`, `current`, collector link);
  provisions the collector with `collector/install.sh --bundle`; and starts the
  services.
- `recreate.sh`: builds a disposable guest on a Linux host from a checksummed
  base image and a NoCloud seed, stages packages, the Engine image, runtime,
  app and capture offline, provisions, checks health, the declared app and
  collector identity (`rollout observe --target-kind native-app`), Engine drift
  (`standby-engine inspect`) and synthetic ingest with readback and duplicate
  replay through `gateway-proxy.mjs`, reboots, checks again, writes
  `~/.local/state/openorange/guests/NAME.json`, saves diagnostics on failure
  and destroys the guest.

Inputs for the declared deployment: runtime `rt-2c70c316ce8d`, app
`app-5091917968f7` (copied from the guest; digest reproduced), Engine
declaration (Stuff `551022bd`) and the validated capture
`sim-20261122T0236Z`.

## What the runs found

Each run on Threadripper failed at a later step; every cause was a real gap
in the tracked definition or the tooling, now fixed:

1. `lock_passwd: true` locks root's password, and this image's `sshd` (no
   PAM) then refuses root's key. Found by dumping cloud-init state to the
   serial console. The seed now keeps root's `*` password unlocked; password
   login stays impossible.
2. `apk` resolves a local repository by architecture and puts noarch packages
   under `noarch/`; the bundle now has `x86_64/` with its index and a `noarch`
   link. Proven offline in an `alpine:3.24` container with `--network none`.
3. `docker save` of a digest reference carries no image name, so the declared
   reference tried to pull. The loaded image is now named in its repository,
   which made create-by-digest work offline (proven in a Docker-in-Docker test).
4. **A second hand-made production fact.** The Engine image has no
   `/var/lib/rivet`; Docker creates it as root for the bind mounts, and the
   Engine (uid 10001) cannot create `objects.rivet-store-lock` there.
   Production works only because that directory in its container layer was
   given to 10001 by hand. Declared as `state_root` in Stuff `551022bd`, seeded
   with `docker cp` before first start, and checked by `inspect`; production
   matches.
5. macOS `tar` added 1,495 `._*` AppleDouble files to the capture copy, and the
   Engine's topology discovery failed on them; the manifest check passed
   because it only checked listed files. Mac-side archives now disable them,
   and the host and guest both require the restored file set to equal
   `depot.sha256` exactly.

## Why the first runs stopped

- At 04:45:22 UTC, while run 7's guest restored 2.3 GB and loaded images, the
  production Engine logged a late topology heartbeat, failed start reports and
  volume alarm callback failures.
- At 04:48–04:49, during run 8's host phase (`docker save` writing 427 MB, then
  the capture copy), production `/api/v1/hosts` took 1.4–1.9 s instead of about
  60 ms.
- Stopping the run returned it to about 60 ms within a minute.

The production VM's `io.latency` reservation did not prevent this. It fits the
2026-11-21 incident, which began with an 8.5 GB copy onto the same disk, and
the capture's warm copy earlier today. Rerunning there would repeat the
interference, so case 7 is parked.

Retry condition: a Linux host whose disk the production writer does not use,
or an owner-accepted bounded run on Threadripper (test VM in a cgroup with an
`io.max` write limit, inputs already cached). The host cache keeps only the
runtime archive; the capture must be copied again.

Diagnostics of the failed runs are in `~/.local/state/openorange/guests/` on
the workstation.

## Rerun with every bulk write in RAM (2026-11-22 13:30–14:22 UTC)

Threadripper has one NVMe disk, shared by production, Stuff's primary VM and
CI, and `/tmp` there is tmpfs. `recreate.sh` gained `GUEST_ROOT` (the host
directory for the guest, its overlay disk, staged inputs and cache; set to
`/tmp/stats-guest`) and `GUEST_CGROUP` (every host-side command and QEMU run
in a cgroup; `guest-recreate` had `io.max` `259:0 rbps=40 MiB/s wbps=20 MiB/s`).
Cached inputs are hard-linked, the host bundle is removed once the guest has
it, and the guest trims its copy after provisioning. Peak tmpfs use was about
10 GB. The capture was streamed from the workstation's off-host copy (14 m 39 s
at about 2.6 MB/s) and verified against `depot.sha256` on arrival. The
cgroup's `io.stat` showed no NVMe I/O. A watcher on the workstation ran
synthetic ingest against production every 45 s, sampled Engine warnings, and
would have killed the run after two failed samples; production recorded no
Engine warning and its host-side `/health` stayed at 11–15 ms throughout.

Two more gaps appeared, so the declaration now has seven:

6. Each run's ingest check returned 502 on every attempt. `recreate.sh`
   deleted `statsctl`'s output with its scratch, so the cause was unrecorded
   in run `h`. Run `i` kept it (502 from the local gateway proxy), and a probe
   of the SSH tunnel to the guest's app got no response while the app answered
   inside the guest. The
   image's sshd has `AllowTcpForwarding no`, and production works only because
   of a **third hand-made production fact**,
   `/etc/ssh/sshd_config.d/01-rehearsal-forward.conf` (`AllowTcpForwarding
   local`, `PermitOpen 127.0.0.1:8080`). Lisa's `stats-direct-tunnel` reaches
   the app through exactly that forward, so ingress depends on it. It is now
   `guest/sshd-forward.conf`, installed by `provision.sh`.
7. The check retried every 5 s, but the synthetic host is admitted six frames
   a minute and each attempt sends up to two, so retries after one early
   failure would all be refused as `rate_limited`. Attempts are now 20 s apart
   (12 attempts), and every attempt's output is kept in
   `~/.local/state/openorange/guests/NAME.ingest-PHASE*.json`.

Run `s1c7-20261122k` (inputs as above; Stats working tree on `d92ecf87a83`):

| Phase (UTC) | Ingest, readback, duplicate replay | App and collector identity | Engine drift |
| --- | --- | --- | --- |
| Provisioned 14:21:28 | pass on the first attempt | `app-5091917968f7` selected, running, collector | none |
| Rebooted 14:22:30 | pass (ingest 92 ms, latest 62 ms, replay 30 ms) | same | none |

Provisioning took 2 m 16 s after the guest started (14:19:05–14:21:21).
Result: `~/.local/state/openorange/guests/s1c7-20261122k.json`. The guest was
kept (`GUEST_KEEP=1`) for the Engine degradation drills (S2) and is destroyed
with `recreate.sh --destroy s1c7-20261122k`.

The same run's wrangler log writes fail with EACCES on `/home/native-stats`,
the service account's home, which `adduser -H` does not create. Production has
the same account and the same missing home, so the recreation matches it.

Reproduce (from a clean Stats checkout, on a Linux host with QEMU and Docker):

```sh
GUEST_HOST=threadripper GUEST_ROOT=/tmp/stats-guest GUEST_CGROUP=/sys/fs/cgroup/guest-recreate \
BASE_IMAGE=PATH_ON_HOST/alpine-3.24.4-x86_64-cloudinit-r0.qcow2 STUFF_ROOT=~/repos/laputa-systems/stuff \
RUNTIME_DIR=~/.local/state/openorange/releases/rt-2c70c316ce8d APP_DIR=APP_RELEASE_DIR \
STATS_CHECK_CREDENTIAL_FILE=~/.config/stats/synthetic-check.json STATSCTL=~/.local/state/openorange/rollout/tools/statsctl \
  deploy/orange/recovery/guest/recreate.sh NAME ~/backups/openorange/stats/standby-sim-20261122T0236Z
```

Create the cgroup first with `doas mkdir /sys/fs/cgroup/guest-recreate` and
write its `io.max`; the base image needs its `.sha512` beside it.
