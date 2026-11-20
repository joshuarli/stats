# Ingest types: bounded DSLP-3 inventory

Base `034a833fa7c75ee1c2fae9d2a45d1db954ccaaa8`; scope is the six
`cloudflare/src/ingest/{encode,ack,http,frame,sample,ack-decode}.ts` files
(1,128 physical lines). This is not the whole Types or Tests step. No source,
configuration, wire, or runtime change was made. The deslop escape-hatch
expression counts four matches before and after; it does not count `!`.

| Candidate | Measurements and disposition |
| --- | --- |
| `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax` | Already enabled in `cloudflare/tsconfig.json`; not new adoptions. Full project typecheck passed. |
| `noPropertyAccessFromIndexSignature` | 154 diagnostics, all in `encode.ts`, on dynamic `Json`/`SourceBatch` records; zero demonstrated defects. These demand bracket spelling and do not establish missing-key safety. Reject: at least 154 false positives for defect finding. Witness: `encode.ts:97` reads `unknown` properties which subsequent processing handles. |
| `no-non-null-assertion` | 60 actual assertion sites: http 1, sample 1, encode 15, frame 43. Zero demonstrated defects; at least three false positives for defect finding: `http.ts:6` splits a string, `frame.ts:122` checks the byte bound, and `frame.ts:557` checks the header length. The other 57 are not individually established as defects or proven safe here; many depend on counter shape or dictionary bounds. Reject: even the three demonstrated false positives exceed the one per 5,000-line budget. |
| `no-unsafe-type-assertion` | Four actual narrowing assertions, no demonstrated behavioral defect. `encode.ts:18` follows an object/null/array check; `ack-decode.ts:17` builds the inverse of the closed code table, with unknown codes rejected at lookup. `encode.ts:161,250` trust caller input without validation; adding guards could change coercion or errors. Reject component-wide adoption: at least two false positives and no behavior-preserving hatch removal established. |
| `no-unnecessary-type-assertion` | Zero diagnostics; reject adoption because no defect or hatch removal witnessed. |
| `no-explicit-any`, `no-unsafe-assignment/argument/call/member-access/return`, `no-floating-promises`, `switch-exhaustiveness-check` | Already enabled for source in `.oxlintrc.json`; full lint passed. `no-misused-promises` is also enabled. No new adoption claimed. |

The full lint profile is clean, but passing it does not validate handwritten
assertions. In particular, this inventory does not claim the 57 remaining
non-null sites safe. The four `as` sites are retained; no escape hatch was
added. No boundary test was added, so there is no new boundary test to inject
with a fault. Existing ingest corpus tests cover golden frames, acknowledgments,
malformed input and strict prefixes; these are not a mutation score.

## Reproduction and controls

macOS arm64; Node 26.13.1, pnpm 12.21.0, tsrs 0.25.0-ts7.1.0-beta,
Oxlint 1.93.0. From the worktree, use the pinned Node bin first in `PATH`,
`TMPDIR=$PWD/.work/tmp`, `PYTHON_CPU_COUNT=2`, `CARGO_BUILD_JOBS=1`,
`RUST_TEST_THREADS=1`, and `RUSTC_WRAPPER=kache`. Each install or check below
ran alone inside `cpu-guard --cores 2 --` while holding one atomically acquired
`/Users/josh/d/stuff/.work/tmp/deslop-heavy-slots/{1,2,3}` directory; the
owner released it on exit. `pnpm install --frozen-lockfile --ignore-scripts`
exited 0.

From `cloudflare/`:

- `pnpm exec tsrs -p binary.tsconfig.json --noEmit --fast --noPropertyAccessFromIndexSignature` exited 2, with 154 diagnostics in the six-file scope. Other binary-project files are outside that count.
- For each of `no-non-null-assertion`, `no-unsafe-type-assertion`, and `no-unnecessary-type-assertion`, run `pnpm exec oxlint --type-aware -D typescript/RULE -f json src/ingest/{encode,ack,http,frame,sample,ack-decode}.ts`. Respective exits were 1, 1, 0 and diagnostic counts 60, 4, 0.
- `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:ingest`, `pnpm run test:binary`, and `pnpm run test:node` each exited 0. Ingest: 10 passed; binary: 217 passed; Node: 64 passed; none skipped.
- `pnpm exec node scripts/run-tests.mjs --file test/ingest.test.ts --jobs 1` exited 0: Worker ingest 21 passed.

Checker negative control: two scratch `.ts` files under `.work/tmp` each
contained `function firstByte(bytes: Uint8Array): RETURN { return bytes[0]; }`.
The negative used `RETURN` = `number`; the control used `number | undefined`.
For each, a scratch JSON config extended `../../cloudflare/tsconfig.json`, set
`compilerOptions.types` to `[]` for scratch module resolution, and included
only its corresponding file. `cloudflare/node_modules/.bin/tsrs -p CONFIG
--noEmit --fast` exited 2 with TS2322 (`number | undefined` is not assignable
to `number`) for the negative and 0 for the control. An earlier direct-file
invocation failed with TS5112, and the first scratch configs failed with
TS2688 before setting `types: []`; neither was counted as a witness.

No application runtime changed, so consumer performance is unaffected by this
slice and no timing claim is made. Agent, full macOS UI, external fleet
consumers, CI and broader Types/Tests closure were not run or claimed.

## Rust agent wire inventory

At `155dfff5`, the following run on macOS arm64 with Clippy 0.1.101
reported three selected lint findings in `agent/src/wire.rs`.

```sh
cargo clippy --locked --manifest-path agent/Cargo.toml --lib --message-format=json -- \
  -W unsafe_code -W clippy::wildcard_enum_match_arm \
  -W clippy::match_wildcard_for_single_variants -W clippy::cast_possible_truncation \
  -W clippy::cast_sign_loss -W clippy::unwrap_used -W clippy::expect_used \
  -W clippy::redundant_clone -W clippy::needless_pass_by_value
```

All three come from `cast_possible_truncation`. Encoding masks the low
seven bits of each continuation byte, then emits a final value below 128.
The decoder checks the rejection count against `MAX_SAMPLES` (16) before
converting it to the allocation size. The casts are retained with those
bounds. The other requested lints produced zero findings in the wire
module. The library-wide run also reported 67 unsafe-code diagnostics
outside this scope on macOS, so it supplies no basis for a crate-wide
forbid rule.

The ordinary precedence lint flagged the service header expression twice.
Its bit contributions are now grouped explicitly. The wire fixtures and
conformance tests verify the same emitted bytes.

## Producer and platform bridge

At `df60b83`, the producer and platform bridge already used strict
checking, indexed reads that include `undefined`, and exact optional
properties. Both typechecks passed with
`--noPropertyAccessFromIndexSignature` and produced no findings.

Type-aware Oxlint reported 11 producer non-null assertions, five
unsafe narrowing assertions, and no unnecessary assertions. Four
of the five narrowing findings came from successful delivery ACKs.
The decoder now narrows the two counts to numbers, checks that each is
a nonnegative safe integer, and returns them without an assertion.
The producer suite verifies missing counts, strings, negative values,
a fractional value and an out-of-range integer through the delivery
callback and counters. The producer lint candidate now reports only
the timer handle assertion. The non-null cases still need individual
review.

The bridge candidate reported three unsafe assertions at its JSON
policy load and HTTP body reads. Its current lint profile also
flagged an async signal callback. There were no bridge non-null or
unnecessary assertion findings. The bridge boundary findings remain
open.

Use the pinned Node and pnpm from the repository. Run
`pnpm --filter @stats/producer run check`, and run `make
integration-producer` for the delivery and bridge cases. The local
suite passed 24 cases and skipped the opt-in Nanoshop checkout case.
For the bridge checker use `pnpm --dir cloudflare exec tsrs -p
../packages/platform-bridge/tsconfig.json --noEmit --fast`. To repeat
the lint sample, use `pnpm --dir cloudflare exec oxlint --type-aware
-D typescript/RULE -f json "$PWD/packages/COMPONENT/src"`, passing
the component directory as an absolute path.

## Repository candidate measurements at 7fc3ff9

The existing profiles retain `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`; `noImplicitOverride` is enabled in the main
Cloudflare and producer profiles and inherited by the bridge, binary and
observe profiles. The deployments profile passes with it (zero diagnostics),
but has no defect or removed assertion witness, so it is not newly enabled.
The existing Oxlint source profile retains `no-explicit-any`, the five
`no-unsafe-*` rules, `no-floating-promises` and
`switch-exhaustiveness-check`. There are no new profile adoptions in this
measurement.

`noPropertyAccessFromIndexSignature` produced 448 diagnostics in the main
Cloudflare project, 227 in binary, 18 in deployments, 77 in observe, and zero
in each producer and bridge project (the project counts overlap). It is
rejected: the ingest sample above establishes dynamic-record spelling false
positives and no defect witness. `no-non-null-assertion` produced 380 findings
across Cloudflare and both TypeScript packages. It is rejected for the
previously established bounded ingest false positives; the remaining sites
are not thereby proven safe. Running each of the already enabled Oxlint
candidates on those source trees reported zero findings for the selected
rule. The combined invocation also reported one existing
`no-misused-promises` finding in the bridge when checked using the Cloudflare
configuration; this is not a finding from any selected candidate.

Clippy on all targets produced these diagnostic counts, including duplicate
library/test compilations and tests: agent: unsafe 148, wildcard enum match 5,
match wildcard single variant 0, possible truncation 24, sign loss 4, unwrap
241, expect 6, redundant clone 0, needless pass by value 12; Rust producer:
respectively 0, 0, 0, 6, 2, 61, 0, 0, 4. The unsafe forbid candidate cannot
represent the agent's platform FFI; the previous wire audit identifies bounded
casts. Tests deliberately unwrap results. The producer ceiling cast has a real extreme-duration defect, filed as
DSLP-9: `backoff_delay(0, 100 ms, 1.0, Duration::from_millis(u64::MAX)
+ 1 ms)` returned 0 ms in a scratch Rust witness. The same lint also flags
intentional rounding and the current-time
conversion, while the agent wire audit identifies bounded casts; the
false-positive budget is exceeded. The other candidates have no established
defect or deleted escape hatch witness at the proposed profile; none is newly
enabled. These counts are discovery, not a claim that each site
is safe. Linux and optional BPF feature diagnostics were not measured on this
macOS host.

Measurements used Node 26.13.1, pnpm 12.21.0, tsrs 0.25.0-ts7.1.0-beta,
Oxlint 1.93.0 and the pinned Rust nightly. Run each TypeScript project with
`tsrs -p CONFIG --noEmit --fast --noPropertyAccessFromIndexSignature`; the
four Cloudflare projects exited 2 and both packages exited 0. Run Oxlint from
`cloudflare` with `--type-aware -D typescript/RULE -f json` over `src` and
the absolute package source paths. Each selected rule had zero diagnostics
except the 380 non-null sites; the invocation exited 1 due to the separate
bridge diagnostic. Both Rust commands used `cargo clippy --locked --all-targets
--message-format=json` with the nine `-W` candidates in the wire command
above; both exited 0. The agent needed the temporary workspace fixture
documented in `docs/deslop-macos-sandbox.md`. Escape-hatch expression counts
in first-party source paths were 291 TypeScript and 257 Rust matching lines;
no source was changed and the count is unchanged. No new runtime or public
contract change is claimed.
