import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Outbox, stateOutsideCandidate } from './observer.mjs';

test('outbox persists, deduplicates after restart and resolves without delivery', () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  try {
    new Outbox(dir).transition('health', true);
    const restarted = new Outbox(dir);
    restarted.transition('health', true);
    restarted.transition('health', false);
    new Outbox(dir).transition('health', false);
    const records = readFileSync(resolve(dir, 'alerts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(r => [r.condition, r.transition, r.delivery]), [['health', 'open', 'unconfigured'], ['health', 'resolve', 'unconfigured']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('state must be outside the candidate, which may be unreachable to the observer', () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  try {
    const candidate = resolve(dir, 'candidate'), state = resolve(dir, 'state'), locked = resolve(dir, 'locked');
    mkdirSync(resolve(candidate, 'state'), { recursive: true });
    mkdirSync(state);
    mkdirSync(resolve(locked, 'vm'), { recursive: true });
    assert.throws(() => stateOutsideCandidate(resolve(candidate, 'state'), candidate), /outside candidate/);
    assert.throws(() => stateOutsideCandidate(candidate, candidate), /outside candidate/);
    assert.equal(stateOutsideCandidate(state, candidate), realpathSync(state));
    assert.throws(() => stateOutsideCandidate(state, resolve(dir, 'missing')), { code: 'ENOENT' });
    chmodSync(locked, 0o000);
    try {
      assert.equal(stateOutsideCandidate(state, resolve(locked, 'vm')), realpathSync(state));
    } finally { chmodSync(locked, 0o700); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
