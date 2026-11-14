# Campaign: Stats and Stuff on self-hosted OpenOrange

Owner decision (2026-11-13): Stats and Stuff run on OpenOrange on the owner's
Tailscale machines. `https://stats.17166969.xyz` and every Stuff registry
hostname stay. Cloudflare remains only the DNS provider, with DNS-only
records. This supersedes the evaluate-only framing of the Rivet/OpenOrange
evaluation (`9f1b43c`, `docs/rivet-openorange-evaluation.md` at that
revision), whose evidence is reused below.

## Status

Inventory complete; slices S1–S3 in progress. Production has not moved.

## Inventory (source revisions: stats `1124d0e7`, stuff `25e4fd0`)

| Item | Current | Target |
| --- | --- | --- |
| Stats Worker `stats` | `Installation` DO (one, `idFromName("installation")`), assets, `ANALYTICS_SQL`, `OBSERVE` service binding, cron `*/5`, tail consumer `stats-observe`, Access JWT | Same DO on Orange; tailnet gateway identity; no Analytics SQL; application events instead of tails |
| Observe Worker `stats-observe` | `ObservationStore` DO per service (`getByName(service)`), cron `17 * * * *`, tail handler | Same DO on Orange; scheduling persisted in the object (alarms) |
| Stuff Worker `stuff` | TS host + Rust WASM, six R2 buckets, `caches.default`, `cf.cacheKey` | Orange Worker or native server over shared S3 store; per-registry publication coordinator |
| Hosts | `lisa` 100.68.104.43 (Alpine 3.25 musl x86_64, OpenRC, Docker, 242 GB free), `threadripper` (same OS, 94% disk) | Runtime and ingress on `lisa` |
| External Cloudflare producers | `usr-memories`, `nanoshop-storied`, `discover`, `discover-preview` (Analytics SQL + tails) | Optional isolated provider adapter or retired; reported at close |
| Credentials | Access team/aud, host/service/deployment tokens (SHA-256 verifiers), CF deployments token, R2 keys | Tailnet identity; scoped tokens kept; S3 keys per app bucket set |

## Architecture rulings

- Shared host stack lives in `stuff/deploy/openorange/`: Rivet Engine,
  S3-compatible store, Caddy ingress, tailnet identity sidecar, OpenRC
  units. Each app owns its image and config in its own repo and gets its
  own Rivet namespace, runner pool, bucket set and credentials.
- Ingress binds only the Tailscale address; Engine, store admin and app
  listeners stay on a private Docker network with no published ports.
- Identity: Caddy strips client `Tailscale-*`/identity headers, asks the
  sidecar to `whois` the peer address through tailscaled's LocalAPI, and
  forwards the resolved user or node tags with a gateway secret. Any device
  the tailnet policy lets reach the ingress is admitted; there is no email
  allowlist.
- TLS: ACME DNS-01 for the exact hostnames through a zone-scoped DNS token.
- Durable state stays in the existing DO classes; the application export
  is the recovery contract, independent of Engine internals.

## Slices

| ID | Repo | Outcome | Acceptance |
| --- | --- | --- | --- |
| S1 | stats | Orange descriptors generated from the typed `cf/config`, unmapped fields rejected | generator unit test + `orange dev` pilot |
| S2 | stats | `statsctl` resolves `stats.17166969.xyz` to the tailnet target; no `cf access token` | `test/cli` |
| S3 | stats | Gateway-identity auth adapter on the Worker entry; Access removed from the default path | auth tests incl. forged headers |
| S4 | stats | Versioned application export/import with manifests, resume and rejection | export/import tests on Node and Orange |
| S5 | stats | Caught-error diagnostics with stacks via a versioned application-event extension | observe tests |
| S6 | stats | `make dev` runs Orange locally, offline | dev-loop harness |
| S7 | stuff | Shared stack: Engine, S3 store, ingress, identity, TLS, backups, OpenRC | rehearsal on `lisa` with local DNS override |
| S8 | stuff | Registries served from S3 with a publication coordinator | conformance suites + real clients |
| S9 | stuff | Resumable R2 → S3 copy and verification | rehearsal on copied data |
| S10 | both | Cutover: fence, final export/import, DNS, verification, rollback plan | runbook rehearsal |

## Needs environment / owner

- A Cloudflare API token limited to DNS edit on `17166969.xyz` for ACME
  DNS-01 and the record change.
- Tailnet policy grants for tagged machines that must reach the ingress.
