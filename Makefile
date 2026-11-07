.DEFAULT_GOAL := check

STATS_DOMAIN ?= stats.17166969.xyz
STATS_URL ?= https://$(STATS_DOMAIN)
SECRETS_FILE ?=
SSH ?= local
STUFF_DIR ?= ../stuff
export STATS_DOMAIN
export STATS_URL

.PHONY: work-ready node-ready auth-ready fixtures fixtures-write ingest-bench smoke-local dev-local reset-local integration-local integration-producer bench-local observe-bundle agent-e2e node-e2e agent-test agent-build agent-build-macos add-host add-host-check cloudflare-test dashboard-test dashboard-bench lint worker-check worker-bundle observe-deploy observe-sourcemap worker-deploy stats-deploy worker-test deploy deploy-hosts push-hosts deploy-threadripper node-deploy smoke-deployed release release-artifacts build-statsctl publish-producer publish-producer-crate check preview
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

fixtures-write: work-ready node-ready
	node scripts/fixture-sources.mjs --write
	cd agent && STATS_WRITE_FIXTURES=1 TMPDIR='$(CURDIR)/.work/tmp' cargo test --test conformance the_encoder_reproduces_every_golden_frame_from_its_semantic_source
	cd cloudflare && STATS_WRITE_FIXTURES=1 node --experimental-strip-types --test test/ingest/acks.test.ts
	node scripts/check-fixtures.mjs

agent-test: work-ready
	cd agent && TMPDIR='$(CURDIR)/.work/tmp' cargo test --all-targets

agent-build: work-ready
	TMPDIR='$(CURDIR)/.work/tmp' agent/scripts/build-static.sh

agent-build-macos: work-ready
	cd agent && TMPDIR='$(CURDIR)/.work/tmp' cargo build --release

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
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry build:all
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry test:ui

dashboard-bench: work-ready node-ready
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry build
	@set -eu; \
	TMPDIR='$(CURDIR)/.work/tmp' node cloudflare/scripts/preview.mjs > .work/tmp/preview-bench.log 2>&1 & \
	pid=$$!; \
	trap 'kill $$pid 2>/dev/null || true' EXIT; \
	node -e 'const url = (process.env.BASE ?? `http://127.0.0.1:$${process.env.PREVIEW_PORT ?? 4174}`) + "/api/v1/hosts"; const deadline = Date.now() + 10000; (async () => { while (Date.now() < deadline) { try { const r = await fetch(url); if (r.ok) process.exit(0); } catch {} await new Promise(r => setTimeout(r, 25)); } console.error("preview did not become ready:", url); process.exit(1); })();'; \
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry exec node scripts/bench-ui.mjs $(BENCH_ARGS)

preview: work-ready node-ready
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry build
	TMPDIR='$(CURDIR)/.work/tmp' node cloudflare/scripts/preview.mjs

lint: node-ready
	pnpm --filter @stats/telemetry lint

auth-ready:
	@cf -q auth whoami >/dev/null

worker-check: node-ready
	cd cloudflare && pnpm build && cf -q deploy --prebuilt --dry-run --mode production
	cd cloudflare && pnpm run build:observe && cd observe-worker && cf -q deploy --prebuilt --dry-run --mode production

observe-deploy: auth-ready node-ready
	cd cloudflare && pnpm run build:observe && cd observe-worker && cf -q deploy --prebuilt --mode production

worker-bundle: node-ready
	cd cloudflare && pnpm build

observe-bundle: node-ready
	cd cloudflare && pnpm run build:observe

worker-deploy: auth-ready work-ready worker-bundle observe-deploy stats-deploy

stats-deploy: auth-ready work-ready worker-bundle
	@set -eu; \
	(cd cloudflare && cf -q deploy --prebuilt --mode production $(if $(SECRETS_FILE),--secrets-file '$(SECRETS_FILE)')); \
	version=$$(cd cloudflare && cf -q workers deployments list --worker stats --per-page 1 | jaq -er '.deployments[0].versions | if length == 1 and .[0].percentage == 100 then .[0].version_id else error("the latest stats deployment does not serve one version at 100%, so the source map was not registered") end'); \
	$(MAKE) observe-sourcemap VERSION="$$version"

observe-sourcemap: node-ready
	@test -n '$(VERSION)' || { echo 'VERSION is the stats Worker version ID' >&2; exit 1; }
	cd cloudflare && OBSERVE_URL='$(STATS_URL)/api/observe/stats' OBSERVE_AUTH_COMMAND="cf -q access token '$(STATS_URL)'" OBSERVE_AUTH_HEADER=cf-access-token pnpm -s observe sourcemap '$(VERSION)' .cloudflare/output/v0/workers/default/bundle/index.js.map

worker-test: work-ready node-ready
	@test -z "$$(git ls-files '*.png')" || { echo 'PNG files must not be tracked; use webp' >&2; git ls-files '*.png' >&2; exit 1; }
	TMPDIR='$(CURDIR)/.work/tmp' pnpm --filter @stats/telemetry test:all

deploy: auth-ready work-ready
	@scripts/step.sh 'fixtures' $(MAKE) --no-print-directory fixtures
	@scripts/step.sh 'worker tests' $(MAKE) --no-print-directory worker-test
	@scripts/step.sh 'agent tests' $(MAKE) --no-print-directory agent-test
	@scripts/step.sh 'agent build' $(MAKE) --no-print-directory agent-build
	@scripts/step.sh -s 'Current Version ID|\(custom domain\)' 'worker deploy' $(MAKE) --no-print-directory worker-deploy
	@scripts/step.sh -s '^OK' 'smoke' $(MAKE) --no-print-directory smoke-deployed
	@$(MAKE) --no-print-directory push-hosts

deploy-hosts: agent-test agent-build
	@$(MAKE) --no-print-directory push-hosts

push-hosts:
	@set -eu; \
	hosts="$$(jaq -er '.hosts | keys[]' deploy/hosts.json)"; \
	test -n "$$hosts" || { echo 'no hosts in deploy/hosts.json' >&2; exit 1; }; \
	for host in $$hosts; do deploy/deploy-host.sh "$$host"; done

deploy-host-%: agent-test agent-build
	deploy/deploy-host.sh '$*'

rollback-host-%:
	deploy/deploy-host.sh '$*' --rollback

deploy-threadripper: deploy-host-threadripper

ingest-bench: work-ready node-ready
	TMPDIR='$(CURDIR)/.work/tmp' bench/ingest.sh

bench-local: work-ready node-ready
	@cd cloudflare && pnpm -s build >&2 && pnpm -s run build:observe >&2 && TMPDIR='$(CURDIR)/.work/tmp' node bench/local.ts

smoke-deployed:
	STATS_URL='$(STATS_URL)' deploy/deployed-smoke.sh

smoke-local: work-ready node-ready worker-bundle observe-bundle
	cd cloudflare && TMPDIR='$(CURDIR)/.work/tmp' node scripts/local-stack.mjs run -- ../deploy/deployed-smoke.sh

dev-local: work-ready node-ready worker-bundle observe-bundle
	cd cloudflare && TMPDIR='$(CURDIR)/.work/tmp' node scripts/local-stack.mjs dev

reset-local:
	rm -rf '$(CURDIR)/.work/local/state'

integration-local: work-ready node-ready worker-bundle observe-bundle
	@set -eu; \
	shim='$(CURDIR)/.work/tmp/cf-shim'; \
	rm -rf "$$shim"; mkdir -p "$$shim"; \
	printf '#!/bin/sh\necho "cf $$*" >> "%s/calls"\nexit 99\n' "$$shim" > "$$shim/cf"; chmod +x "$$shim/cf"; \
	cd cloudflare; \
	PATH="$$shim:$$PATH" TMPDIR='$(CURDIR)/.work/tmp' ../scripts/offline-run.sh node --experimental-strip-types --test test/local/*.test.ts; \
	PATH="$$shim:$$PATH" TMPDIR='$(CURDIR)/.work/tmp' ../scripts/offline-run.sh node_modules/.bin/playwright test test/ui/local-stack.spec.ts --project desktop; \
	if [ -e "$$shim/calls" ]; then echo "cf was called:" >&2; cat "$$shim/calls" >&2; exit 1; fi; \
	echo "offline layers: app (the stack fails on any undeclared outbound request), os (sandbox-exec denies non-loopback network for tests and browser), credentials (CLOUDFLARE_* and CF_* removed, cf never called)"

integration-producer: work-ready node-ready worker-bundle observe-bundle
	cd cloudflare && TMPDIR='$(CURDIR)/.work/tmp' ../scripts/offline-run.sh node --experimental-strip-types --test test/producer/*.test.ts

agent-e2e: work-ready node-ready worker-bundle
	cd agent && TMPDIR='$(CURDIR)/.work/tmp' cargo build
	cd cloudflare && TMPDIR='$(CURDIR)/.work/tmp' pnpm run test:agent-e2e

node-deploy: work-ready node-ready
	deploy/node/deploy.sh $(or $(HOST),josh@threadripper) > .work/tmp/node-deploy.log 2>&1 || { tail -20 .work/tmp/node-deploy.log; exit 1; }
	tail -1 .work/tmp/node-deploy.log

node-e2e: work-ready node-ready worker-bundle
	cd agent && TMPDIR='$(CURDIR)/.work/tmp' cargo build
	cd cloudflare && TMPDIR='$(CURDIR)/.work/tmp' pnpm run test:node-e2e

release: agent-build

build-statsctl: work-ready node-ready
	@scripts/build-statsctl.sh
	@cp dist/statsctl-$$(grep '^version' agent/Cargo.toml | head -1 | sed -n 's/version = "\(.*\)"/\1/p').mjs dist/statsctl.mjs 2>/dev/null || true

publish-producer: work-ready node-ready
	cd $(CURDIR) && LOCKFILE=pnpm-lock.yaml PROJECT=stats-producer STUFF_DIR='$(STUFF_DIR)' sh '$(STUFF_DIR)'/deploy/publish mynpm

publish-producer-crate: work-ready
	cd $(CURDIR) && CRATES='stats-producer' STUFF_DIR='$(STUFF_DIR)' sh '$(STUFF_DIR)'/deploy/publish mycrates

release-artifacts: work-ready node-ready
	@set -eu; \
	mkdir -p dist; \
	case "$$(uname -s)" in \
	  Darwin) agent/scripts/build-release.sh ;; \
	  Linux) agent/scripts/build-static.sh ;; \
	  *) echo "unsupported platform for agent release build" >&2; exit 1 ;; \
	esac; \
	$(MAKE) --no-print-directory build-statsctl; \
	cp install.sh dist/install.sh; \
	cp agent/dist/stats-* dist/ 2>/dev/null || true; \
	if [ -f agent/dist/SHA256SUMS ]; then cp agent/dist/SHA256SUMS dist/SHA256SUMS.agent; fi; \
	if [ -f dist/SHA256SUMS.statsctl ]; then :; fi; \
	cat dist/SHA256SUMS.agent dist/SHA256SUMS.statsctl > dist/SHA256SUMS 2>/dev/null || true; \
	ls -lh dist/

OFFLINE_SANDBOX_CHECK := $(if $(filter Darwin,$(shell uname -s)),integration-local,)

check: fixtures agent-test release cloudflare-test agent-e2e node-e2e smoke-local dashboard-test lint $(OFFLINE_SANDBOX_CHECK)
