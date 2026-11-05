# Stats

A host agent (`agent/`), static musl on Linux and a native binary on macOS, a Cloudflare Worker with one
SQLite-backed Durable Object and a Solid dashboard (`cloudflare/`), the same core served by a Node server (`cloudflare/src/node/`), the shared
ingest conformance corpus (`fixtures/v2/`), an optional bpftrace block-latency collector
(`bpf/`), and deploy scripts (`deploy/`).

## Commands

```sh
make fixtures          # corpus manifest, size budgets, and byte/row accounting
make fixtures-write    # regenerate sources, golden frames, and acks after a deliberate change
make agent-test        # agent unit and fixture-parity tests
make agent-build       # static x86_64 and aarch64 binaries + ELF checks
make cloudflare-test   # typecheck + Workers runtime tests
make dashboard-test    # vite build + Playwright
make preview           # build and serve the dashboard from captured fixtures
make lint              # type-aware Oxlint
make agent-e2e         # the real agent binary against the built Worker in workerd
make node-e2e          # the smoke and the real agent binary against the Node server
make smoke-local       # deploy/deployed-smoke.sh against the built Worker in workerd
make ingest-bench      # encoder, decoder, and end-to-end ingest measurements
make check             # all of the above plus make release
make stats-deploy      # deploy only the stats Worker, leaving stats-observe untouched

pnpm --dir cloudflare -s statsctl help workflow    # copy-pastable recipes for the commands below
pnpm --dir cloudflare -s statsctl health --project stats --json    # are the telemetry sources fresh and complete
pnpm --dir cloudflare -s statsctl cost --project stats --window 1h --json    # price a window, find the bottleneck
pnpm --dir cloudflare -s statsctl verify --project stats --deployment DEPLOYMENT_ID --policy POLICY.json --json    # did a deployment use fewer resources for the same work
```

`statsctl` reads the production origin through Access; `statsctl help workflow` and
`statsctl help verify` are the source of truth for its recipes and policy fields.
Node and pnpm versions are enforced by `make node-ready`. Scratch and `TMPDIR`
go under `.work/tmp`.

## Invariants

- Host ingest is binary protocol v2 (STB2 requests, STA2 acknowledgments) in `docs/protocol.md`, with no JSON ingest, fallback, or negotiation. `fixtures/v2/` is the cross-language oracle: Rust-encoded golden frames must decode to their sources in the Worker, Worker-encoded acknowledgments must decode in the agent, and every malformed frame must be rejected whole with its code.
- Every u64 is exact end to end: varints on the wire, `u64` in Rust, `bigint` in TypeScript until a checked bound; fixed-point values never pass through floats. Counter deltas reference only the previous sample in the same frame.
- Stored samples stay the canonical JSON the v1 protocol stored; duplicates compare that text, never wire bytes.
- Missing data is absent or `unavailable`, never zero; counter regressions are gaps, never negative rates.
- Rates come from `monoMs` deltas within one boot, never from wall-clock deltas.
- Tokens never appear in argv, logs, telemetry responses, or built assets; the provisioning response returns a new token once, and the server stores only a SHA-256 verifier.
- Every non-ingest, non-health path that serves assets or data passes the target's auth adapter: Access JWT verification on Cloudflare, Tailscale identity from loopback on Node. A request that fails it is rejected before any data is read.
- Analytics reads use only the fixed queries in `cloudflare/src/projects/queries.ts`; no request data reaches SQL.
- Dashboard screenshots are WebP; no PNGs are tracked, and `make dashboard-test` rejects them.
- `statsctl` read commands never mutate. `check ingest` and `deploy mark` are the only mutations: `check ingest` writes one flagged sample only to the `synthetic-check` host, and `deploy mark` writes one deployment marker for the named service.
- The baseline agent never loads BPF and needs no root, service manager, or runtime. On Linux it links no dynamic libraries; on macOS it links only system libraries and frameworks.

## Docs

| Topic | Doc |
| --- | --- |
| Install, configure, and run the agent | `README.md` |
| Wire protocol, validation, rate semantics | `docs/protocol.md` |
| Binary ingest rationale, measurements, limits | `docs/binary-ingest.md` |
| Components, routes, auth, storage, rollups | `docs/architecture.md` |
| Release build, deployment, verified environments | `docs/operations.md` |
| Toolchain pins and dependency decisions | `docs/dependencies.md` |
| Deployment tracking, comparison, and its verification record | `docs/deployments.md` |
| Test commands, screenshot goldens, and image comparison | `docs/testing.md` |
| Benchmark method and results | `bench/README.md` |
| Tracing and profiling approach, and why no APM SDK | `docs/TRACING.md` |
| Optional block-latency probe | `bpf/README.md` |
| Cost campaign plan and loop | `docs/cost-campaign.md` |
| Portable core: stats on Node with Cloudflare as an adapter | `docs/portable-core-campaign.md` |
| Service deployments: deployment tracking for servers | `docs/service-deployments-campaign.md` |
| Observability product campaign | `docs/observability-campaign.md` |
| What observation costs per invocation, with sources | `docs/observe-billing.md` |
| `statsctl`, measurement, and the measured-optimization campaign | `self-improvement.md` |
| Open work | `TODO.md` |
