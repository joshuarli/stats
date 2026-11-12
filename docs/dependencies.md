# Dependencies and toolchain

Pins: Rust `nightly-2026-09-15` (`rust-toolchain.toml`), Node from `.node-version`, pnpm 12.18.0 (both enforced by `make node-ready`), and the laputa-systems LLVM musl toolchain `llvm-musl-23.1.5-c4f9b08` plus an Alpine 3.23 image, rustup 1.29.3 and the pinned Rust inside it (all pinned in `agent/scripts/build-static.sh` and `agent/build/Dockerfile`). Every npm dependency is pinned exactly in `cloudflare/package.json`. Build and deploy use `cloudflare.config.ts`, `vite.config.ts`, and `cf`; the project declares no Wrangler dependency and never runs the Wrangler CLI.

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
workspace dependencies installed. The Vite SSR build currently leaves this
package external, while the image copies only the emitted bundle and assets:
the staged artifact fails with `ERR_MODULE_NOT_FOUND` (STA-116 in
[TODO](../TODO.md)). The image version and digest live in
`deploy/node/Dockerfile`. A new dependency needs a written reason, including
build-time and image-size effects.

## Build tools

The Worker/dashboard build uses Vite and `cf deploy --prebuilt` uploads its
Build Output. The CLI and Node server also use Vite SSR builds, configured by
`cloudflare/vite.statsctl.config.ts` and `cloudflare/vite.node.config.ts`.
esbuild is no longer a direct dependency; the test plugin and its Wrangler
dependency still bring it in. Stats does not invoke the Wrangler CLI or ship
esbuild as a runtime dependency.

Keep the test plugin. Removing its esbuild closure would also require replacing
its Wrangler configuration/Miniflare integration, with ongoing ownership of
upstream runtime changes.

## Platform binaries in lockfiles

Lockfiles keep every optional platform package. Neither
`npm install --package-lock-only --omit=optional` nor pnpm 11's
`supportedArchitectures` removes foreign entries; both managers filter what
they install, not what they resolve. Hand-pruning the lockfile is regenerated
by the next install and breaks frozen installs elsewhere. Leave it.

## Miniflare as a direct dev dependency

`cloudflare/test/observe-e2e/` runs the built `stats` and `stats-observe`
bundles together in workerd with a tail consumer attached, which the vitest
pool cannot do. The direct pin and the test plugin's transitive pin differ;
`cloudflare/package.json` and `pnpm-lock.yaml` record the exact versions and
consumers. None ships with the application. Check the local-stack and plugin
consumers together when changing these pins.

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

## Alchemy for deployment (declined 2026-11-07)

Stats stays on `cf` and `cloudflare.config.ts` rather than adopting Alchemy as
infrastructure as code. The config is already typed and declarative: the
SQLite `Installation` Durable Object, every binding, the crons and the tail
consumer. The only orchestration is deploying `stats-observe` before `stats`
and reading the new version ID for source-map upload.

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
