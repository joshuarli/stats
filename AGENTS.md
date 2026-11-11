# Stats

A Linux/macOS host agent (`agent/`), a shared telemetry core and Solid dashboard
(`cloudflare/`), Cloudflare and Node adapters, application producers
(`packages/`), an optional bpftrace collector (`bpf/`), and deploy scripts
(`deploy/`). Use the topic docs below for contracts and operational details.

## Commands

```sh
make fixtures          # cross-language corpus, size budgets, byte/row accounting
make fixtures-write    # regenerate only after a deliberate protocol change
make agent-test        # Rust unit tests and fixture parity
make agent-build       # static Linux binaries and ELF checks
make cloudflare-test   # typecheck, Workers runtime and Node suites
make dashboard-test    # production build and Playwright
make preview           # captured fixtures, frozen clock
make lint              # type-aware Oxlint
make check             # release gate; offline network sandbox is macOS-only
make stats-deploy      # deploy stats; observation receiver must already be compatible
pnpm --dir cloudflare -s statsctl help workflow
pnpm --dir cloudflare -s statsctl health --project stats --json
pnpm --dir cloudflare -s statsctl verify --service NAME --deployment DEPLOYMENT_ID --policy POLICY.json --json
```

See [testing](docs/testing.md) for e2e, local-stack and producer checks, and
[operations](docs/operations.md) for deployment and CLI recipes. `make node-ready`
enforces Node/pnpm pins. Scratch and `TMPDIR` belong under `.work/tmp`.

## Invariants

- Host ingest is STB2 with STA2 acknowledgments, no JSON fallback or negotiation. `fixtures/v2/` is the cross-language oracle; malformed frames are rejected whole. See [protocol](docs/protocol.md).
- u64 values stay exact: varints, Rust `u64`, TypeScript `bigint` until a checked bound. Fixed-point values do not pass through floats. Counter deltas use only the previous sample in the same frame; rates use `monoMs` within one boot.
- Stored samples retain canonical JSON; duplicate identity compares that text, not wire bytes. Missing data stays absent/unavailable, and counter regressions are gaps, never negative rates.
- Tokens never enter argv, logs, telemetry responses or built assets. Provisioning returns a new token once; storage keeps only its SHA-256 verifier.
- Every non-ingest, non-health asset/data route passes the target's auth adapter before data access: Access JWT verification on Cloudflare, Tailscale identity over trusted local transport on Node. See [architecture](docs/architecture.md).
- Analytics reads use only `cloudflare/src/projects/queries.ts`; request data never reaches SQL. `statsctl` read commands do not mutate; command definitions declare mutation access and supported targets.
- Dashboard goldens are WebP. `make dashboard-test` rejects tracked PNGs.
- The baseline agent never loads BPF and needs no root, service manager or language runtime. Linux binaries link no dynamic libraries; macOS binaries link only system libraries/frameworks.

## Docs

| Topic | Doc |
| --- | --- |
| Agent installation, configuration and dashboard use | [README](README.md) |
| Host wire format, validation and rate semantics | [Protocol](docs/protocol.md) |
| Binary ingest and history rationale, measurements and limits | [Ingest](docs/binary-ingest.md), [history](docs/binary-history.md) |
| Components, routes, auth, storage, rollups and frontend constraints | [Architecture](docs/architecture.md) |
| Builds, deployments, CLI contract and cost reports | [Operations](docs/operations.md) |
| Toolchain pins and dependency decisions | [Dependencies](docs/dependencies.md) |
| Service/application integration and producers | [Contract](docs/integration.md), [TypeScript](packages/producer/README.md), [Rust](packages/stats-producer/README.md) |
| Deployment tracking and comparison | [Deployments](docs/deployments.md) |
| Tests and screenshot verification | [Testing](docs/testing.md) |
| Benchmarks and frontend measurement record | [Benchmarks](bench/README.md), [frontend](docs/frontend-efficiency.md) |
| Tracing and profiling | [Tracing](docs/TRACING.md), [profiling](docs/profiling.md) |
| Optional block latency | [bpf](bpf/README.md) |
| Observability design and costs | [Observe](docs/observe.md), [billing](docs/observe-billing.md) |
| Open work and planned Linux power collection | [TODO](TODO.md), [power plan](docs/CAMPAIGN-LINUX-POWER.md) |
