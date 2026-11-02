# Binary history experiment and integration handoff

Status: implemented and tested, **not wired into production**. No agent protocol,
Worker routes, SQL schema, history algorithms, dashboard fetches, dependency
manifests, retention policy, or deployment configuration are changed. This is
pre-integration work requested by the owner; the production cutover and deploy
are deliberately left to them.

Baseline inspected: `2a467d81500bf02c5e1cb919936d4c04db09735c`.

## What is implemented

- `cloudflare/src/binary/columns.ts`: a bounded, versioned numeric frame with
  `Float64Array`, `BigUint64Array`, and byte-column views, presence bitmaps and
  references to earlier columns. Identical timestamp axes can share storage.
- `cloudflare/src/binary/history.ts`: adapters for all five host history kinds,
  Cloudflare metric histories, collector histories and batched responses.
  Empty groups, missing optional fields, null versus zero, sparse/churning
  devices, non-monotonic wall time, reboot uptime and metadata are preserved.
- `cloudflare/test/binary/`: standalone Node tests, deterministic synthetic
  cases, golden byte vectors, rejection checks and mutation smoke tests. The
  test harness also discovers all history capture JSON files in the checkout.
- `cloudflare/scripts/bench-binary.mjs`: minified JSON, columnar-JSON and binary
  comparisons, including gzip, Brotli, encode time, validated-view open time,
  object reconstruction and optional retained-heap measurements.
- `cloudflare/test/binary/storage-candidate.ts`: **benchmark-only negative
  result**, not the proposed production store. It preserves decimal u64 strings
  exactly and supports legacy JSON TEXT reads, but its generic object decoder
  is slower than native JSON parsing. Keep it out of production imports.

There is no rkyv, WASM, code generator, third-party runtime dependency or lossy
Float32 conversion. The history adapter preserves existing binary64 values;
the primitive codec supports exact u64 values as bigint, never Number.

## Run

From the repository root, with the pinned Node toolchain:

```sh
node --experimental-strip-types --test cloudflare/test/binary/*.test.mjs
node --experimental-strip-types --expose-gc cloudflare/scripts/bench-binary.mjs > .work/tmp/binary-bench.json
# --quick uses 20 rather than 100 operations per round.
# Standalone typecheck, with the repository's installed compiler:
pnpm --dir cloudflare exec tsrs -p binary.tsconfig.json --noEmit --fast
```

`binary.tsconfig.json` inherits the repository's strict options but omits
unrelated Worker/Vite ambient types. Existing full checks remain required before
integration: `make cloudflare-test`, `make lint`, and `make dashboard-test`.
The Node tests remain a separate process from workerd Vitest, but are now
included in the regular `cloudflare` package test script and `make cloudflare-test`.
The regular typecheck also invokes `binary.tsconfig.json`, so these checks
cannot silently be skipped during a normal repository check. Use the commands
above for focused codec development.

## Measured results: 2026-11-02

Local Linux x86-64 container, AMD EPYC 9V74, Node **22.16.0**, five rounds of
100 operations after warm-up. These are not production, browser, workerd or
Cloudflare cost measurements. JSON parsing timings do not include the existing
API's schema decoding. Binary opening includes structural and history-schema
validation but does not reconstruct point objects.

A direct checkout/dependency install was unavailable in the execution container.
The inspected GitHub files supplied two complete capture fixtures and the full
raw-ingest fixture for local execution. All other large workloads below are
explicitly **synthetic**, not a claim about the deployed host's captured 1h or
24h responses. The harness discovers the remaining captures when run in the
complete repository.

37 standalone tests passed, including both available captures, synthetic host
and project histories and both full-ingest samples. Strict standalone TypeScript
checking passed with the container compiler. The pinned Node 26 / workerd /
Playwright suites were **not** run in this environment.

Table entries are JSON / binary. Sizes are bytes, and time is median microseconds.
Gzip is level 6; Brotli measurements in the JSON report use quality 5.

| Case | Uncompressed bytes | Gzip bytes | JSON parse / validated binary views, us |
| --- | ---: | ---: | ---: |
| `worker-1h.json` | 883 / 2,200 | 368 / 574 | 3.5 / 32.3 |
| `summary-7d.json` | 3,048 / 2,720 | 893 / 1,228 | 13.5 / 57.5 |
| `summary-240` | 79,788 / 52,880 | 5,464 / 3,412 | 416.9 / 94.5 |
| `host-bundle-240` | 265,283 / 119,392 | 18,606 / 7,685 | 1143.4 / 177.1 |
| `host-bundle-900` | 994,454 / 431,080 | 69,480 / 32,304 | 4171.1 / 417.1 |

The layout-only control matters. For the synthetic 900-point host bundle:

- Object JSON: 994,454 bytes; 69,480 gzip bytes; 4,171.1 us native parse.
- Columnar JSON: 32,128 gzip bytes; 1,581.2 us native parse, without schema validation.
- Binary: 431,080 bytes; 32,304 gzip bytes; 417.1 us validated views.

Most of the compression improvement comes from columnar layout. Binary is not
always smallest after compression: columnar JSON slightly wins gzip for that
bundle, and also wins Brotli for the synthetic summary cases. Binary's distinct
benefit is avoiding per-point object/number-array construction on the read path.

Encoding existing point objects is not free. The same 900-point bundle took
about 4.13 ms to stringify and 9.32 ms through the compatibility binary encoder.
Converting the binary back into point objects also loses its read advantage.
**Do not replace JSON.stringify/JSON.parse mechanically and call it a win.**
Build columns directly or cache encoded frames, and consume their views directly.

Small actual captures regress: `worker-1h.json` grows from 368 to 574 gzip bytes;
the 10-point `summary-7d.json` grows from 893 to 1,228 gzip bytes. Keep JSON for
small/control responses unless a runtime-specific benchmark establishes otherwise.

The generic storage candidate reduced the two full-ingest sample sizes from
1,685/1,532 to 1,459/1,223 bytes, but gzip got larger (643/625 to 811/774), and
object decode was about 5x slower (53.3/36.7 versus 11.0/6.9 us). That is a
negative result: **do not migrate `samples.payload`, `samples.delta` or
`rollups.payload` to this codec.** A read-optimized columnar projection/page is a
separate storage design to benchmark, not a proven drop-in BLOB optimization.

Retained heap is reported only with `--expose-gc`, with shared source inputs.
It excludes the input buffer/string and measures retained results, not allocation
traffic; small differences are noisy. No billed-cost or end-to-end zero-copy
claim follows from these measurements. FlatBuffers was not benchmarked.

## Numeric frame v1 (STC1)

All integers and payload values are little-endian. The header is 16 bytes:

| Offset | Width | Meaning |
| --- | --- | --- |
| 0 | 4 | ASCII `STC1` |
| 4 | 2 | Version, exactly 1 |
| 6 | 2 | Flags, exactly 0 |
| 8 | 4 | UTF-8 descriptor length |
| 12 | 4 | Entire frame length, including header and padding |

A bounded JSON descriptor follows: `{metadata,tables}`. Each table has
`{name,rows,columns}`. An owned column descriptor is `{name,type,nullable}`;
a referenced column is `{name,type,ref}`, where `ref` is a zero-based global
column index, strictly earlier than the referring column. Its type and row
count must match. References consume no payload and do count in global indexes.
The descriptor stores names once per column, not once per data point.

Pad to an eight-byte boundary with zeroes. Walk tables/columns in descriptor
order. For each owned nullable column, write `ceil(rows/8)` validity bytes,
least-significant bit first, then zero-pad to eight bytes. A set bit means
present. Write `rows` values (8 bytes for f64/u64, 1 for u8), then zero-pad
again. Missing value slots and unused bitmap bits must be zero. Nonnullable
columns omit the bitmap. References reuse earlier numeric and validity views.

Limits: 32 MiB frame, 1 MiB descriptor, 4,096 tables, 32,768 total columns,
16,384 rows per table, 512 UTF-16 code units per name. Unknown versions, flags,
fields/types, duplicate names, incompatible references, invalid sizes, nonzero
padding, non-finite floats and trailing bytes are rejected. Counts and bounds
are checked before payload views are created. Structural validation is not a
checksum: a bit flip that produces another valid number is not detectable.

`decodeColumns` returns `zeroCopy: true` only for an eight-byte-aligned buffer
on a little-endian machine. Unaligned input is copied once and big-endian native
hosts copy/convert numeric values; the result reports `false`. SharedArrayBuffer
is rejected. Keep the backing ArrayBuffer alive and immutable while using views.
Compression must be decoded before these views exist; network and SQLite copies
are not removed by this format.

History metadata is `{format:"stats-history",node}`. Nodes distinguish a host
summary, device series, project metric series, collector JSON metadata, or a
bundle of those. Numeric point field names are schema checked; optional object
presence is represented by byte columns so `{psi:{}}` is not silently dropped.
Collector text remains in the small metadata section. Changing existing field
semantics or physical layout requires a new version and golden vectors.

## Experimental storage format (STR1), for reproducibility only

The test-only candidate uses a 16-byte header: `STR1`, a one-byte kind
(sample=0, delta=1, rollup=2), version=1, two zero reserved bytes, total length
u32, and key count u32. A sorted property-key dictionary precedes a tagged
value tree. Tags are null=0, false=1, true=2, f64=3, string=4, decimal-u64=5,
array=6, object=7. Lengths and key indexes use canonical unsigned base-128
varints. Object key indexes are strictly increasing. Strings have an escape
flag and UTF-8 byte length; lone UTF-16 surrogates use a JSON-string fallback.
Decimal strings outside u64, leading zeroes and fixed-point text stay strings,
so rollup sums larger than u64 do not overflow. Decoder limits bound bytes,
strings, keys, depth and total nodes; prototype-named properties remain data.

This is NOT a wire-v2 proposal and NOT a new database schema. The helpers return
unknown; domain validation remains separate. Malformed binary does not fall
back to JSON. Existing STRICT TEXT columns cannot accept BLOBs simply because a
helper can read both: a real stored-format change needs an explicit migration.

## Final integration checklist (owner)

1. Run the complete capture parity suite and pinned checks above, then benchmark
   in workerd and the target browser, including encode, validation, chart access,
   compression, GC and cold-start/uncached-history behavior. Keep a columnar-JSON
   control. Evaluate pages/projections before any raw stored-format change.
2. Add explicit representation negotiation in `installation.ts` and
   `client/api.ts` only when the frontend consumes columns. Keep JSON as default
   and debug/external representation. Use `HISTORY_CONTENT_TYPE` for binary,
   preserve all Access checks and security/cache headers, add `Vary: Accept`, and
   make ETags representation-specific. A 304 must reuse the matching encoding.
3. Use `openHistory(await response.arrayBuffer())` and consume the returned
   table views. Check validity bitmaps: absent slots contain zero storage bytes,
   but those zeroes are **not observations**. Existing chart/health adapters
   expect nullable point arrays; adapting them is essential. The exported
   `materializeHistory` is for compatibility and tests, not the fast path.
4. Avoid re-encoding a whole window on every client poll. Prefer building columns
   at their source or caching encoded output with a byte bound, keyed by format,
   host/project, source version, window and kinds. Preserve invalidation for late
   samples, corrected neighboring deltas, rollups, retention and purges.
5. Leave ingest v1, exact counters, canonical duplicate/conflict comparison and
   raw JSON storage unchanged unless an independent storage experiment wins.
   Binary bytes from different versions are not a replacement for canonical
   sample equality. A derived columnar BLOB cache must retain a way to rebuild
   from authoritative samples and repair affected buckets.
6. Incremental refresh is not implemented here. It needs an explicit cursor/reset
   contract for late corrections, removals, rolling windows and downsampling;
   append-only polling would be incorrect. Introduce it as a separately tested
   change rather than hiding a semantic change inside serialization.
7. Take a production baseline, integrate, deploy, and compare the same workloads.
   This commit intentionally performs none of the cutover, migration or deploy.
