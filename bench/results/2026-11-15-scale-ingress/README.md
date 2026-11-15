# Tailnet route for the tenfold fixture

The isolated 203,950-event fixture is reachable at
`https://stats-next.17166969.xyz/#/project/stats` through the existing Caddy
listener and fail-closed Tailscale identity adapter. This removes the transport
gap for the P6 browser rehearsal. Functional checks pass; no timing acceptance
is claimed by this record.

The fixture loads both Worker bundles and assets from the deployed
`stats:6cc06db247a3` image. Its underlying container remains the earlier pinned
runtime image. The Dockerfile and complete OpenOrange dependency manifests are
identical between those images. [reads.json](reads.json) records the actual
compiled-source SHA-256 values. All four complete response digests still equal
the preserved baseline, including the full 203,950-event corpus.

[browser.json](browser.json) records real 1h, 6h and 24h selections. A client-only
clock is frozen at the corpus anchor; performance clocks remain real. Each
selection uses an uncached summary, commits three charts, and matches visible
counts and windows with the actual response. A subsequent screenshot inspection
confirms the charts render populated data. The six-day native read is not a
seven-day browser acceptance result. Concurrent ingestion and ten browser
clients remain unverified.

[container.json](container.json) identifies the dedicated internal
`stats-perf-ingress` bridge, no published ports, a read-only root filesystem,
two aggregate CPUs and 3 GiB memory. The same private Engine process remains
running, with its API on loopback. [access.json](access.json) verifies:

- Connections from the fixture to the production Engine and Internet fail with
  `ENETUNREACH`.
- Direct data requests without gateway credentials return HTTP 401; an identity
  header alone also returns 401, matching the application's auth contract.
- The public ingress rejects the fixture hostname with HTTP 404.
- All 45 served asset files omit the fixture gateway and ingestion credentials.

Shared configuration belongs to Stuff: commit `90295eb` adds the declarative
overlay and a route-generation regression. The regression and four existing
Rivet integration tests pass. The host overlay was validated before a graceful
Caddy reload. Production Stats retains image `6cc06db247a3`, node version 24,
and its original canonical hostname, namespace and upstream. The other
application hostnames remain present.

Keep this fixture and its network while the browser/ingest rehearsal uses them.
Restore the original hostname mapping before retiring the fixture, following
the [shared-stack instructions](https://github.com/laputa-systems/stuff/blob/feat/stats-runtime-hardening/docs/openorange-runtime.md#stats-scale-fixture-ingress).
The separately running production resource sampler remains live and must not be
included in fixture cleanup.
