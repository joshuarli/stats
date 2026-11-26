import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deployStandby, type Run, type RunOptions, type StandbyEffects } from './standby-deploy.mts';
import { appDigest, appReleaseId } from './qualification/manifest.mts';

test('collector provisioning refuses mutation without rollout lease', () => {
  const dir = mkdtempSync(resolve('.work/tmp/lease-'));
  try {
    const config = resolve(dir, 'ssh'); const marker = resolve(dir, 'mutation');
    writeFileSync(config, '');
    writeFileSync(resolve(dir, 'ssh'), '#!/bin/sh\necho unexpected-ssh >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(resolve(dir, 'rollout'), `#!/bin/sh\ntouch '${marker}'\nexit 4\n`, { mode: 0o755 });
    const run = spawnSync('sh', ['deploy/orange/collector/install.sh'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STANDBY_SSH_CONFIG: config, STATS_ROLLOUT: '' }, encoding: 'utf8' });
    assert.notEqual(run.status, 0, run.stdout + run.stderr);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('held lease prevents collector provisioning', () => {
  const dir = mkdtempSync(resolve('.work/tmp/lease-held-'));
  try {
    const config = resolve(dir, 'config'); const calls = resolve(dir, 'calls');
    writeFileSync(config, '');
    const fake = (name: string, body: string) => writeFileSync(resolve(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fake('ssh', 'cat >/dev/null');
    fake('rollout', `printf '%s\\n' "$*" >>'${calls}'; exit 4`);
    const run = spawnSync('/bin/sh', ['deploy/orange/collector/install.sh'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STANDBY_SSH_CONFIG: config, STATS_ROLLOUT: resolve(dir, 'rollout') }, encoding: 'utf8' });
    assert.notEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(readFileSync(calls, 'utf8'), /lease run --target-kind native --host stats-standby .* --operation collector-install --bound-s 300/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const RUNTIME = `sha256:${'1'.repeat(64)}`;
const BASELINE_DIGEST = `sha256:${'2'.repeat(64)}`;
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function writeBuiltContext(app: string) {
  mkdirSync(join(app, 'stats/bundle'), { recursive: true }); mkdirSync(join(app, 'observe'), { recursive: true });
  writeFileSync(join(app, 'stats/bundle/index.js'), 'stats');
  writeFileSync(join(app, 'stats.jsonc'), `{"vars":{"APPLICATION_EVENTS_RELEASE": "stats-${COMMIT.slice(0, 12)}"}}`);
  writeFileSync(join(app, 'observe.jsonc'), '{}');
}
function writeCollector(dir: string) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'main.mjs'), 'collector'); }
const CANDIDATE_DIGEST = (() => {
  const dir = mkdtempSync(resolve('.work/tmp/standby-expected-'));
  try { writeBuiltContext(dir); writeCollector(join(dir, 'collector')); return appDigest(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
})();
const CANDIDATE = appReleaseId(CANDIDATE_DIGEST);

interface Fixture { readonly root: string; readonly calls: string[][]; readonly effects: (overrides?: Partial<Behaviour>) => StandbyEffects }
interface Behaviour {
  readonly observed: Record<string, unknown>;
  readonly authorityOk: boolean;
  readonly failCheck: string | undefined;
  readonly stagedDigest: string | undefined;
  readonly startStatus: number;
}

function fixture(): Fixture {
  const root = mkdtempSync(resolve('.work/tmp/standby-deploy-'));
  mkdirSync(join(root, 'deploy/orange'), { recursive: true });
  for (const name of ['package.json', 'pnpm-lock.yaml', 'functional-check.mjs', 'writer-authority.mjs']) writeFileSync(join(root, 'deploy/orange', name), name);
  const calls: string[][] = [];
  const effects = (overrides: Partial<Behaviour> = {}): StandbyEffects => {
    const behaviour: Behaviour = { observed: { selected: 'app-aaaaaaaaaaaa', running: 'app-aaaaaaaaaaaa', digest: BASELINE_DIGEST, components: { runtime: RUNTIME } }, authorityOk: true, failCheck: undefined, stagedDigest: undefined, startStatus: 0, ...overrides };
    const run = (file: string, args: readonly string[], { log }: RunOptions): Run => {
      calls.push([file, ...args]);
      if (log) writeFileSync(log, `log of ${file}\n`, { flag: 'wx' });
      const ok = (stdout = ''): Run => ({ status: 0, stdout });
      if (file === 'rollout' && args[0] === 'observe') return ok(JSON.stringify(behaviour.observed));
      if (args[0]?.endsWith('writer-authority.mjs')) return behaviour.authorityOk ? ok('{"ok":true,"authority":{"mode":"writer"}}') : { status: 1, stdout: '{"ok":false}' };
      if (file === 'ssh') return ok(`${sha('package.json')}  /opt/native-rehearsal/orange/package.json\n${sha('pnpm-lock.yaml')}  /opt/native-rehearsal/orange/pnpm-lock.yaml\n`);
      if (file === 'git') return ok(args.includes('--porcelain') ? '' : `${COMMIT}\n`);
      const check = args[0] === 'deploy/orange/build-context.sh' ? 'build' : args[0] === 'cloudflare/scripts/build-infra-collector.mjs' ? 'collector-build' : file === 'make' ? 'cloudflare-test' : undefined;
      if (check !== undefined) {
        if (check === behaviour.failCheck) return { status: 2, stdout: '' };
        if (check === 'build') writeBuiltContext(join(args[1]!, 'app'));
        if (check === 'collector-build') writeCollector(args[2]!);
        return ok();
      }
      if (file === 'rollout' && args[0] === 'stage') {
        const dir = args[args.indexOf('--dir') + 1]!;
        assert.deepEqual(readdirSync(dir).sort(), ['collector', 'observe', 'observe.jsonc', 'stats', 'stats.jsonc']);
        const digest = behaviour.stagedDigest ?? appDigest(dir);
        return ok(JSON.stringify({ release: appReleaseId(digest), digest }));
      }
      if (file === 'rollout' && args[0] === 'start') return { status: behaviour.startStatus, stdout: '{"run_id":"r","run":"/journals/r"}\n{"state":"x"}\n' };
      throw new Error(`unexpected command ${file} ${args.join(' ')}`);
    };
    return { mode: 'deploy', root, state: join(root, 'state'), sshConfig: '/cfg/ssh_config', rollout: 'rollout', hosts: 'lisa,threadripper', statsctl: '/tools/statsctl', node: 'node', run, report: () => {}, now: () => Date.UTC(2026, 10, 21, 23, 30) };
  };
  return { root, calls, effects };
}

const mutating = (calls: string[][]) => calls.filter(call => call[0] === 'rollout' && (call[1] === 'stage' || call[1] === 'start'));

test('check mode reads identity, authority and pins without building or staging', () => {
  const { root, calls, effects } = fixture();
  try {
    assert.equal(deployStandby({ ...effects(), mode: 'check' }), 'checked');
    assert.deepEqual(calls.map(call => call[0] === 'rollout' ? call[1] : call[0]), ['observe', 'node', 'ssh']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown running identity or refused writer authority stops before any build', () => {
  const { root, calls, effects } = fixture();
  try {
    assert.throws(() => deployStandby(effects({ observed: { selected: 'app-aaaaaaaaaaaa', running: null, digest: BASELINE_DIGEST, components: { runtime: RUNTIME } } })), /runs null/);
    assert.throws(() => deployStandby(effects({ observed: { selected: 'app-aaaaaaaaaaaa', running: 'app-aaaaaaaaaaaa', digest: BASELINE_DIGEST, components: {} } })), /selected runtime is unknown/);
    assert.throws(() => deployStandby(effects({ authorityOk: false })), /reading writer authority failed/);
    assert.equal(calls.some(call => call[0] === 'make' || call[0] === 'sh'), false);
    assert.deepEqual(mutating(calls), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed admission check stops before staging', () => {
  const { root, calls, effects } = fixture();
  try {
    assert.throws(() => deployStandby(effects({ failCheck: 'cloudflare-test' })), /admission check cloudflare-test failed/);
    assert.deepEqual(mutating(calls), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unchanged app release is not started', () => {
  const { root, calls, effects } = fixture();
  try {
    assert.equal(deployStandby(effects({ observed: { selected: CANDIDATE, running: CANDIDATE, digest: CANDIDATE_DIGEST, components: { runtime: RUNTIME } } })), 'unchanged');
    assert.deepEqual(mutating(calls).map(call => call[1]), ['stage']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deploy starts one native-app transaction bound to the staged digest, runtime and admission evidence', () => {
  const { root, calls, effects } = fixture();
  try {
    assert.equal(deployStandby(effects({ startStatus: 4 })), 'lock-held');
    const start = mutating(calls).find(call => call[1] === 'start')!;
    const flag = (name: string) => start[start.indexOf(`--${name}`) + 1]!;
    assert.equal(flag('target-kind'), 'native-app');
    assert.equal(flag('baseline'), 'app-aaaaaaaaaaaa');
    assert.equal(flag('candidate'), CANDIDATE);
    assert.equal(flag('artifact'), CANDIDATE_DIGEST);
    assert.equal(start.includes('--evaluator'), false);
    const policy = JSON.parse(readFileSync(flag('policy'), 'utf8'));
    assert.deepEqual(policy.functional_check.argv.slice(2, 4), ['--target-kind', 'native-app']);
    assert.equal(policy.ready_s, 120);
    assert.deepEqual(policy.authority_check.argv.slice(2), ['--route-host', 'lisa']);
    assert.ok(existsSync(policy.functional_check.argv[1]) && existsSync(policy.authority_check.argv[1]));
    const receipt = JSON.parse(readFileSync(flag('receipt'), 'utf8'));
    assert.equal(receipt.schema, 'stats-app-admission/1');
    assert.deepEqual(receipt.baseline, { releaseId: 'app-aaaaaaaaaaaa', artifactDigest: BASELINE_DIGEST });
    assert.deepEqual(receipt.candidate, { releaseId: CANDIDATE, artifactDigest: CANDIDATE_DIGEST, components: { runtime: RUNTIME } });
    assert.deepEqual(receipt.source, { repository: 'joshuarli/stats', commit: COMMIT });
    assert.deepEqual(receipt.checks.map((check: { name: string; exitCode: number }) => [check.name, check.exitCode]), [['build', 0], ['collector-build', 0], ['cloudflare-test', 0]]);
    assert.deepEqual(receipt.inputs.map((item: { path: string }) => item.path), ['build.log', 'cloudflare-test.log', 'collector-build.log']);
    for (const item of receipt.inputs) assert.equal(sha(readFileSync(join(flag('evidence-dir'), item.path))), item.sha256);
    assert.equal(receipt.decision.verdict, 'admitted');
    assert.deepEqual(readdirSync(join(root, '.work/tmp')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a guest that staged different bytes stops the deploy before start', () => {
  const { root, calls, effects } = fixture();
  try {
    assert.throws(() => deployStandby(effects({ stagedDigest: `sha256:${'9'.repeat(64)}` })), /not the local build/);
    assert.deepEqual(mutating(calls).map(call => call[1]), ['stage']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
