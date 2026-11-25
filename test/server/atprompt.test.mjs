// Whether a terminal's shell waits at its prompt (src/server/backends/front.mjs atPrompt): in front of its terminal,
// asleep, and with no program of its own. A login shell still in its start files is in front too, so the two other
// facts decide. Recorded answers of the system, for Linux and for macOS.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('atprompt');
test.after(() => box.cleanup());
const { atPrompt } = await import('../../src/server/backends/front.mjs');

const linux = (stat, children = { 7: '' }) => ({
  platform: 'linux',
  read: (p) => {
    if (p.endsWith('/stat')) return stat;
    const t = /task\/(\d+)\/children$/.exec(p);
    if (t) return children[t[1]];
    throw new Error(`not read in this test: ${p}`);
  },
  list: () => Object.keys(children),
});

test('Linux: at its prompt only in front, asleep and with no program of its own', () => {
  assert.equal(atPrompt(7, linux('7 (bash) S 1 7 7 34816 7 4194304 0')), true, 'waits for a line');
  assert.equal(atPrompt(7, linux('7 (bash) S 1 7 7 34816 7 4194304 0', { 7: '9 ' })), false, 'a start file runs a program (sleep)');
  assert.equal(atPrompt(7, linux('7 (bash) R 1 7 7 34816 7 4194304 0')), false, 'a start file busy with the shell\'s own commands');
  assert.equal(atPrompt(7, linux('7 (bash) S 1 7 7 34816 12 4194304 0')), false, 'a program in front (the launcher)');
  assert.equal(atPrompt(7, linux('7 (bash) S 1 7 7 0 -1 4194304 0')), false, 'no terminal');
  assert.equal(atPrompt(7, { platform: 'linux', read: () => { throw new Error('ENOENT'); }, list: () => [] }), false, 'gone');
  assert.equal(atPrompt(0, linux('')), false);
  assert.equal(atPrompt(7, { platform: 'win32' }), false, 'Windows: not known');
});

test('macOS: the same facts from ps', () => {
  const ps = (one, all) => ({ platform: 'darwin', run: (cmd, args) => (args.includes('-p') ? one : all) });
  assert.equal(atPrompt(7, ps(' 7 7 Ss', ' 1\n 1\n 3\n')), true);
  assert.equal(atPrompt(7, ps(' 7 7 Is', ' 1\n 7\n')), false, 'a child of the shell');
  assert.equal(atPrompt(7, ps(' 7 7 Rs', ' 1\n')), false, 'running');
  assert.equal(atPrompt(7, ps(' 7 12 Ss', ' 1\n')), false, 'another group in front');
  assert.equal(atPrompt(7, ps(null, null)), false, 'ps failed');
});
