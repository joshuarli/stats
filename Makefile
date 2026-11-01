.DEFAULT_GOAL := check

STATS_DOMAIN ?= stats.17166969.xyz
STATS_URL ?= https://$(STATS_DOMAIN)
SECRETS_FILE ?=
export STATS_DOMAIN
export STATS_URL

.PHONY: work-ready node-ready auth-ready fixtures agent-test agent-build cloudflare-test dashboard-test lint worker-check worker-bundle worker-deploy worker-test deploy deploy-hosts deploy-threadripper smoke-deployed release check
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
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry typecheck
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry test

dashboard-test: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry build
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry test:ui

lint: node-ready
	pnpm --filter @stats/telemetry lint

auth-ready:
	@cf auth whoami >/dev/null

worker-check: node-ready
	cd cloudflare && pnpm build && cf deploy --prebuilt --dry-run --mode production

worker-bundle: node-ready
	cd cloudflare && pnpm build

worker-deploy: auth-ready worker-bundle
	cd cloudflare && cf deploy --prebuilt --mode production $(if $(SECRETS_FILE),--secrets-file '$(SECRETS_FILE)')

worker-test: cloudflare-test dashboard-test lint

deploy: auth-ready
	$(MAKE) fixtures
	$(MAKE) worker-test
	$(MAKE) agent-test
	cd cloudflare && cf deploy --prebuilt --mode production $(if $(SECRETS_FILE),--secrets-file '$(SECRETS_FILE)')
	$(MAKE) smoke-deployed
	$(MAKE) deploy-hosts

deploy-hosts: agent-test agent-build
	@set -eu; \
	hosts="$$(jaq -er '.hosts | keys[]' deploy/hosts.json)"; \
	test -n "$$hosts" || { echo 'no hosts in deploy/hosts.json' >&2; exit 1; }; \
	for host in $$hosts; do deploy/deploy-host.sh "$$host"; done

deploy-host-%: agent-test agent-build
	deploy/deploy-host.sh '$*'

rollback-host-%:
	deploy/deploy-host.sh '$*' --rollback

deploy-threadripper: deploy-host-threadripper

smoke-deployed:
	STATS_URL='$(STATS_URL)' deploy/deployed-smoke.sh

release: agent-build

check: fixtures agent-test release cloudflare-test dashboard-test lint
