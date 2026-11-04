.DEFAULT_GOAL := check

STATS_DOMAIN ?= stats.17166969.xyz
STATS_URL ?= https://$(STATS_DOMAIN)
SECRETS_FILE ?=
SSH ?= local
export STATS_DOMAIN
export STATS_URL

.PHONY: work-ready node-ready auth-ready fixtures agent-test agent-build agent-build-macos add-host add-host-check cloudflare-test dashboard-test dashboard-bench lint worker-check worker-bundle observe-deploy observe-sourcemap worker-deploy worker-test deploy deploy-hosts deploy-threadripper smoke-deployed release check preview
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
	test "$$(pnpm --version)" = 12.15.0 || { echo 'pnpm 12.15.0 is required' >&2; exit 1; }

fixtures: node-ready
	node scripts/check-fixtures.mjs

agent-test: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' cargo test --manifest-path agent/Cargo.toml --all-targets

agent-build: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' agent/scripts/build-static.sh

agent-build-macos: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' cargo build --release --manifest-path agent/Cargo.toml

add-host-check:
	@test -n '$(NAME)' || { echo 'usage: make add-host NAME=<label> [SSH=<user@host>|local]' >&2; exit 2; }

add-host: add-host-check
	@set -eu; \
	if [ '$(SSH)' = local ]; then os=$$(uname -s); else \
	  os=$$(ssh $${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=10} -- '$(SSH)' uname -s); \
	fi; \
	case "$$os" in \
	  Darwin) build=agent-build-macos ;; \
	  Linux) build=agent-build ;; \
	  *) echo "add-host: $(SSH) reported '$$os'; expected Darwin or Linux" >&2; exit 1 ;; \
	esac; \
	$(MAKE) --no-print-directory "$$build"; \
	deploy/add-host.sh '$(NAME)' '$(SSH)'

cloudflare-test: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry typecheck
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry test

dashboard-test: work-ready
	@test -z "$$(git ls-files '*.png')" || { echo 'PNG files must not be tracked; use webp' >&2; git ls-files '*.png' >&2; exit 1; }
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry build
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry test:ui

dashboard-bench: work-ready node-ready
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry build
	@set -eu; \
	TMPDIR='$(CURDIR)/.work/tmp' node cloudflare/scripts/preview.mjs > .work/tmp/preview-bench.log 2>&1 & \
	pid=$$!; \
	trap 'kill $$pid 2>/dev/null || true' EXIT; \
	sleep 1; \
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry exec node scripts/bench-ui.mjs $(BENCH_ARGS)

preview: work-ready node-ready
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry build
	TMPDIR='$(CURDIR)/.work/tmp' node cloudflare/scripts/preview.mjs

lint: node-ready
	pnpm --filter @stats/telemetry lint

auth-ready:
	@cf auth whoami >/dev/null

worker-check: node-ready
	cd cloudflare && pnpm build && cf deploy --prebuilt --dry-run --mode production
	cd cloudflare && pnpm run build:observe && cd observe-worker && cf deploy --prebuilt --dry-run --mode production

observe-deploy: auth-ready node-ready
	cd cloudflare && pnpm run build:observe && cd observe-worker && cf deploy --prebuilt --mode production

worker-bundle: node-ready
	cd cloudflare && pnpm build

worker-deploy: auth-ready work-ready worker-bundle observe-deploy
	@set -eu; \
	log='$(CURDIR)/.work/tmp/stats-deploy.log'; \
	status=0; (cd cloudflare && cf deploy --prebuilt --mode production $(if $(SECRETS_FILE),--secrets-file '$(SECRETS_FILE)')) > "$$log" 2>&1 || status=$$?; \
	cat "$$log"; test "$$status" -eq 0; \
	version=$$(sed -n 's/.*Current Version ID: \([0-9a-f-]*\).*/\1/p' "$$log" | tail -1); \
	test -n "$$version" || { echo 'cf deploy printed no version ID, so the source map was not registered' >&2; exit 1; }; \
	$(MAKE) observe-sourcemap VERSION="$$version"

observe-sourcemap: node-ready
	@test -n '$(VERSION)' || { echo 'VERSION is the stats Worker version ID' >&2; exit 1; }
	cd cloudflare && OBSERVE_URL='$(STATS_URL)/api/observe' OBSERVE_AUTH_COMMAND="cf access token '$(STATS_URL)'" OBSERVE_AUTH_HEADER=cf-access-token pnpm -s observe sourcemap '$(VERSION)' .cloudflare/output/v0/workers/default/bundle/index.js.map

worker-test: cloudflare-test dashboard-test lint

deploy: auth-ready
	$(MAKE) fixtures
	$(MAKE) worker-test
	$(MAKE) agent-test
	$(MAKE) worker-deploy
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
