# Stats

A static-musl Linux host agent (`agent/`), a Cloudflare Worker with one
SQLite-backed Durable Object and a Solid dashboard (`cloudflare/`), the shared
wire fixtures (`fixtures/v1/`), an optional bpftrace block-latency collector
(`bpf/`), and deploy scripts (`deploy/`).

## Commands

```sh
make fixtures          # fixture manifest, shapes, and cost arithmetic
make agent-test        # agent unit and fixture-parity tests
make agent-build       # static x86_64 and aarch64 binaries + ELF checks
make cloudflare-test   # typecheck + Workers runtime tests
make dashboard-test    # vite build + Playwright
make preview           # build and serve the dashboard from captured fixtures
make lint              # type-aware Oxlint
make check             # all of the above plus make release
```

Node and pnpm versions are enforced by `make node-ready`. Scratch and `TMPDIR`
go under `.work/tmp`.

## Invariants

- The wire format is protocol v1 in `docs/protocol.md`; `fixtures/v1/manifest.json` is the accept/reject oracle both the agent and the Worker tests run.
- Unknown fields are rejected in every ingest request; the agent accepts additive fields in the ingest response. u64 counters and timing values are decimal strings.
- Missing data is absent or `unavailable`, never zero; counter regressions are gaps, never negative rates.
- Rates come from `monoMs` deltas within one boot, never from wall-clock deltas.
- Tokens never appear in argv, logs, telemetry responses, or built assets; the provisioning response returns a new token once, and the server stores only a SHA-256 verifier.
- Every non-ingest, non-health path that serves assets or data passes Access JWT verification in the Worker; other paths are rejected before any data is read.
- Analytics reads use only the fixed queries in `cloudflare/src/projects/queries.ts`; no request data reaches SQL.
- Dashboard screenshots are WebP; no PNGs are tracked, and `make dashboard-test` rejects them.
- The baseline agent never loads BPF, needs no root, service manager, or runtime, and links no dynamic libraries.

## Docs

| Topic | Doc |
| --- | --- |
| Install, configure, and run the agent | `README.md` |
| Wire protocol, validation, rate semantics | `docs/protocol.md` |
| Components, routes, auth, storage, rollups | `docs/architecture.md` |
| Release build, deployment, verified environments | `docs/operations.md` |
| Toolchain pins and dependency decisions | `docs/dependencies.md` |
| Benchmark method and results | `bench/README.md` |
| Tracing and profiling approach, and why no APM SDK | `docs/TRACING.md` |
| Optional block-latency probe | `bpf/README.md` |
| Cost campaign plan and loop | `docs/cost-campaign.md` |
| Open work | `TODO.md` |
