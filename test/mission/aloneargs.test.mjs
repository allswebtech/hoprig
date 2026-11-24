// A session started without the box's tool (missions off, no box on this computer, no test command, a role whose
// check is not its tests, a review) gets the start arguments it got before the tool existed, byte for byte. The
// fixture holds aloneArgs of the tree before the tool was added, for each kind of start; aloneArgs is pure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { missionHome } from './helpers.mjs';

const t = missionHome('mission-aloneargs');
test.after(() => t.cleanup());
const { aloneArgs } = await import('../../src/work/alone.mjs');
const base = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'alone-args-base.json'), 'utf8'));

test('every start without the tool is the base\'s, the whole line, byte for byte', () => {
  assert.ok(Object.keys(base).length >= 6);
  for (const [what, { given, args }] of Object.entries(base)) {
    assert.equal(JSON.stringify(aloneArgs(given)), JSON.stringify(args), what);
    assert.equal(JSON.stringify(aloneArgs({ ...given, tool: null })), JSON.stringify(args), `${what}, with no tool given`);
  }
});

test('a tool given to a start that is not restricted changes nothing: only a mission\'s restricted start can carry it', () => {
  for (const [what, { given, args }] of Object.entries(base)) {
    if (Array.isArray(given.restricted) && given.restricted.length) continue;
    assert.equal(JSON.stringify(aloneArgs({ ...given, tool: { url: 'http://127.0.0.1:1', token: `hbt_${'a'.repeat(43)}` } })), JSON.stringify(args), what);
  }
});
