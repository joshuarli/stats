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
