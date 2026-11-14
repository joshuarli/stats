# Dependencies and toolchain

Pins: Rust `nightly-2026-09-15` (`rust-toolchain.toml`), Node from `.node-version`, pnpm from `package.json` (both enforced by `make node-ready`), and the laputa-systems LLVM musl toolchain `llvm-musl-23.1.5-c4f9b08` plus an Alpine 3.23 image, rustup 1.29.3 and the pinned Rust inside it (all pinned in `agent/scripts/build-static.sh` and `agent/build/Dockerfile`). Every npm dependency is pinned exactly in `cloudflare/package.json`. Builds use `cloudflare.config.ts`, `vite.config.ts`, and `cf`.
OpenOrange descriptors derive from that typed build output. Deployment uses
`deploy/orange/build-image.sh` and the shared host stack. The project declares
no Wrangler dependency and never runs the Wrangler CLI.

## Agent crates

The agent uses `deser` 0.10.2 and `deser-json` for its JSON config, the
block-latency snapshot, and `--once` output (`deser-value` is now a test-only
dev-dependency), and `h12tiny-client-sync` 0.9.0 with its `tls` feature for
HTTPS, replacing
`serde`, `serde_json`, `ureq`, `rustls` with `ring`, and `rustls-native-certs`.
TLS runs on Graviola through `h12tiny-tls-system`. The direct client comes
from the `mycrates` registry configured in `agent/.cargo/config.toml`.
`rustc-hash` 2 provides the hash collections of `agent/src/parse.rs`, because
the fleet bans `BTreeMap` and `BTreeSet`. The two parsers whose order is
observable, `parse_diskstats` and `parse_mounts`, sort their `Vec` by the key
the map used to order, so output order is unchanged.
The binary ingest codec (`agent/src/wire.rs`, `cloudflare/src/ingest/`) is
written by hand against `docs/protocol.md` and adds no dependency on either
side: no serialization framework, schema compiler, WASM, or compression
library.

The normalize and TLS packages resolve through the crates.io mirror; all three
are locked at 0.9.0 in `agent/Cargo.lock`. Check the exact transitive closure in
both registries when upgrading; changing the direct dependency's registry does
not change those transitive sources.

The client bounds the request write and response-header read with the request
timeout; the agent bounds the body read to the remainder of the same deadline.
Connection setup is bounded separately by the same duration.

## Node server

The Node adapter uses `node:http`, `node:sqlite`, `node:zlib` and timers, with
`--experimental-strip-types` under the pinned Node. Its observation service
also imports `@jridgewell/trace-mapping` at runtime. Source runs need the
workspace dependencies installed. The Vite SSR build bundles runtime packages,
including this resolver, while leaving Node built-ins external. The packaging
regression test stages only the bundle and assets and denies workspace reads.
The digest-pinned image also passed a dependency-free startup check for STA-116.
The image version and digest live in
`deploy/node/Dockerfile`. A new dependency needs a written reason, including
build-time and image-size effects.

## Build tools

The Worker/dashboard build uses Vite. `deploy/orange/generate.mts` maps its
Build Output into OpenOrange descriptors and rejects unsupported fields.
The CLI and Node server also use Vite SSR builds, configured by
`cloudflare/vite.statsctl.config.ts` and `cloudflare/vite.node.config.ts`.
esbuild is no longer a direct dependency; the test plugin and its Wrangler
dependency still bring it in. Stats does not invoke the Wrangler CLI or ship
esbuild as a runtime dependency.

Keep the test plugin. Removing its esbuild closure would also require replacing
its Wrangler configuration/Miniflare integration, with ongoing ownership of
upstream runtime changes.

Package scripts select `/bin/sh` explicitly. In the observed host configuration,
pnpm's default user shell resets `PATH` and runs Node 26.13.0 despite the caller
selecting 26.13.1. The explicit shell preserves the caller's toolchain and local
package binaries. A regression runs package scripts with a hostile host shell.
Remove this setting only after pnpm preserves the selected runtime with that
shell. `.node-version` pins the exact Node patch; `make node-ready` and the
build/test entrypoints enforce it. The doctor reports the pin from `.node-version`.
Stuff owns the shared pins in `fleet/policy/typescript-tools.toml` and
`fleet/policy/frontend-toolchain.toml`. Oxlint loads type-aware linting from
`tsrs-lint` in the same `tsrs` package; there is no direct `oxlint-tsgolint` dependency.

## Platform binaries in lockfiles

Lockfiles keep every optional platform package. Neither
`npm install --package-lock-only --omit=optional` nor pnpm 11's
`supportedArchitectures` removes foreign entries; both managers filter what
they install, not what they resolve. Hand-pruning the lockfile is regenerated
by the next install and breaks frozen installs elsewhere. Leave it.

## Miniflare as a direct dev dependency

`cloudflare/test/observe-e2e/` runs the built `stats` and `stats-observe`
bundles together in workerd with a tail consumer attached, which the vitest
pool cannot do. On November 12, the compatible group is `cf` 1.0.0-beta.31,
Vite plugin 2.0.0-beta.v.16, Vitest plugin 1.8.1, and Miniflare
5.20261110.2-beta. Every consumer resolves that Miniflare and workerd
1.20261110.1. No override forces the independent workerd release ahead of the
SDK group. Workers types, Vite, Vitest, Node, pnpm, compatibility dates and
flags stay pinned. The packages retain their existing MIT or MIT/Apache licenses.
No new dependency is introduced.

`node cloudflare/scripts/dev-doctor.ts --check` reports actual paths, runtime
versions, configured dates and the supported date reported by the Vite plugin's
workerd helper. It rejects a split graph or unsupported configured date.
The v2 beta channel is selected explicitly. The stable v1 tag is a separate line.
The package-manager release-age floor and build-script policy remain in force.
pnpm records exact-version release-age exceptions for the four approved beta
packages and their coupled `runtime-types` 0.1.27 and Wrangler 4.161.0 releases.
No global release-age exclusion is added.

Miniflare separates ordinary `tailConsumers` from streaming consumers in this
release. Producer exports use ordinary `{ worker }` entries. Real tail delivery
and persistent producer state are checked by the launcher tests. Vite's removed
Worker `.vite/manifest.json` is not the Build Output `worker.config.json`
manifest used by the topology. The latter remains required and validated.

## Source-map resolver in `stats-observe`

`@jridgewell/trace-mapping` 0.3.31 resolves caught-error frames to original
files and lines in `cloudflare/src/observe/core/symbolicate.ts`. It is MIT,
pure JavaScript with two small dependencies (`@jridgewell/sourcemap-codec`
and `@jridgewell/resolve-uri`), already in the tree through Vite, and the
resolver that Node and most JavaScript tooling use; a hand-written VLQ
decoder would be more code to own for no gain. Of the Cloudflare bundles, only
`stats-observe` includes it: measured on 2026-11-04 it grew that Worker from
14.8 to 20.5 KB gzipped. The Node observation service imports it directly at
runtime; the `stats` Worker and dashboard do not include it.
`@jridgewell/sourcemap-codec` is a direct dev dependency at the same
version so tests can build small maps.

## OpenOrange runtime

The owner selected self-hosted OpenOrange on 2026-11-13. `make dev` uses
Orange locally. Production runs on Linux x86_64 on `lisa` behind the tailnet
gateway. Deployment and recovery commands are in [openorange.md](openorange.md).

`deploy/orange/package.json` and its lockfile isolate open-orange 1.0.2,
rivetkit 3.1.2-rc.1, and `@rivet-dev/services` 0.2.5. The application image
pins Node 26.13.1 Debian by digest. Rivet's services binary requires glibc,
so the application image uses Debian even though the host runs Alpine.
The shared Engine and object-store image pins belong to
`stuff/deploy/openorange/images.lock.json`.

The release-candidate runtime remains pinned. Application state stays in
`Installation` and per-service `ObservationStore` objects. A versioned logical
export restores into a fresh namespace independently of Engine directories.
`make orange-test` verifies restore, resumed import, duplicate/conflict
handling, persistent history, and caught-error diagnostics across restart.
OpenOrange's tail shim supplies neither real CPU measurements nor caught-error
stacks. Stats sends application events with portable diagnostics instead.

The earlier evaluation at `9f1b43c` (`docs/rivet-openorange-evaluation.md`)
proved 1,444 portable assertions and a reload soak on macOS ARM64. That
evaluation did not prove independent restore. Its rejection and performance
adoption gate were superseded by the owner decision and the implemented
logical recovery path. The historical evidence remains in Git.

## Alchemy for deployment (declined 2026-11-07)

Alchemy was declined for the former Cloudflare deployment. The typed
`cloudflare.config.ts` remains the build configuration; the OpenOrange
generator and shared host stack now own deployment. At the time of that
evaluation, `cf` declared the SQLite `Installation` object, bindings, crons,
and tail consumer. Deployment uploaded `stats-observe` before `stats` and
used the new version ID for source-map upload.

Alchemy would cost more than it saves here:

- It has no Analytics SQL query binding, only Analytics Engine writes, and the
  dashboard depends on `ANALYTICS_SQL: bindings.analytics()`.
- Adopting the existing Workers means trusting a beta tool's plan against the
  `Installation` namespace, which holds all host history. Its docs do not cover
  adopting Durable Object namespaces or deploying Vite's prebuilt Build Output.
- Its state store is one more thing to back up across beta migrations, and the
  bindings would be declared twice, since Vite and the Miniflare test stack read
  `cloudflare.config.ts`.
- Plans and drift detection pay off with many resources or deployers; Stats has
  two Workers, one operator and one deploy path, and `cf deploy --dry-run`
  already shows a plan.

Revisit if Alchemy ships an Analytics SQL binding and documented prebuilt
Build Output deploys, or if Stats needs resources `cf` cannot declare.

## Advisory and release audit (2026-11-13)

`cargo audit --json` against the SQLite advisory database reports zero
vulnerabilities and no unmaintained, unsound, or yanked crates in two lockfiles:
the agent (`agent/Cargo.lock`, 136 packages) and the stuff workspace
(`~/repos/stuff/Cargo.lock`). Direct dependencies of the agent were checked
against crates.io on 2026-11-13 and are all at their newest releases:
`libc` 0.2.191, `deser`/`deser-json`/`deser-value` 0.10.2, `rustc-hash` 2.1.3,
`aya` 0.16.0. `h12tiny-client-sync` 0.9.0 comes from the private `mycrates`
registry and was not checked against crates.io. No release sweep of every
transitive or every stuff dependency was performed; the most-used shared
direct dependencies in stuff (`deser-value`/`deser-json` 0.10, `tempfile`
3.13, `rustc-hash` 2.1.3, `sha2` 0.11) are at their current majors. No
upgrades were made; no advisory justifies churn, and the pinned Rust nightly
is unchanged. The commands and results are reproducible with `cargo audit` in
each workspace root.
