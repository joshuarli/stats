import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('functional check detects identity change and failed host freshness', () => {
  const dir = mkdtempSync(resolve('.work/tmp/functional-'));
  try {
    const rollout = resolve(dir, 'rollout.cjs'); const statsctl = resolve(dir, 'statsctl.cjs'); const counter = resolve(dir, 'counter');
    writeFileSync(rollout, `#!/usr/bin/env node\nconst fs=require('fs'); let n=0; try { n=+fs.readFileSync(${JSON.stringify(counter)},'utf8'); } catch {} fs.writeFileSync(${JSON.stringify(counter)},String(n+1)); console.log(JSON.stringify({selected:'r',running:'r',digest:'d',healthy:true,processes:[{pid:process.env.CHANGE && n ? 2 : 1,started_at:10}]}));\n`, { mode: 0o755 });
    writeFileSync(statsctl, `#!/usr/bin/env node\nconsole.log(JSON.stringify({payload:{hosts:[{name:'lisa',state:process.env.FAIL?'stale':'reporting'}]}}));\n`, { mode: 0o755 });
    const env = { ...process.env, STATS_ROLLOUT: rollout, STANDBY_SSH_CONFIG: 'config', STATS_ROLLOUT_HOST: 'host', STATS_CHECK_HOSTS: 'lisa', STATSCTL: statsctl, ROLLOUT_RELEASE: 'r', ROLLOUT_DIGEST: 'd' };
    const run = extra => spawnSync(process.execPath, ['deploy/orange/functional-check.mjs', '--target-kind', 'native'], { env: { ...env, ...extra }, encoding: 'utf8' });
    const success = run({}); assert.equal(success.status, 0, success.stdout + success.stderr);
    writeFileSync(counter, '0');
    assert.equal(JSON.parse(run({ CHANGE: '1' }).stdout).ok, false);
    const failed = run({ FAIL: '1' }); assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).ok, false);
    const argvOnly = spawnSync(process.execPath, ['deploy/orange/functional-check.mjs', '--target-kind', 'native', '--rollout', rollout, '--ssh-config', 'config', '--host', 'host', '--hosts', 'lisa', '--statsctl', statsctl], { env: { PATH: process.env.PATH, ROLLOUT_RELEASE: 'r', ROLLOUT_DIGEST: 'd' }, encoding: 'utf8' });
    assert.equal(argvOnly.status, 0, argvOnly.stdout + argvOnly.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native-app functional check requires the collector on the release', () => {
  const dir = mkdtempSync(resolve('.work/tmp/functional-app-'));
  try {
    const rollout = resolve(dir, 'rollout.cjs'); const statsctl = resolve(dir, 'statsctl.cjs');
    writeFileSync(rollout, `#!/usr/bin/env node\nif (!process.argv.includes('native-app')) process.exit(9); console.log(JSON.stringify({selected:'r',running:'r',collector_running:process.env.COLLECTOR,digest:'d',healthy:true,processes:[{pid:1,started_at:10}]}));\n`, { mode: 0o755 });
    writeFileSync(statsctl, `#!/usr/bin/env node\nconsole.log(JSON.stringify({payload:{hosts:[{name:'lisa',state:'reporting'}]}}));\n`, { mode: 0o755 });
    const run = (collector: string) => spawnSync(process.execPath, ['deploy/orange/functional-check.mjs', '--target-kind', 'native-app', '--rollout', rollout, '--ssh-config', 'config', '--host', 'host', '--hosts', 'lisa', '--statsctl', statsctl], { env: { PATH: process.env.PATH, ROLLOUT_RELEASE: 'r', ROLLOUT_DIGEST: 'd', COLLECTOR: collector }, encoding: 'utf8' });
    assert.equal(run('r').status, 0);
    const stale = run('previous');
    assert.equal(stale.status, 1);
    assert.match(JSON.parse(stale.stdout).steps.at(-1).detail, /identity mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
