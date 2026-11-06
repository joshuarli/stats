# History frames

Every host and project history response is an STC1 frame
(`HISTORY_CONTENT_TYPE`). There is no JSON history representation, content
negotiation, or point-object model. The SQL schema and the history algorithms
(rollups, rates, missing-versus-zero, gap rules) are independent of the frame.
Host ingest uses the separate binary STB2 format (`docs/binary-ingest.md`),
which shares no envelope or code with STC1. The wire contract, compression, and
ETag behavior are in `docs/architecture.md#history-frames`; this file holds the
codec reference, measurements, and the negative storage result.

## What is implemented

- `cloudflare/src/binary/columns.ts`: a bounded, versioned numeric frame with
  `Float64Array`, `BigUint64Array`, and byte-column views, presence bitmaps and
  references to earlier columns. `encodeColumns` serializes typed columns;
  `decodeColumns` validates a whole frame before exposing views.
- `cloudflare/src/binary/history.ts`: the field schemas per history kind,
  `HISTORY_CONTENT_TYPE`, and `openHistory`, which validates the history schema
  (required fields, parent presence, paired fields, bundle identity) and returns
  bounded metadata plus table views.
- `cloudflare/src/history-frame.ts`: the server side. It reads the point
  objects the unchanged algorithms produce into typed columns, one reader per
  field, rounding to three decimals, and composes frames for one history or a
  bundle. A non-finite value is absent, never zero. The Durable Object keeps the
  columns of its last four windows and serializes them per request.
- `cloudflare/src/cloudflare/index.ts`: `Content-Encoding` (`br`, else `gzip`) and
  `Vary: Accept-Encoding` for history routes.
- `cloudflare/src/client/columns.ts`, `history.ts`: the dashboard model. A
  `Table` is a time axis plus named columns; `cells(name)` converts a column to
  a `(number | null)[]` once and memoizes it, an absent column is all `null`,
  and derived columns (CPU used, memory used, network faults) are memoized per
  table. `chart-data.ts` aligns tracks (a time axis with a column) and passes
  tracks that share a gap-free axis through without copying.
- `cloudflare/test/support/history.ts`: test-only. `encodeHistory` is an
  independent oracle that encodes JSON-shaped histories generically and checks
  them field by field; `materializeHistory` and `readHistory` rebuild the
  JSON-shaped history from a frame. Playwright mocks and replays, the preview
  server, and `scripts/api.mjs` use them. The captured JSON files in
  `cloudflare/test/ui/captures` remain the fixture sources.
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
node --experimental-strip-types --test cloudflare/test/binary/*.test.ts
node --experimental-strip-types --expose-gc cloudflare/scripts/bench-history.mjs > .work/tmp/history-bench.json
# --quick uses 20 rather than 100 operations per round.
# Standalone typecheck, with the repository's installed compiler:
pnpm --dir cloudflare exec tsrs -p binary.tsconfig.json --noEmit --fast
```

`binary.tsconfig.json` inherits the repository's strict options but omits
unrelated Worker/Vite ambient types. The Node tests run in the regular
`cloudflare` package test script and `make cloudflare-test`; the Worker tests
(`test/history-frame.test.ts`, `test/history.test.ts`) check the server's frames
against the oracle for every captured history and for a synthetic history that
carries every schema field.

## Measured results after integration: 2026-11-02

Apple M5 Max, macOS, Node **26.12.1**, five rounds of 100 operations after
warm-up, medians. These are Node timings, not workerd, browser, or Cloudflare
cost measurements. "Captured" rows are the repository captures of the
`threadripper` host (170 network interfaces, most seen for a few samples) and
the `stuff` project. Sizes are bytes; gzip is level 6 and Brotli quality 5.

Wire compression was checked against the real built Worker and a minimal
Worker under standalone workerd with a raw HTTP client: workerd's gzip and
Brotli output matched Node's level 6 and quality 5 byte for byte on the 1h,
24h, and 7d captured bundles, so the compressed columns below are what crosses
the wire from workerd. They were not measured at Cloudflare's edge. A response
with `Content-Encoding` set and an uncompressed body is compressed once on the
wire whether the header is set in the Durable Object or the Worker, and a
`304` carries no `Content-Encoding`.

Sizes, JSON (before) / frame:

| Case | Uncompressed | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| threadripper 1h | 424,797 / 168,368 | 41,212 / 24,726 | 32,317 / 21,812 |
| threadripper 6h | 1,373,175 / 578,000 | 130,356 / 72,653 | 93,111 / 59,413 |
| threadripper 24h | 1,449,279 / 625,624 | 143,212 / 81,751 | 103,693 / 66,505 |
| threadripper 7d | 56,731 / 119,864 | 5,189 / 6,879 | 4,610 / 5,727 |
| threadripper 90d | 56,736 / 119,864 | 5,188 / 6,881 | 4,609 / 5,737 |
| stuff project 1h | 6,300 / 10,624 | 1,397 / 1,733 | 1,326 / 1,608 |
| synthetic host bundle 900 | 994,454 / 431,080 | 69,480 / 33,611 | 48,510 / 13,752 |

The 7d and 90d bundles and the project grow: 170 interfaces with a handful of
rows each pay a descriptor and eight-byte padding per column. Everything with
real density shrinks, by about 40 to 45 percent gzipped and 33 to 36 percent
Brotli on the captures.

Server time per request, JSON.stringify (before) / extract typed columns and
encode / encode columns the Durable Object already holds, microseconds:

| Case | JSON.stringify | Extract + encode | Encode only |
| --- | ---: | ---: | ---: |
| threadripper 1h | 244 | 227 | 41 |
| threadripper 6h | 789 | 780 | 210 |
| threadripper 24h | 838 | 844 | 238 |
| threadripper 7d | 31 | 326 | 187 |
| stuff project 1h | 3.7 | 20.6 | n/a |
| synthetic host bundle 900 | 633 | 558 | 51 |

On the 900-point bundle extraction and encoding together are faster than
JSON.stringify was, and a window the Durable Object has already extracted
serializes in a twelfth of that. Extraction costs about 6 ns per cell. Output
is not cached: serializing held columns is the 41 to 238 us column above, and
the `ETag` already skips the work when nothing changed. The cost that does not
shrink is per column, about 0.12 us in the descriptor, so the 7d capture
(1,530 columns) is ten times slower than JSON and 0.3 ms in absolute terms.

Client time, microseconds, old path (`JSON.parse`, schema decode into point
objects, `summarySeries`, `alignSeries`, monitors) / new path (frame
validation, lazy column conversion, `alignTracks`, monitors). Load is the whole
`getHostHistories` call over a stubbed `fetch`; prepare aligns every series on
the host page (54 to 55 charted series, 8 monitor cells). The old and new paths
produced identical aligned times and values and identical monitor states on all
seven inputs.

| Case | Load | Prepare | Total |
| --- | ---: | ---: | ---: |
| threadripper 1h | 725 / 225 | 1,420 / 967 | 2,005 / 1,626 |
| threadripper 6h | 2,056 / 684 | 4,691 / 2,196 | 7,049 / 4,479 |
| threadripper 24h | 2,192 / 772 | 5,201 / 2,372 | 7,612 / 4,855 |
| threadripper 7d | 109 / 522 | 108 / 87 | 221 / 836 |
| threadripper 90d | 108 / 515 | 107 / 84 | 217 / 828 |
| synthetic host bundle 240 | 548 / 115 | 1,176 / 501 | 1,724 / 938 |
| synthetic host bundle 900 | 1,998 / 304 | 4,656 / 1,809 | 7,020 / 3,237 |

Dense histories load two to seven times faster and prepare about two times
faster. The 7d and 90d captures regress by about 0.6 ms, from view creation and
validation per column. Build output: client JavaScript grew from 260,363 to
270,562 bytes (95,004 to 98,624 gzipped), the Worker bundle from 150,779 to
166,173 bytes (36,696 to 40,686 gzipped).

## Measured results before integration: 2026-11-02

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

Table entries are JSON / binary. Sizes are bytes, and time is median microseconds.
Gzip is level 6; Brotli measurements in the JSON report use quality 5.

| Case | Uncompressed bytes | Gzip bytes | JSON parse / validated binary views, us |
| --- | ---: | ---: | ---: |
| `worker-1h.json` | 883 / 2,200 | 368 / 574 | 3.5 / 32.3 |
| `summary-7d.json` | 3,048 / 2,720 | 893 / 1,228 | 13.5 / 57.5 |
| `summary-240` | 79,788 / 52,880 | 5,464 / 3,412 | 416.9 / 94.5 |
| `host-bundle-240` | 265,283 / 119,392 | 18,606 / 7,685 | 1143.4 / 177.1 |
| `host-bundle-900` | 994,454 / 431,080 | 69,480 / 32,304 | 4171.1 / 417.1 |

These measured the generic point-object encoder and a columnar-JSON control that
no longer exist in the tree. The layout-only control matters. For the synthetic 900-point host bundle:

- Object JSON: 994,454 bytes; 69,480 gzip bytes; 4,171.1 us native parse.
- Columnar JSON: 32,128 gzip bytes; 1,581.2 us native parse, without schema validation.
- Binary: 431,080 bytes; 32,304 gzip bytes; 417.1 us validated views.

Most of the compression improvement comes from columnar layout. Binary is not
always smallest after compression: columnar JSON slightly wins gzip for that
bundle, and also wins Brotli for the synthetic summary cases. Binary's distinct
benefit is avoiding per-point object/number-array construction on the read path.

Encoding existing point objects generically is not free. The same 900-point
bundle took about 4.13 ms to stringify and 9.32 ms through the generic encoder,
and converting the binary back into point objects loses its read advantage. The
integration therefore builds typed columns per field and the client reads
columns directly.

Small actual captures regress: `worker-1h.json` grew from 368 to 574 gzip bytes;
the 10-point `summary-7d.json` grew from 893 to 1,228 gzip bytes. The owner chose
one representation anyway, so small responses carry this cost.

The generic storage candidate reduced the two full-ingest sample sizes from
1,685/1,532 to 1,459/1,223 bytes, but gzip got larger (643/625 to 811/774), and
object decode was about 5x slower (53.3/36.7 versus 11.0/6.9 us). That is a
negative result: **do not migrate `samples.payload`, `samples.delta` or
`rollups.payload` to this codec.** A read-optimized columnar projection/page is a
separate storage design to benchmark, not a proven drop-in BLOB optimization.

No billed-cost or end-to-end zero-copy claim follows from these measurements.
FlatBuffers was not benchmarked.

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

Limits: 32 MiB frame, 4 MiB descriptor, 16,384 tables, 131,072 total columns,
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
summary, device series, a project metric table (one `f64` column per metric),
collector JSON metadata, or a bundle of those; `docs/architecture.md` lists the
shapes. Numeric point field names are schema checked
(`cloudflare/src/binary/history.ts`); optional object presence is represented
by byte columns so `{psi:{}}` is not silently dropped. Collector text remains in
the small metadata section. Changing existing field semantics or physical
layout requires a new version and golden vectors.

`encodeColumns` takes typed columns (`Float64Array`, `BigUint64Array`, or
`Uint8Array` plus a validity bitmap or `null`) and copies them into the frame;
it does not inspect cells, so a caller must supply finite values, zero in
absent slots, and a zero-padded bitmap. `decodeColumns` rejects anything else.
Columns that share one values array are written once and referenced. Encoding
requires a little-endian host.

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

## Remaining work

1. Time the dashboard in the target browser and the Worker in workerd under
   load, including GC and a cold Durable Object. The numbers above are Node.
2. A stacked layout (one table per kind with a series index) would remove the
   per-column cost for hosts with many short-lived devices and the 7d and 90d
   size growth. It needs a row limit above 16,384 and a new frame version.
3. Leave exact counters, canonical duplicate/conflict comparison and raw JSON
   storage unchanged unless an independent storage experiment wins.
   Binary bytes from different versions are not a replacement for canonical
   sample equality. A derived columnar BLOB cache must retain a way to rebuild
   from authoritative samples and repair affected buckets.
4. Incremental refresh is not implemented. It needs an explicit cursor/reset
   contract for late corrections, removals, rolling windows and downsampling;
   append-only polling would be incorrect. Introduce it as a separately tested
   change rather than hiding a semantic change inside serialization.
5. Compare production before and after the first deploy on the same workloads.
