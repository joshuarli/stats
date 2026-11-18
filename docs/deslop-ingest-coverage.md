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
