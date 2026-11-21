# Stats

A Linux/macOS host agent and Solid telemetry dashboard. Production runs on
OpenOrange; `cloudflare/` also contains the portable core and reference adapters.

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
make check             # release gate; offline sandbox requires macOS or Linux namespaces
make stats-deploy      # deploy stats; observation receiver must already be compatible
pnpm --dir cloudflare -s statsctl help workflow
pnpm --dir cloudflare -s statsctl service inspect --service stats --json
pnpm --dir cloudflare -s statsctl services usage --window 1h   # services by host, hottest first
pnpm --dir cloudflare -s statsctl verify --service NAME --deployment DEPLOYMENT_ID --policy POLICY.json --json
```

See [testing](docs/testing.md) for e2e, local-stack and producer checks, and
[operations](docs/operations.md) for deployment and CLI recipes. `make node-ready`
enforces Node/pnpm pins. Scratch and `TMPDIR` belong under `.work/tmp`.
Which suite covers each subsystem: [testing](docs/testing.md#where-each-subsystem-is-tested).

## Invariants

- Ingest is STB2/STA2 without negotiation; `fixtures/v2/` is the cross-language oracle and malformed frames are rejected whole.
- Keep u64 and fixed-point values exact; frame-local deltas and same-boot `monoMs` define rates.
- Duplicate identity compares canonical stored JSON; absent data and counter regressions remain gaps.
- Tokens never enter argv, logs, telemetry responses or assets; storage keeps SHA-256 verifiers.
- Authenticate every non-ingest, non-health data or asset route before access; there is no login allowlist.
- Only fixed project queries reach Analytics SQL; CLI definitions declare mutation access and target capabilities.
- Dashboard goldens are WebP. `make dashboard-test` rejects tracked PNGs.
- Default builds need no root or runtime and never load BPF; release probes use only the shipped capabilities and omit failed sources.
- Linux binaries link no dynamic libraries; macOS links only system libraries and frameworks.

## Docs

| Topic | Doc |
| --- | --- |
| Agent installation, configuration and dashboard use | [README](README.md) |
| OpenOrange deployment, backup/restore, cutover record and rollback | [OpenOrange](docs/openorange.md) |
| Lisa recovery and native deployment | [Recovery](docs/lisa-operational-recovery.md), [native deployment](docs/native-lisa.md) |
| Runtime hardening and release rollback | [Runtime hardening](docs/runtime-hardening.md) |
| Host wire format, validation and rate semantics | [Protocol](docs/protocol.md) |
| Binary ingest and history rationale, measurements and limits | [Ingest](docs/binary-ingest.md), [history](docs/binary-history.md) |
| Components, routes, auth, storage, rollups and frontend constraints | [Architecture](docs/architecture.md) |
| Builds, deployments, CLI contract and cost reports | [Operations](docs/operations.md) |
| Toolchain pins and dependency decisions | [Dependencies](docs/dependencies.md) |
| Service/application integration and producers | [Contract](docs/integration.md), [TypeScript](packages/producer/README.md), [Rust](packages/stats-producer/README.md) |
| Native runtime spans, sampling and platform delivery | [Platform observations](docs/platform-observability.md) |
| Deployment tracking and comparison | [Deployments](docs/deployments.md) |
| Tests and screenshot verification | [Testing](docs/testing.md) |
| Local development and build ownership | [Development](docs/development.md) |
| Benchmarks and frontend measurement record | [Benchmarks](bench/README.md), [frontend](docs/frontend-efficiency.md) |
| Performance acceptance and remaining work | [Performance campaign](docs/CAMPAIGN-STATS-PERFORMANCE.md), [resumption](docs/STATS-PERFORMANCE-RESUMPTION.md) |
| Tracing and profiling | [Tracing](docs/TRACING.md), [profiling](docs/profiling.md) |
| Optional block latency | [README: agent config](README.md) |
| Observability design and costs | [Observe](docs/observe.md), [billing](docs/observe-billing.md) |
| Infrastructure release campaign: owned runtime builds, canaries, promotion | [Campaign](docs/CAMPAIGN-INFRA-RELEASE.md) |
| Active simplification and self-optimization sequence | [Campaign](docs/CAMPAIGN-SIMPLIFICATION.md) |
| Open work, including Linux power | [TODO](TODO.md) |
