# Stats ingest coverage evidence

Measured at `19d4369c5bfefe554314357a6681547caffbafbe` on macOS arm64.
The shared corpus tests include the repeated-rejection acknowledgment from
[#28](https://github.com/joshuarli/stats/pull/28).

| Boundary | Executed evidence | First-party scope |
| --- | --- | --- |
| Node ingest | 10 tests passed, zero skipped | V8 reported 1,112 of 1,128 lines and 820 of 855 branches. The report includes all six ingest files. `http.ts` has zero covered lines and no branch observations in this run. |
| Cloudflare Worker | 21 ingest tests passed in the Worker runtime | Separate execution of `test/ingest.test.ts`. |
| Rust agent | 108 library tests and five conformance tests passed | Cargo-llvm-cov reported 608 of 625 lines and 126 of 146 branches in `agent/src/wire.rs`, including inline tests. |

## Reproduction

Use the repository's pinned Node 26.13.1, pnpm 12.21.0 and Rust nightly.
Install the locked dependencies. Keep `TMPDIR` within the checkout's
`.work/tmp`. From `cloudflare/`, run:

```sh
node --test --experimental-test-coverage --test-coverage-include-all \
  --test-coverage-include='src/ingest/*.ts' \
  --test-reporter=lcov --test-reporter-destination="$TMPDIR/node-ingest.lcov" \
  test/ingest/*.test.ts
node scripts/run-tests.mjs --file test/ingest.test.ts --jobs 1
```

The LCOV `LF`, `LH`, `BRF` and `BRH` records give the reported
denominators and hits. The Worker command establishes the runtime
fixture outcome with a separate test count.

With cargo-llvm-cov 0.9.1 and the pinned LLVM tools, run from the root:

```sh
mkdir -p .work/coverage
cargo llvm-cov --locked --manifest-path agent/Cargo.toml --branch \
  --lib --test conformance --json --summary-only \
  --output-path "$PWD/.work/coverage/agent-wire-summary.json"
```

Read `data[].files[].summary` for `agent/src/wire.rs`. The whole-change
mutation union, browser and Worker coverage counts, and paired suite cost
remain DSLP-4 work.

## ACK decoder boundary

Stryker 10.1.1 selected 115 mutations in the TypeScript ACK decoder
at `3b9354d9`, with source blob `de4186907f20ec667a381d916a8e186f9717fb43`.
The original corpus caught 104. The expanded corpus and exact decoder
error-name check caught 113 of the same 115. Both serial runs took
14 seconds on macOS arm64 with Node 26.13.1. Neither run reported a
timeout, execution error or uncovered identity. All five Node ACK
tests and five Rust conformance tests passed with the expanded corpus.

The two remaining identities are Stryker IDs 17 and 48. An eleventh
varint iteration cannot occur because at index nine a byte above one
throws and zero or one has its continuation bit clear. The same
invariant makes the diagnostic after the loop unreachable.

From the repository root, run Stryker 10.1.1 with the command runner,
one worker, and coverage analysis off. Mutate only
`cloudflare/src/ingest/ack-decode.ts`. Run
`node --test cloudflare/test/ingest/acks.test.ts` in the sandbox.
Include `cloudflare/src/ingest/ack*.ts`, `cloudflare/src/protocol.ts`,
`cloudflare/test/ingest/{acks.test,corpus}.ts` and `fixtures/v2/**` in
the sandbox. Re-run ordinary Rust conformance with
`cargo test --locked --manifest-path agent/Cargo.toml --test conformance`.
This sample covers the TypeScript ACK decoder and its shared
diagnostics. Rust mutation and the broader ingest gates remain open.

The Rust follow-up at `9ac449b` used cargo-mutants 27.1.0 with
`decode_ack` and `Reader::varint`. The corpus and original tests
caught 41 of 42 identities. The remaining comparison rejected a
body exactly at 512 bytes before reaching the trailing-byte check.
The new Rust unit case exercises both 512 and 513 bytes and caught
all 42 of the same inventory, with zero timeouts or unviable builds.
All 109 unit and five Rust conformance tests passed.

Run from the repository root with the pinned Rust toolchain:

```sh
cargo mutants --manifest-path agent/Cargo.toml --no-config --file src/wire.rs \
  --re 'in (decode_ack|Reader.*::varint)$' --in-place --timeout 20 \
  --build-timeout 180 --output "$PWD/.work/tmp/rust-ack-witness" \
  --no-times -- --lib --test conformance
```

Use a disposable checkout and place `TMPDIR` under `.work/tmp`.
The raw `--list` inventory SHA-256 is
`fa78a6a7a47bd44fbdbf6a56b000c43bcca0a2a81d52e34518a7ef574f9e116a`.
Other frame, ingest, producer, and whole-change decisions remain open.

## Producer acknowledgment streams

At `9b8f0b30`, Stryker 10.1.1 selected 68 identities in the producer
`readAck` path. The stream and value checks raised caught identities
from 14 to 30. The 4,096-byte case spans two chunks. At 4,097 bytes
the producer cancels the stream and records the malformed response.
Other cases cover missing bodies, an interrupted stream after a
complete JSON prefix, invalid UTF-8, and scalar JSON.

Three remaining results are equivalent for the runtime contract.
ID 25 leaves the uninitialized parsed value as `undefined`, which
the object check rejects. IDs 53 and 60 remove the runtime type
checks for the two counts. `Number.isSafeInteger` already rejects
every non-number. The type checks remain because they narrow
`unknown` for the compiler.

The same 35 identities timed out in both 3m 12s runs. They repeated
at the longer command-runner bound in 9m 11s. The longer command used
`--test-timeout=1500`, `timeoutMS: 15000` and `timeoutFactor: 3`.
A run with `--test-force-exit` also allowed every previously caught
identity to survive, so that mode is excluded from the evidence.
The repeated timeouts keep this scope outside retained CI.

Disposition of the 35 timeouts: all are detected. A hand replay of 61
mutants of the same lines (`node --test` on the producer test file, 20 s
kill) gave 35 killed, 21 timed out and 5 survived. Each of the 21 timeouts
printed 1 to 15 failing tests before the process outlived 12 s, so the
timeout is a hang after detection, not an untested behavior. The tests that
build a producer without the injected `sleep` keep real backoff sleeps
pending after a failure (DSLP-12). The 5 survivors are the return-type
annotation and the `in` and `typeof` checks that `Number.isSafeInteger`
already covers.

Run the pinned Stryker command runner serially with coverage analysis
off, mutating `packages/producer/src/index.ts:222-258`. Use `node
--test cloudflare/test/producer/producer.test.ts` and include
`packages/producer/src/**`, `cloudflare/src/**`, the producer test file,
`fixtures/observe-ingest/**` and the corresponding package manifests
in the sandbox. The ordered JSON tuples of identity, operator, location
and replacement have SHA-256
`90bf487769f78749b89890228445110af7bbf9fa2576251d768eeb8287e4e9c0`
in all three accepted runs.

## Worker acknowledgment emission

The Worker test now sends five samples in one request. The binary
response reports one accepted sample, one duplicate and three
rejections for the invalid, expired and conflicting samples. The test
checks the rejection order and the two stored rows, including the
original contents of the duplicate.

At `cbe5356`, the existing Workerd suite caught 25 of 27 Stryker
identities across ACK encoding and the response decision. The added
case catches the same 25. The two survivors, IDs 9 and 10 in
`installation.ts`, alter the empty rejection-list fallback. Frame
admission requires at least one sample. Every sample in a completed
transaction is accepted, counted as a duplicate, or appended to the
rejection list. With both delivery counters zero, the first rejection
therefore exists. The optional access and fallback remain in the
typed code. All 22 Workerd tests, lint and type checking passed.

Use a disposable archive, Node 26.13.1, Workerd via the pinned
Vitest plugin and Stryker 10.1.1. Install locked dependencies and add
a test-only binding in `cloudflare/vitest.config.mjs` so the Worker
receives `__STRYKER_ACTIVE_MUTANT__` from the command environment.
Select `cloudflare/src/ingest/ack.ts:19-32` and
`cloudflare/src/core/installation/installation.ts:629-635`. Run Stryker
in place in the archive with a serial command runner, coverage
analysis off, and this command from the repository root:

```sh
cd cloudflare && node scripts/run-tests.mjs --file test/ingest.test.ts --jobs 1
```

The source blobs are `183ce6a7b67424b03b135d2b4e42778a06b371e2` for
the encoder and `d792273d7c1ae306dfd634fe330a4bd08b987358` for the
installation. The ordered JSON identities have SHA-256
`1dc5b360f58cead0bae28cf07f4f04eae29a6cfce004c9393d2a6760b5d15792`.
The earlier varint loop, storage internals and the whole-change
workflow remain outside this selection.
