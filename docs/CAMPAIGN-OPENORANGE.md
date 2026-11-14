# Campaign: Stats and Stuff on self-hosted OpenOrange

Owner decision (2026-11-13): Stats and Stuff run on OpenOrange on the owner's
Tailscale machines. `https://stats.17166969.xyz` and every Stuff registry
hostname stay. Cloudflare remains only the DNS provider, with DNS-only
records. This supersedes the evaluate-only framing of the Rivet/OpenOrange
evaluation (`9f1b43c`, `docs/rivet-openorange-evaluation.md` at that
revision), whose evidence is reused below.

## Status

Accepted: S2 (`d56da0c8`, tailnet gateway identity), S7 (stuff `6db7ed3`,
shared stack on `lisa`), S1 (`f0667539`, descriptors and `make orange-pilot`),
S4 (`7e4ac3dd`, fenced export/import, `make orange-test` restores into a fresh
namespace). Staging: image `stats:9ec6d1e7d059` (Node 26.13.1 Debian, pinned
digest) runs both Workers in namespace `stats` on `lisa` behind the ingress
(internal CA); verified with `--resolve` from the Mac: identity, forged-header
401, STB2 ingest with acks and duplicate replay, history, persistence across
an app restart. The staging namespace now holds a probe host, so the cutover
import targets a fresh namespace. Next: S5/S6, then the Cloudflare-side export
build for S10. Production has not moved.

## Inventory (source revisions: stats `1124d0e7`, stuff `25e4fd0`)

| Item | Current | Target |
| --- | --- | --- |
| Stats Worker `stats` | `Installation` DO (one, `idFromName("installation")`), assets, `ANALYTICS_SQL`, `OBSERVE` service binding, cron `*/5`, tail consumer `stats-observe`, Access JWT | Same DO on Orange; tailnet gateway identity; no Analytics SQL; application events instead of tails |
| Observe Worker `stats-observe` | `ObservationStore` DO per service (`getByName(service)`), cron `17 * * * *`, tail handler | Same DO on Orange; scheduling persisted in the object (alarms) |
| Stuff Worker `stuff` | TS host + Rust WASM, six R2 buckets, `caches.default`, `cf.cacheKey` | Orange Worker or native server over shared S3 store; per-registry publication coordinator |
| Hosts | `lisa` 100.68.104.43 (Alpine 3.25 musl x86_64, OpenRC, Docker, 242 GB free), `threadripper` (same OS, 94% disk) | Runtime and ingress on `lisa` |
| Tansu | Native Rust server on `lisa` (OpenRC, 127.0.0.1:3001), public through cloudflared tunnel `tansu-tunnel` at `tansu.17166969.xyz`, passkeys | Same binary and vault behind the shared tailnet ingress; tunnel retired; owner ruling 2026-11-13: tailnet-only, not an OpenOrange app |
| Discover (`../discover`) | Worker `discover`/`discover-preview` with `ResearchSpace` DO, R2 `discover-artifacts`/`discover-preview-artifacts`, daily cron, tail to `stats-observe`; public reader `hq.`, public bearer MCP `research.`, `/admin` behind Access; renditions made locally with ffmpeg | Same Worker and DO on Orange; owner ruling 2026-11-13: reader and `/mcp` public through an outbound-only Cloudflare Tunnel into the shared Caddy, `/admin` only on the tailnet ingress with gateway identity (404 through the tunnel); WebP conversion runs in the Worker without workerd limits |
| External Cloudflare producers | `usr-memories`, `nanoshop-storied`, `discover`, `discover-preview` (Analytics SQL + tails) | Optional isolated provider adapter or retired; reported at close |
| Credentials | Access team/aud, host/service/deployment tokens (SHA-256 verifiers), CF deployments token, R2 keys | Tailnet identity; scoped tokens kept; S3 keys per app bucket set |

Stuff work integrates in the development clone `~/d/stuff`; `~/repos/stuff` is repomod's canonical checkout.

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
| S11 | tansu | `tansu.17166969.xyz` served by the shared ingress; tunnel retired | passkey login and `/api/v2/health` through the ingress |
| S12 | stuff (`~/d/stuff`) | Fleet standards: `openorange` tag, stats/stuff retagged, runtime compatibility group names OpenOrange/Rivet, inventory adapter reads Orange descriptors; Cloudflare kept for remaining Cloudflare projects | `make repomod-test` |
| S13 | discover | Discover on Orange with the public/tailnet split; WebP renditions in the Worker through the static musl `rimage` binary (owner ruling 2026-11-13; `../rimage`), spawned per image over stdin/stdout at the current contract (WebP q85, metadata stripped, 2400/960 caps), with `../rimage` fixes made there as integration needs them; probe that the pinned runtime permits `node:child_process` first | discover's `make check` + split-ingress rehearsal |
| S10 | all | Cutover: fence, final export/import, DNS, verification, rollback plan | runbook rehearsal |

## Needs environment / owner

- A Cloudflare API token limited to DNS edit on `17166969.xyz`, saved on
  `lisa` as `/etc/openorange/cloudflare-dns.env`, for ACME DNS-01 and records.
- The Discover tunnel (cloudflared on `lisa` to `127.0.0.1:18480`) and split
  DNS so tailnet clients reach Discover hostnames on the tailnet address.
- Tailnet policy grants for tagged machines, and one tagged device to prove it.
- An off-disk backup destination for `bin/backup --dest`; today every copy
  lives on `lisa`'s single NVMe.
