# Recreating the standby writer from a tracked build (2026-11-22)

Simplification campaign S1 case 7: "A clean disposable guest can recreate,
reboot and recover the declared deployment, then ingest, read history and
replay duplicates correctly." **Not yet passed.** The tracked build exists and
each failure it found is fixed, but the final run was stopped because the
recreation's disk writes degraded the production writer on the same host.

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

## Why it stopped

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
