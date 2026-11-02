# Campaign: Linux power stats

## Status

- **Goal:** Linux hosts report CPU package power, and laptops report whole-system
  power while discharging, in the existing Power widget. The agent stays
  unprivileged, adds no dependency, and never turns an unreadable source into
  zero. GPU energy stays macOS-only.
- **State:** Ready for execution; no slice started. Baseline `44426d0`. Local
  `make check` is green in 15.4 s. Threadripper evidence (2026-11-02): Linux
  7.2.9, `intel-rapl:0` `package-0` with a `core` subzone, `energy_uj` is
  `0400 root root`, no batteries, no udev, and `stats --bench 20 100` has a
  1.110504 ms collection median.
- **Accepted:** none. **Red:** none. **Parked:** none.
- **Next:** P1.
- **Resume:** `Execute docs/CAMPAIGN-LINUX-POWER.md from item P1. Read the item, own only its files, and finish on its acceptance command.`

## Charter

- Decide and keep going. Record a decision only when a later slice depends on
  it; write it into **Decisions**, not a log.
- The execution grant covers local edits, local commits, local test runs,
  `.work/` scratch, and read-only inspection of this checkout. It never covers
  pushes, deploys, Cloudflare writes, SSH writes, `sudo`/`doas`, changing sysfs
  permissions, starting or stopping services, new dependencies, or formatters.
  Park anything that needs more.
- Hard stops park the item, never the campaign: a live write, a forbidden
  effect, or a check that cannot run here. Put the proof on **Needs
  environment** with the command the owner runs.
- Parity before optimization. Every item lands only when its acceptance command
  and the narrowest affected suite pass on the integrated tree. Full
  `make check` runs at M1 (after P1), M2 (after P2), M3 (after P3), and close.
  Red work never lands.
- One writer, one slice at a time. P2 and P3 are file-disjoint but serial by
  default because the whole loop is 15 s and a fresh worktree would need a
  dependency install. No parallel pair is required.
- A failing item gets root-cause first, then at most two fix attempts, then it
  is parked on its branch with the cause and a retry condition.
- Fix anything egregious met on the way, in its own commit. Egregious means:
  `make check` over 25 s, `make agent-test` over 4 s, `make cloudflare-test`
  over 8 s, `make dashboard-test` over 15 s, `make lint` over 3 s; a flaky test
  (fails in 1 of 3 runs); a collection median over 5 ms on threadripper; or a
  wire value that is synthesized rather than absent. Record anything else and
  leave it.
- Known traps. Each cost a design pass or is easy to get wrong:
  - `make agent-test` on macOS does not compile `linux.rs`; the pure reader in
    `agent/src/power.rs` must be compiled under `cfg(any(target_os = "linux",
    test))` so its tests run here.
  - `make agent-build` cross-compiles Linux but cannot exercise it. The live
    `--once` and Linux `cargo test` are **Needs environment**.
  - The Worker rejects unknown sample fields. Deploy the Worker before any
    agent emits `cpuNj`, or the whole batch is `invalid_sample`.
  - `energy_uj` is `0400 root` since CVE-2020-8694. The agent reads it only when
    an operator grants the `stats` group read; an unreadable file is normal.
  - Threadripper has no udev, so the udev rule is not exercised there; use the
    direct `chgrp`/`chmod` command on that host.
  - A `power` group with only `cpuNj` must not also be listed in `unavailable`.
  - Old rollups have no `cpuCoveredMs`; `powerValues` must treat it as absent,
    never divide by zero.
  - The battery source gives one reading per sample; the agent accumulates the
    sum and count. Do not emit `power_now` directly as `systemMwSum`.
  - `cpuNj` is a u64 of nanojoules: 5,120 kWh. Omit on overflow; never wrap.
  - No code comment cites this document.

Every commit is a Conventional Commit; the scope is the workstream (`protocol`,
`agent`, `dashboard`, `docs`). The item ID goes in the body. No formatters.
Never push. Invoke the parent steering checkpoint after each accepted slice.

## Decisions

### Owner (2026-11-02)

- **O1 · Add `power.cpuNj` to protocol v1.** CPU package energy needs a wire
  field; the Worker accepts it first, then the agent emits it. An additive v1
  field with a coordinated deploy is smaller than a v2 bump and keeps the
  existing `gpuNj` shape.
- **O2 · Defer Linux GPU energy.** `amdgpu` `power1_average` includes the CPU on
  APUs, there is no stable GPU-only sysfs counter, and a wrong GPU series is
  worse than an absent one. Reversal needs a reliable GPU-only source or a
  vetted APU detector.
- **O3 · Opt-in RAPL permission.** Ship the udev rule and document the
  no-udev fallback. Grant only the `stats` group read on `energy_uj`; never make
  it world-readable, never write, never run the agent as root. Missing
  permission is a normal `unavailable`, not a failure.

### Prescribed

- **S1 · CPU package source.** Read
  `/sys/class/powercap/intel-rapl:<n>/energy_uj` for top-level zones whose
  `name` is `package-<n>` and sum their deltas. Ignore subzones
  (`intel-rapl:<n>:<m>`), `dram`, `psys` (`intel-rapl-mmio:0`), and the control
  type directory. `energy_uj` is microjoules; emit `cpuNj = total_uj * 1000` as
  a decimal string. This covers Intel and the kernel's AMD RAPL support
  (`intel_rapl_msr` matches AMD 0x17/0x19/0x1A). Do not add an `amd_energy`
  hwmon fallback: its socket and core counters are easy to double count, and
  the powercap interface is present on the target kernels. Reversal: a
  supported host with no powercap zone but a readable `amd_energy` socket
  counter.
- **S2 · Battery system source.** Read `/sys/class/power_supply/*` entries with
  `type == "Battery"`. Report `system` only when at least one battery exists and
  every battery's `status == "Discharging"`; sum `power_now` (µW), falling back
  to `|current_now| * voltage_now / 1e6` when `power_now` is absent. If any
  discharging battery has no reading, emit no system power rather than an
  undercount. Charging, full, not-charging, and unknown emit no system power.
  Accumulate `total_uw` and `readings` in the agent; emit
  `systemMwSum = total_uw / 1000` and `systemReadings = readings`. A present
  `power_now` of 0 is a reading; a missing file is not.
- **S3 · Counter semantics.** On the first successful read of a package zone,
  use its raw `energy_uj` as the series baseline. After that add `raw - last`.
  On a decrease, treat it as a wrap only when `max_energy_range_uj` is present,
  `last > max / 2`, and `raw < max / 2`; add `max - last + raw`. Otherwise
  treat it as a reset: set the zone total to `raw`; if that makes the emitted
  sum regress, the Worker records a gap, and either way no synthetic spike is
  added. Keep each zone's total when it stops
  being readable; a zone first seen after a baseline has been established starts
  at 0. Use checked arithmetic; if the total or the nJ conversion would overflow
  u64, omit `cpuNj` for that sample. A counter regression never becomes a
  negative rate.
- **S4 · Agent state.** Add `Sampler` as the stateful entry: `run` and `--bench`
  hold one for the process; `sample_once` stays as a stateless convenience that
  creates a fresh `Sampler`, so `--once` and the Linux integration test keep
  their shape. Put the sysfs reader in `agent/src/power.rs`, compiled under
  `cfg(any(target_os = "linux", test))`; `linux.rs` owns the real `/sys` root and
  the `Sampler`. `macos.rs` gets a fieldless `Sampler` and sets `cpu_nj: None`;
  an unsupported-target `Sampler` fallback keeps the library building elsewhere.
  The `Power` model gains `cpuNj`.
- **S5 · Display.** The Power widget includes a series only when at least one
  point carries it: system (blue, join gaps), CPU package (violet), GPU (aqua).
  A Linux host therefore sees no empty GPU or system legend. The dashboard
  label is "CPU package"; the API name is `cpuWatts`.
- **S6 · Storage and API.** `PowerRollup` gains optional `cpuCoveredMs`;
  `sumPower` carries it like `gpuCoveredMs`; `powerValues` computes
  `cpuWatts = cpuNj / cpuCoveredMs / 1e6` only when both are present and the
  covered interval is positive. Old rollups lack the field and produce no CPU
  watts. The binary history summary schema gains `power.cpuWatts`. No SQL
  migration: rollups are JSON TEXT.
- **S7 · Deploy order.** The Worker must accept `cpuNj` before any agent sends
  it. Deploy the Worker from P1 first, then the agent from P3, then install the
  permission. An agent that sends `cpuNj` to an old Worker gets
  `invalid_sample`; there is no fallback or version negotiation.
- **S8 · Permission.** Ship `agent/contrib/udev/99-stats-rapl.rules` granting
  the `stats` group read (`0440`) on powercap `energy_uj`, never write, never
  other powercap attributes. On a host without udev (threadripper is
  busybox/Alpine), document a boot-time `chgrp stats`/`chmod 0440` command. The
  agent never elevates, changes permissions, or logs a missing source. The rule
  is opt-in; the baseline install does not add it.
- **S9 · Performance.** No new dependencies. `make agent-test` stays under 4 s,
  `make cloudflare-test` under 8 s, `make dashboard-test` under 15 s, `make
  lint` under 3 s, `make check` under 25 s. The threadripper collection median
  baseline is 1.110504 ms; after the change it must stay under 2.0 ms and the
  20-sample total under 40 ms. A median over 5 ms is egregious and gets fixed.
  The benchmark is logged, not a gate.
- **S10 · Fixtures.** `batch-linux-power.json` (accept) has one sample whose
  `power` object carries only `cpuNj` and one whose `power` carries `cpuNj`
  plus the system pair; `invalid-power-cpu.json` (reject `invalid_sample`) uses
  `"cpuNj": "1.5"`.
  Both are listed in `fixtures/v1/manifest.json`; `make fixtures` reports 35.
  The agent validator's power key set gains `cpuNj`.
- **S11 · Docs and invariant.** `docs/protocol.md` states the field, unit, watts
  formula, and gap rule. `docs/architecture.md` states the Linux sources, state,
  and permissions. `docs/operations.md` has the udev/OpenRC instructions,
  security note, verification, and deploy order. `README.md` mentions the Linux
  sources and the Power series. `AGENTS.md` gains: "Linux power comes only from
  sysfs: CPU package energy from readable powercap package zones and system
  power from a discharging battery; the agent never elevates or turns an
  unreadable source into zero." Its Docs table links this campaign from the
  Open work row while the campaign is active.

### Delegated (decide inside the bound, log only if a later slice depends on it)

- Helper and test names, the layout inside `power.rs`, the exact `Sampler`
  plumbing, and the conditional-series expression in `Power.tsx`.
- Commit scopes within `protocol`, `agent`, `dashboard`, and `docs`.
- The wording of empty states and doc prose that does not change a contract.

## Baseline

- Known red: none at `44426d0`.
- Loop timings (2026-11-02, warm on this Mac): `make fixtures` 0.34 s (33
  fixtures), `make agent-test` 1.32 s (79 unit plus 3 fixture tests), `make
  cloudflare-test` 4.95 s (180 to 181 tests), `make dashboard-test` 8.99 s (40
  tests, builds first), `make lint` 1.06 s, `make agent-build` 0.82 s (cached),
  `make check` 15.4 s.
- Threadripper (Alpine edge, Linux 7.2.9-2-stable, AMD package via powercap):
  - `/sys/class/powercap/intel-rapl:0` is `package-0`; `intel-rapl:0:0` is
    `core`; `max_energy_range_uj` is 65,532,610,987, which wraps in under four
    minutes at 280 W.
  - `energy_uj` is `0400 root root`; `josh` cannot read it. `stats` is uid 104 /
    gid 107. `/sys/class/power_supply` has no battery.
  - No `udevadm` and no `/run/udev`; PID 1 is busybox init.
  - The installed `stats 0.1.0` `--once` has no `power` and no `gpu`, with
    `unavailable: ["psi"]`.
  - `stats --bench 20 100`: collection median 1.110504 ms, 22.400046 ms total,
    34,906,112 bytes max RSS.
- Current wire sample from `make fixtures`: 1,666 bytes; `batch-full` is 3,332
  bytes for two samples. The new fixture must stay under the 65,536-byte cap.

## Sequence

All items are serial. P2 and P3 own disjoint files but are not run in parallel.

| ID | Item | Owns | After | Acceptance |
| --- | --- | --- | --- | --- |
| P1 | Wire field, Worker pipeline, fixtures | `cloudflare/src/protocol.ts`, `cloudflare/src/delta.ts`, `cloudflare/src/aggregate.ts`, `cloudflare/src/binary/history.ts`, `cloudflare/src/client/api.ts`, `cloudflare/test/aggregate.test.ts`, `cloudflare/test/binary/cases.ts`, `fixtures/v1/batch-linux-power.json`, `fixtures/v1/invalid-power-cpu.json`, `fixtures/v1/manifest.json`, `agent/tests/fixtures.rs`, `docs/protocol.md` | | `make fixtures` and `cd cloudflare && pnpm exec vitest run test/aggregate.test.ts test/ingest.test.ts` and `make agent-test` |
| P2 | Power widget series | `cloudflare/src/client/pages/host/Power.tsx`, `cloudflare/test/ui/dashboard.spec.ts` | P1 | `make dashboard-test` |
| P3 | Linux sysfs reader and agent state | `agent/src/power.rs`, `agent/src/model.rs`, `agent/src/lib.rs`, `agent/src/linux.rs`, `agent/src/macos.rs`, `agent/src/main.rs`, `agent/src/runtime.rs` | P1 | `make agent-test`, `make agent-build`, `make agent-build-macos`; Linux proof on **Needs environment** |
| P4 | Permission rule, docs, invariant | `agent/contrib/udev/99-stats-rapl.rules`, `README.md`, `docs/architecture.md`, `docs/operations.md`, `AGENTS.md` | P3 | `make check`; `mdtool check --untracked docs/CAMPAIGN-LINUX-POWER.md` |
| P5 | Close | none | P4 | `ultrareview`; fix its P1 and P2 findings; delete dead code (a `rg` for each new export with no consumer); final report |

Item content (what makes each acceptance meaningful):

- **P1.** Add `cpuNj` to `Power` and `parsePower`; add the per-field delta in
  `powerDelta`; add `cpuCoveredMs` and `cpuWatts` to `PowerRollup`,
  `PowerValues`, `sumPower`, and `powerValues`; add the binary summary field and
  the client decoder. Tests: `power: {cpuNj}` alone is accepted; `"1.5"`,
  negative, leading-zero, and an unknown extra key are rejected; a CPU delta
  becomes watts per raw sample; a rollup sums energy and covered time; combining
  rollups carries `cpuCoveredMs`; a missing field leaves system and GPU intact;
  a regression omits only CPU; an old rollup has no CPU watts; a zero covered
  interval does not divide by zero; CPU and GPU covered intervals stay
  independent. Fixtures: one accept whose `power` has only `cpuNj` and one
  whose `power` has `cpuNj` plus the system pair; one reject with a non-decimal
  `cpuNj`. Update the agent fixture validator's `u64_map` optional keys.
- **P2.** Render only series that have data. The existing accelerator mock gains
  `cpuWatts` and asserts "CPU package"; a CPU-only mock shows the Power widget
  with only that series, and no system or GPU legend. Existing GPU, system,
  mobile, and keyboard tests stay green.
- **P3.** `power.rs` reads the synthetic sysfs tree in tests: battery
  discharging accumulates sum and count; AC and charging stop without resetting;
  the current-times-voltage fallback; no battery; one package's first/second
  read; wrap at `max_energy_range_uj`; a reset from below half the range
  regresses rather than spiking, and a missing max resets; two packages; core,
  dram, and psys ignored; unreadable and missing files; readable after unreadable
  baselines at raw; a zone appearing after the baseline starts at 0; a zone
  disappearing keeps its total; overflow omits; neither source returns `None`;
  both sources return one `Power`. The agent marks `Unavailable::Power` only when
  no field is present. `Sampler` persists across two calls; `sample_once` still
  returns a valid single sample.
- **P4.** The udev rule targets `SUBSYSTEM=="powercap"`, `ACTION=="add|change"`,
  `TEST=="energy_uj"`, `chgrp stats`, `chmod 0440`, and nothing else. The
  operations section covers udev, the busybox/OpenRC fallback, the
  CVE-2020-8694/PLATYPUS tradeoff, verification, and Worker-before-agent order.
  The architecture and README describe the sources and the absence rules.
  `AGENTS.md` gains the invariant and the Open work link.
- **P5.** Run the review lens, fix every P1 and P2 finding, delete dead exports,
  and report the final live and deferred checks.

## Acceptance

- **Wire and Worker:** `make fixtures` reports 35 checked; the accept fixture
  passes both `ingest.test.ts` and `agent/tests/fixtures.rs`; the reject fixture
  is `invalid_sample`; the aggregate tests cover raw, rollup, combine, gap,
  regression, old rollup, and independent covered intervals. Failure is a
  `cpuNj` that is accepted without watts, a malformed value that passes, a
  divide by zero, or a regression that becomes a negative or zero rate.
- **Dashboard:** `make dashboard-test` passes with the new "CPU package"
  assertions. Failure is a missing series when `cpuWatts` exists, a CPU-only
  host that shows an empty system or GPU legend, or a regression in the
  existing GPU/system test.
- **Agent:** `make agent-test` and `make agent-build` pass; `make
  agent-build-macos` passes; the new tests cover S1 to S3. Failure is a source
  that produces zero instead of absent, a wrap that regresses, a reset that
  spikes, a battery count that advances on AC, a dynamic interpreter or
  dependency in either ELF, or a `Sampler` that loses state between calls.
- **Docs and permission:** `make check` passes; `mdtool check --untracked
  docs/CAMPAIGN-LINUX-POWER.md` passes; the udev rule grants only group read on
  `energy_uj`; the operations doc carries the deploy order and both permission
  paths. Failure is a rule that is world-readable or writable, a missing
  verification command, or a doc that says the agent needs root.
- **Whole:** `make check` passes at M1, M2, M3, and close, with the existing
  suites green. Failure is any red test on the integrated tree.

## Needs environment

The executor cannot run these; the owner does.

- **E1 · Threadripper permission and live sample.** Threadripper has no udev.
  As root:
  `doas sh -c 'chgrp stats /sys/class/powercap/intel-rapl:*/energy_uj && chmod 0440 /sys/class/powercap/intel-rapl:*/energy_uj'`.
  Then `ls -l /sys/class/powercap/intel-rapl:*/energy_uj` shows
  `-r--r----- root stats`, and
  `su -s /bin/sh stats -c '/usr/local/bin/stats --once'` contains a decimal
  `power.cpuNj` and no `system`. Two runs at least 15 s apart increase
  `cpuNj`. `unavailable` no longer contains `power`.
- **E2 · Threadripper performance.** After the agent deploy, run
  `su -s /bin/sh stats -c '/usr/local/bin/stats --bench 20 100'` and record the
  median and total against 1.110504 ms and 22.400046 ms. The thresholds are
  2.0 ms median and 40 ms total; a median over 5 ms is egregious.
- **E3 · Udev host.** On a systemd/udev Linux host with RAPL, install
  `agent/contrib/udev/99-stats-rapl.rules`, run
  `udevadm control --reload-rules` and
  `udevadm trigger --subsystem-match=powercap --action=add`, and confirm the
  mode and a `cpuNj` from the service user. Threadripper cannot prove this.
- **E4 · Battery host.** No Linux battery host is in `deploy/hosts.json`. If the
  owner has one, run the agent while discharging and on AC: `systemMwSum` and
  `systemReadings` must advance only while discharging, and `systemWatts` must
  appear only after two samples. The synthetic tests are the local proof.
- **E5 · Linux compile and test.** In a Linux checkout or container with Rust,
  run `make agent-test` so `linux.rs` and the Linux-only integration test
  compile. The macOS test build does not cover them.
- **E6 · Deploy order and live dashboard read.** Deploy the Worker from P1, then
  the agent from P3, then E1. Open the threadripper host page: the Power widget
  shows "CPU package" and no system or GPU series. Do not regenerate the replay
  golden in this campaign; the mocked UI test is the UI proof.

## Execution boundary and non-goals

**Authorized:** local edits, local test runs, `.work/` scratch, `make check`,
`make agent-test`, `make agent-build`, `make agent-build-macos`, `make
fixtures`, `make cloudflare-test`, `make dashboard-test`, `make lint`,
`mdtool`, read-only `rg`/`fd`, and `ultrareview`. **Forbidden:** push; `make
deploy*`, `cf deploy`, `cf workers triggers deploy`; any Cloudflare write;
SSH writes; `sudo`/`doas`; changing sysfs permissions; creating tokens or
secrets; new dependencies; formatters; edits in `../` repositories; changing
the wire version.

**Contract changes the owner is accepting** (each is written up in P1/P4):

- Protocol v1: `power.cpuNj`, cumulative CPU package energy in nanojoules, in
  addition to `gpuNj` and the system pair. Unknown fields are still rejected,
  so the Worker deploys first.
- Rollup JSON: optional `cpuCoveredMs`; no SQL migration.
- Host summary API and binary history: `power.cpuWatts`.
- Agent: `Power.cpuNj`, a stateful `Sampler`, and the Linux sysfs reader; no
  new config key.
- Permission: an opt-in udev rule and a documented no-udev command; the agent
  stays unprivileged.
- `AGENTS.md` power invariant.
- Unchanged: system power semantics, GPU energy, wire version, fixture format,
  SQL schema, dependencies, deploy scripts, tokens, and auth.

**Non-goals, with reasons:** Linux GPU energy (APU attribution, O2); PSys and
platform energy (not whole-system, so it cannot use `system`); DRAM, uncore, and
per-core energy (a different quantity); `amd_energy` hwmon (powercap covers the
target kernels and its socket/core counters double count); IPMI, BMC, and PDU
power (outside the kernel and a separate integration); battery charge, energy
remaining, and time-to-empty (not power); power health alerts (no scored power
series); Linux GPU busy/residency (the existing gap, not this campaign); other
operating systems; re-benchmarking binary history.

## Reference

Verified at `44426d0`:

- `agent/src/lib.rs:34` `sample_once`; `agent/src/linux.rs:260` `sample`;
  `agent/src/model.rs:174` `Power`, `:182` `SystemPower`, `:233` sample power,
  `:273` `has_metrics`; `agent/src/macos.rs:403` power construction.
- `agent/src/runtime.rs:281` `sample_with_block`, `:318` and `:325` the sample
  loop; `agent/src/main.rs:49` and `:86` the one-shot and bench calls.
- `agent/tests/fixtures.rs:206` power validation, `:334` the Linux-only real
  sample test.
- `cloudflare/src/protocol.ts:97` `Power`, `:232` `parsePower`, `:325` sample
  validation; `cloudflare/src/delta.ts:52` `powerDelta`.
- `cloudflare/src/aggregate.ts:48` `PowerValues`, `:119` `PowerRollup`, `:255`
  `sumPower`, `:274` `powerValues`, `:343` and `:438` rollup calls, `:502` and
  `:516` summary construction.
- `cloudflare/src/binary/history.ts:19` summary schema;
  `cloudflare/src/client/api.ts:59` client `Power`, `:361` decoder;
  `cloudflare/src/client/pages/host/Power.tsx:8` `reportsPower`, `:12` widget.
- `cloudflare/test/aggregate.test.ts:184` the GPU/power cases;
  `cloudflare/test/ingest.test.ts:55` the fixture corpus.
- `docs/protocol.md:65` power row, `:127` rate rules;
  `docs/architecture.md:128` rollup coverage; `README.md:90` macOS power,
  `:203` Power widget.
- `Makefile:27` `agent-test`, `:30` `agent-build`, `:33`
  `agent-build-macos`, `:109` `check`.
- Threadripper live evidence: `ssh josh@threadripper` on 2026-11-02, commands
  and outputs recorded in **Baseline**.
