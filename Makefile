.DEFAULT_GOAL := check

.PHONY: work-ready node-ready fixtures agent-test agent-build cloudflare-test dashboard-test release check

work-ready:
	@set -eu; \
	exclude="$$(git rev-parse --git-path info/exclude)"; \
	mkdir -p "$$(dirname "$$exclude")"; \
	if ! rg -qx '\.work/' "$$exclude" 2>/dev/null; then printf '\n.work/\n' >> "$$exclude"; fi; \
	git check-ignore -q .work/tmp; \
	mkdir -p '$(CURDIR)/.work/tmp'

node-ready:
	@set -eu; \
	test "$$(node --version)" = "v$$(cat .node-version)" || { echo 'use the Node version in .node-version' >&2; exit 1; }; \
	test "$$(pnpm --version)" = 11.0.2 || { echo 'pnpm 11.0.2 is required' >&2; exit 1; }

fixtures: node-ready
	node scripts/check-fixtures.mjs

agent-test: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' cargo test --manifest-path agent/Cargo.toml --all-targets

agent-build: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' agent/scripts/build-static.sh

cloudflare-test: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @niceforge/telemetry test

dashboard-test: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @niceforge/telemetry build
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @niceforge/telemetry test:ui

release: agent-build
	TMPDIR='$(CURDIR)/.work/tmp' bench/bench.sh --selftest

check: fixtures agent-test release cloudflare-test dashboard-test
