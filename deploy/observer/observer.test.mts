import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Outbox } from './observer.mjs';

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
