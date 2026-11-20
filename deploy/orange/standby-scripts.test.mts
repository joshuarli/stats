import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('standby scripts refuse mutation without rollout lease', () => {
  const dir = mkdtempSync(resolve('.work/tmp/lease-'));
  try {
    const config = resolve(dir, 'ssh'); const marker = resolve(dir, 'mutation');
    writeFileSync(config, '');
    writeFileSync(resolve(dir, 'ssh'), '#!/bin/sh\necho unexpected-ssh >&2\nexit 1\n', { mode: 0o755 });
    const rollout = resolve(dir, 'rollout');
    writeFileSync(rollout, `#!/bin/sh\ntouch '${marker}'\nexit 4\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, STANDBY_SSH_CONFIG: config };
    for (const script of ['deploy/orange/standby-deploy.sh', 'deploy/orange/collector/install.sh']) {
      const run = spawnSync('sh', [script], { env: { ...env, STATS_ROLLOUT: '' }, encoding: 'utf8' });
      assert.notEqual(run.status, 0, run.stdout + run.stderr);
      assert.equal(existsSync(marker), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('held lease prevents guest mutations for deploy and collector', () => {
  const dir = mkdtempSync(resolve('.work/tmp/lease-held-'));
  try {
    const config = resolve(dir, 'config'); const calls = resolve(dir, 'calls'); const mutations = resolve(dir, 'mutations');
    writeFileSync(config, '');
    const fake = (name, body) => writeFileSync(resolve(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fake('ssh', `case "$*" in *"cat >"*) exit 1;; *"grep -o"*) echo stats-aaaaaaaaaaaa;; *"sha256sum"*) echo same;; *"recovery-routes"*) echo writer;; esac`);
    fake('jaq', 'cat');
    fake('shasum', 'echo same');
    fake('git', `case "$*" in *status*) :;; *rev-parse*) echo bbbbbbbbbbbb;; esac`);
    fake('sh', `case "$1" in *build-context.sh) mkdir -p "$2/app"; printf '"APPLICATION_EVENTS_RELEASE": "stats-bbbbbbbbbbbb"' >"$2/app/stats.jsonc"; touch "$2/app/stats" "$2/app/observe" "$2/app/observe.jsonc";; *collector/install.sh) touch "$3/collector.tgz" "$3/collector-install.sh";; *) exec /bin/sh "$@";; esac`);
    fake('node', 'mkdir -p "$3"; touch "$3/main.mjs" "$3/manifest.json"');
    fake('tar', 'while [ "$#" -gt 0 ]; do case "$1" in -czf) shift; touch "$1"; exit 0;; esac; shift; done');
    fake('rollout', `printf '%s\\n' "$*" >>'${calls}'; exit 4`);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, STANDBY_SSH_CONFIG: config, STATS_ROLLOUT: resolve(dir, 'rollout') };
    for (const script of ['deploy/orange/standby-deploy.sh', 'deploy/orange/collector/install.sh']) {
      const run = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' });
      assert.notEqual(run.status, 0, run.stdout + run.stderr);
    }
    const recorded = readFileSync(calls, 'utf8');
    assert.match(recorded, /--operation stats-deploy --bound-s 300/);
    assert.match(recorded, /--operation collector-install --bound-s 300/);
    assert.equal(existsSync(mutations), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
