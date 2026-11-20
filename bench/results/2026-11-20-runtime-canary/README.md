# Runtime change canary — 2026-11-20

The candidate was installed from the owned `open-orange-1.0.2-laputa.1.tgz` into a separate scratch closure. The tarball SHA-256 was `2a3932cd31115bf01bfcbd84d2a836fd66889203e7dd7d5d5e86c07cde2c8dfb`. The repository closure stayed pinned to upstream OpenOrange. The scratch lockfile diff changed only the OpenOrange importer specifier and version, its package resolution and version, and its snapshot key; all other entries were identical.

Commands (Node 26.13.1 and pnpm 12.21.0 from `/Users/josh/.local/bin`):

```sh
export PATH=/Users/josh/.local/bin:$PATH
export TMPDIR="$PWD/.work/tmp"
pnpm install --frozen-lockfile --offline
pnpm --dir cloudflare install --frozen-lockfile --offline
make orange-ready worker-bundle observe-bundle
node --experimental-strip-types --test --test-concurrency=1 deploy/orange/runtime-canary.test.mts
node --experimental-strip-types --test --test-concurrency=1 deploy/orange/canary.test.mts
```

All commands above exited 0. The runtime test passed in 39.3 seconds; the existing canary test passed in 79.8 seconds.

The runtime test invokes `pnpm install` in the copied closure, both `orange --version` commands, `pnpm --dir cloudflare -s statsctl verify release --evidence DIR --json`, and the same command with `--replay`. The versions were `1.0.2` and `1.0.2-laputa.1`. Both verification commands exited 0 and replay returned `pass`. The policy has permissive resource and latency limits; this run claims no performance improvement. The external Engine came from the candidate closure's RivetKit engine-cli. Metrics were:

```json
{
  "base": 64036,
  "workers": [
    [
      "openorange_worker_info{worker=\"stats\",index=\"0\"} 1",
      "openorange_worker_start_time_seconds 1795192358.4383507"
    ],
    [
      "openorange_worker_info{worker=\"stats-observe\",index=\"1\"} 1",
      "openorange_worker_start_time_seconds 1795192359.0967999"
    ]
  ]
}
```

Component SHA-256 values from the evidence manifests:

```json
[
  {
    "releaseId": "baseline",
    "components": {
      "orange-package": "905ea47add0faa162bb8402882a9051f6ebaaafefd6b1f835f0ccad4a9a91d9f",
      "orange-lock": "13eafaa9b99d47e67fc1bc1df5c249c9d174756165d93118a62e37f24159104a",
      "orange-bin": "d91f5934167f41d0f4f976b558bdea980c0324787ab8092b118b92814672ecdd",
      "workspace-lock": "24f189164e37398a0828d33907a75fcb58ce64311a236b4403db0f588fec69de",
      "stats-bundle": "19cd8752a206ed0f813f09ef24a9e1325519116db4742af46e22d0ac64c14274",
      "observe-bundle": "aa67ee0d3c71c77b34f375960f30b7888fd9c27cdc5c2a5e3321ce03a52a1987"
    }
  },
  {
    "releaseId": "candidate",
    "components": {
      "orange-package": "a8e958a68545eb0ea7a161f08de034a0fd4e092cc185513bfa79993c8cefa8bc",
      "orange-lock": "a9dde6e5afe24384b999d1e6bef0920e7aec127e7a37f129ac9b03ad007824ff",
      "orange-bin": "79bd3006dfdc92d96ab83c793d3a9c514106451a445f9db7bae328f1f4fa2232",
      "workspace-lock": "24f189164e37398a0828d33907a75fcb58ce64311a236b4403db0f588fec69de",
      "stats-bundle": "19cd8752a206ed0f813f09ef24a9e1325519116db4742af46e22d0ac64c14274",
      "observe-bundle": "aa67ee0d3c71c77b34f375960f30b7888fd9c27cdc5c2a5e3321ce03a52a1987"
    }
  }
]
```

Release verdict JSON:

```json
{
  "kind": "release-verdict",
  "policy": "local-canary",
  "baselineRelease": "baseline",
  "candidateRelease": "candidate",
  "workloadSha256": "d24f71cd733b9cac085413e603aefb745aa4bb37b45f75f856849ca0e587a3e6",
  "verdict": "pass",
  "gates": {
    "correctness": "pass",
    "durability": "pass",
    "identity": "pass",
    "delivery": "pass",
    "evidence": "pass",
    "limits": "pass",
    "recovery": "pass"
  },
  "reasons": [],
  "improvement": "not-claimed",
  "evaluatedAtMs": 1795192353309,
  "hashes": {
    "policy.json": "659e4a0b6635e8d5590b16e584d831c04e6b9542905de847aed59445b6e39a64",
    "baseline.manifest.json": "7f61c8358fb2f2a9431e4db541e0262ccc856caf2642112144b8fe279a9d6000",
    "candidate.manifest.json": "8f5fc32f70b3a2d3882bcdfed31675e48dddfc7a97671c65940a8247c6613a80",
    "workload.json": "d24f71cd733b9cac085413e603aefb745aa4bb37b45f75f856849ca0e587a3e6",
    "ledger.json": "cfe13d3b1f267225ef00e936a4c673077b7a870d6f669c38aa016b582c15bda9",
    "observations.json": "b5c877a27bd887405d030072d592dc46d5f372354a5a6b1a8ba747dff31751d6",
    "recovery.json": "acb242eab7c04310b38649243c961a3e3ae6e2ef6d5e213b17e4a523c20b0540"
  }
}
```
