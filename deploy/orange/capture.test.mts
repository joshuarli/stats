import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve('deploy/orange/recovery/capture-engine.sh');

interface Guest { readonly dir: string; readonly state: string; readonly output: string; readonly env: NodeJS.ProcessEnv }

function guest(started: readonly string[] = ['native-stats', 'stats-infra-collector']): Guest {
  const dir = mkdtempSync(resolve('.work/tmp/capture-'));
  const state = join(dir, 'live-stats'), bin = join(dir, 'bin'), sim = join(dir, 'sim');
  for (const path of [join(state, 'log/a'), join(state, 'objects/b'), bin, sim]) mkdirSync(path, { recursive: true });
  writeFileSync(join(state, 'log/a/000001.log'), 'log');
  writeFileSync(join(state, 'objects/b/object'), 'object');
  writeFileSync(join(dir, 'engine.json'), '{}');
  writeFileSync(join(sim, 'engine'), 'running');
  for (const service of started) writeFileSync(join(sim, `svc-${service}`), '');
  const fake = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\nsim='${sim}'\n${body}\n`, { mode: 0o755 });
  fake('docker', `echo "docker $*" >>"$sim/calls"
case "$1" in
  inspect) case "$3" in
      *'/var/lib/rivet/log'*) echo '${state}/log' ;;
      *'/var/lib/rivet/objects'*) echo '${state}/objects' ;;
      *'/etc/rivet/config.json'*) echo '${dir}/engine.json' ;;
      *State.Running*) [ "$(cat "$sim/engine")" = running ] && echo true || echo false ;;
      *State.ExitCode*) echo 0 ;;
      *) echo 'image id' ;;
    esac ;;
  stop) echo stopped >"$sim/engine"; [ ! -e "$sim/kill-on-stop" ] || kill -9 "$PPID" ;;
  start) [ ! -e "$sim/fail-start" ] || exit 1; echo running >"$sim/engine" ;;
esac`);
  fake('rc-service', `echo "rc-service $*" >>"$sim/calls"
case "$2" in
  status) [ -e "$sim/svc-$1" ] ;;
  start) : >"$sim/svc-$1" ;;
  stop) rm -f "$sim/svc-$1" ;;
esac`);
  fake('wget', '[ "$(cat "$sim/engine")" = running ]');
  fake('rsync', `echo "rsync engine=$(cat "$sim/engine")" >>"$sim/calls"; [ ! -e "$sim/fail-final-copy" ] || exit 23; exec /usr/bin/rsync "$@"`);
  return { dir, state, output: join(dir, 'captures/one'), env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

const sim = (g: Guest, name: string) => join(g.dir, 'sim', name);
const run = (g: Guest, ...args: string[]) => spawnSync('sh', [SCRIPT, ...args], { env: g.env, encoding: 'utf8' });
const capture = (g: Guest) => { mkdirSync(join(g.dir, 'captures'), { recursive: true }); return run(g, 'capture', 'live-stats-engine', g.state, g.output); };
const mutations = (g: Guest) => readFileSync(sim(g, 'calls'), 'utf8').split('\n').filter(line => / (start|stop)( |$)/.test(line) && !line.includes('status'));
const running = (g: Guest) => ({ engine: readFileSync(sim(g, 'engine'), 'utf8').trim(), app: existsSync(sim(g, 'svc-native-stats')), collector: existsSync(sim(g, 'svc-stats-infra-collector')) });

test('capture stops the app before the Engine, restarts in reverse order and seals a checksummed depot', () => {
  const g = guest();
  try {
    const result = capture(g);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(mutations(g), ['rc-service stats-infra-collector stop', 'rc-service native-stats stop', 'docker stop --time 20 live-stats-engine', 'docker start live-stats-engine', 'rc-service native-stats start', 'rc-service stats-infra-collector start']);
    assert.deepEqual(running(g), { engine: 'running', app: true, collector: true });
    const copies = readFileSync(sim(g, 'calls'), 'utf8').split('\n').filter(line => line.startsWith('rsync'));
    assert.ok(copies.length > 0 && copies.every(line => line === 'rsync engine=stopped'), copies.join('; '));
    assert.equal(readFileSync(join(g.output, 'depot/objects/b/object'), 'utf8'), 'object');
    assert.match(readFileSync(join(g.output, 'depot.sha256'), 'utf8'), /\.\/log\/a\/000001\.log\n.*\.\/objects\/b\/object\n$/s);
    assert.equal(existsSync(join(g.state, '.capture-intent')), false);
  } finally { rmSync(g.dir, { recursive: true, force: true }); }
});

test('capture preserves a stopped app as stopped', () => {
  const g = guest([]);
  try {
    assert.equal(capture(g).status, 0);
    assert.deepEqual(running(g), { engine: 'running', app: false, collector: false });
    assert.deepEqual(mutations(g), ['docker stop --time 20 live-stats-engine', 'docker start live-stats-engine']);
  } finally { rmSync(g.dir, { recursive: true, force: true }); }
});

test('a failed stopped copy restores every service and publishes no capture', () => {
  const g = guest();
  try {
    writeFileSync(sim(g, 'fail-final-copy'), '');
    assert.notEqual(capture(g).status, 0);
    assert.deepEqual(running(g), { engine: 'running', app: true, collector: true });
    assert.equal(existsSync(g.output), false);
    assert.equal(existsSync(join(g.state, '.capture-intent')), false);
  } finally { rmSync(g.dir, { recursive: true, force: true }); }
});

test('a killed capture leaves its intent, refuses another capture, and recover restores the services', () => {
  const g = guest();
  try {
    writeFileSync(sim(g, 'kill-on-stop'), '');
    assert.notEqual(capture(g).status, 0);
    rmSync(sim(g, 'kill-on-stop'));
    assert.deepEqual(running(g), { engine: 'stopped', app: false, collector: false });
    assert.match(readFileSync(join(g.state, '.capture-intent'), 'utf8'), /^container live-stats-engine\nrunning live-stats-engine\nstarted stats-infra-collector\nstarted native-stats\n$/);
    rmSync(`${g.output}.partial`, { recursive: true });
    const again = capture(g);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /run recover first/);
    const recovered = run(g, 'recover', g.state);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(running(g), { engine: 'running', app: true, collector: true });
    assert.equal(existsSync(join(g.state, '.capture-intent')), false);
  } finally { rmSync(g.dir, { recursive: true, force: true }); }
});

test('a capture that cannot restart the Engine fails and keeps its intent for recover', () => {
  const g = guest();
  try {
    writeFileSync(sim(g, 'fail-start'), '');
    const result = capture(g);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /run recover/);
    assert.equal(existsSync(join(g.state, '.capture-intent')), true);
    assert.deepEqual(running(g), { engine: 'stopped', app: false, collector: false });
  } finally { rmSync(g.dir, { recursive: true, force: true }); }
});

function driver(captureStatus: number) {
  const dir = mkdtempSync(resolve('.work/tmp/capture-driver-'));
  const bin = join(dir, 'bin'), calls = join(dir, 'calls');
  mkdirSync(bin);
  const fake = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fake('rollout', `echo "rollout $*" >>'${calls}'
case "$1" in
  observe) echo '{"selected":"app-aaaaaaaaaaaa","running":"app-aaaaaaaaaaaa","collector_running":"app-aaaaaaaaaaaa","digest":"sha256:d","healthy":true,"processes":[{"pid":1,"started_at":10}]}' ;;
  lease) case "$*" in *"--operation engine-capture "*) exit ${captureStatus} ;; esac ;;
esac`);
  fake('ssh', `echo "ssh $*" >>'${calls}'; case "$*" in *sha256sum*) echo "abc123  /x" ;; *) cat >/dev/null ;; esac`);
  fake('statsctl', `echo '{"payload":{"hosts":[{"name":"lisa","state":"reporting"}]}}'`);
  writeFileSync(join(dir, 'ssh_config'), '');
  const result = spawnSync('sh', ['deploy/orange/recovery/capture-standby.sh', 'one'], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, STANDBY_SSH_CONFIG: join(dir, 'ssh_config'), STATS_ROLLOUT: join(bin, 'rollout'), STATS_CHECK_HOSTS: 'lisa', STATSCTL: join(bin, 'statsctl') } });
  const receipt = join(dir, '.local/state/openorange/captures/one.json');
  return { dir, result, calls: readFileSync(calls, 'utf8'), receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : undefined };
}

test('the capture driver records a capture only after the app passes its functional check', () => {
  const { dir, result, calls, receipt } = driver(0);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls, /lease run --target-kind native --host stats-standby .*--operation engine-capture --bound-s 900 -- sh \/var\/lib\/live-stats-recovery\/.capture-engine.sh capture live-stats-engine \/var\/lib\/live-stats \/var\/lib\/live-stats-recovery\/one/);
    assert.doesNotMatch(calls, /engine-capture-recover/);
    assert.equal(receipt.outcome, 'captured');
    assert.equal(receipt.depotManifestSha256, 'sha256:abc123');
    assert.deepEqual(receipt.app, { release: 'app-aaaaaaaaaaaa', digest: 'sha256:d' });
    assert.equal(receipt.functional.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed capture is recovered under a new lease and recorded as failed', () => {
  const { dir, result, calls, receipt } = driver(1);
  try {
    assert.equal(result.status, 1);
    assert.match(calls, /--operation engine-capture-recover --bound-s 300 -- sh \S+ recover \/var\/lib\/live-stats/);
    assert.equal(receipt.outcome, 'failed');
    assert.equal(receipt.captureExit, 1);
    assert.equal(receipt.recoverExit, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a held lease changes nothing and writes no receipt', () => {
  const { dir, result, calls, receipt } = driver(4);
  try {
    assert.equal(result.status, 4);
    assert.doesNotMatch(calls, /engine-capture-recover/);
    assert.equal(receipt, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
