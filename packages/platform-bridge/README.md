# Build and test the Stats platform bridge

Use the pinned Node and workspace dependencies from the Stats checkout.
Build the existing Stats and observation Workers before native tests.

```sh
node cloudflare/scripts/ensure-build.ts --target stats
node cloudflare/scripts/ensure-build.ts --target observe
node --test cloudflare/test/producer/platform-*.test.ts cloudflare/test/observe/platform.test.ts
node --test deploy/orange/platform.test.mts
node cloudflare/scripts/build-platform-bridge.mjs --out .work/tmp/platform-bundle
```

The build produces `main.mjs` and a SHA-256 manifest. The bundle contains the
existing producer and Node built-ins. It has no external runtime dependencies.

Use the [shared runtime runbook](https://github.com/laputa-systems/stuff/blob/main/docs/openorange-runtime.md#stats-runtime-telemetry) to build the container, verify actor selectors
and enable the optional private service. Shared lifecycle files belong to Stuff.
The bridge never receives an Engine token.

Run the native overhead rehearsal with a protected captured-event file and
verified actor selectors:

```sh
node cloudflare/scripts/bench-platform-runtime.mjs \
  --events /path/to/protected/application-window.json \
  --actors /path/to/verified-stats-actors.json \
  --out .work/tmp/platform-overhead.json
```

The rehearsal runs its own load gates and two isolated local native runtimes.
It never connects to the production Engine.
