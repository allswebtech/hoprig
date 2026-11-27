// A mend that costs nothing is one line in Activity (the automations' log), not only a line in the Operator's own
// timeline: with Tia off her tab is hidden, and Activity is where the owner sees that Hoprig mended something.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { timeline } = await import('../../src/operator/feature.mjs');

test('a mend by a rule that costs nothing, when it worked, is one Activity line saying what was mended', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mendact-'));
  try {
    const t = timeline({ file: () => path.join(root, 'operator', 'timeline.jsonl') });
    t.add({ at: new Date().toISOString(), by: 'gateway', item: 'provider-1', kind: 'provider', subject: 'gateway gw1', act: 'restart-gateway', ok: true, result: 'restarted gw1' });
    t.add({ at: new Date().toISOString(), by: 'gateway', item: 'provider-1', kind: 'provider', subject: 'gateway gw1', act: 'restart-gateway', ok: false, refused: true, result: 'she waits 2 min' });
    t.add({ at: new Date().toISOString(), by: 'limit', item: 'limit-1', kind: 'limit', subject: 'session shop', act: 'switch', ok: true, result: 'moved shop to alt' });
    t.add({ at: new Date().toISOString(), item: 'limit-1', kind: 'limit', subject: 'session shop', act: 'switch', ok: true, result: 'by a tap' });
    const lines = fs.readFileSync(path.join(root, 'automation.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0].did, /^Mended: .*restarted gw1/);
    assert.equal(lines[0].outcome, 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
