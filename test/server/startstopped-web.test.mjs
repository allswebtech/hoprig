// A terminal whose start was stopped before its shell read the line (the card's startStopped, src/server/deck.mjs): the
// session page says so in one plain sentence above the terminal, and never reads "Starting …" for it meanwhile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

test('a stopped start is said on the session page, and is not "Starting"', async () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  const line = /export const START_STOPPED = '([^']*)'/.exec(src);
  assert.ok(line, 'the sentence');
  assert.equal(line[1], 'The start was stopped before the coding tool ran. The conversation is free again: continue it in the App or start it again.');
  assert.match(src, /s\.startStopped \? h\('p\.sess-allowed\.sess-stopped', START_STOPPED\)/, 'shown for such a card only');
  assert.match(src, /fill\(needSlot, [^\n]*startStoppedNote\(s\)\);/, 'above the terminal');
  const { isStarting, markStarting } = await import('../../web/newsession.js');
  markStarting('', 'proj');
  assert.equal(isStarting({ name: 'proj', kind: 'shell' }, ''), true, 'just started, nothing reported yet');
  assert.equal(isStarting({ name: 'proj', kind: 'shell', startStopped: true }, ''), false, 'stopped: a terminal, not "Starting"');
});
