// The page's part of "Allow everything" (web/allowall.js, web/chat/words.js): its words, its place in the menus, that
// Shift+Tab never lands on it, that the chip keeps it while Claude Code says bypass, and that the one question is asked
// once and never again after the yes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import './fakedom.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const W = await import('../../web/chat/words.js');
const A = await import('../../web/allowall.js');

test('the words: the mode, its line, and Bypass\'s line that tells the two apart', () => {
  assert.equal(W.MODE.allowEverything.chip, 'Allow everything');
  assert.equal(W.MODE.allowEverything.sub, 'Nothing is held, also not what Hands-off holds, except a delete of your whole home, workspace or disk. It is for work you watch or trust.');
  assert.equal(A.ALL_SAYS.join(' '), W.MODE.allowEverything.sub, 'the line in the menu and the line before the choice are one');
  assert.match(A.ACK_TEXT, /^Nothing is held, also not what Hands-off holds/);
  assert.equal(W.MODE.allowEverything.strong, true);
  assert.equal(W.MODE.bypassPermissions.sub, 'Runs without permission prompts; still stops before a risky delete or a command Hoprig cannot read');
  assert.equal(A.ACK_TITLE, 'Allow everything on this computer?');
  assert.equal(A.ACK_OK, 'Allow everything');
  assert.equal(A.ACK_TOAST, 'Allow everything is accepted on this computer');
  assert.match(A.ACK_TEXT, /You are asked this once on this computer\.$/);
  assert.match(A.ALL_MEANS, /What Hoprig would have held leaves one quiet line in the session\.$/);
  assert.match(A.ALL_DEFAULT_NOTE, /^Only sessions you start yourself on this page start in Allow everything\./);
});

test('the menu has it right after Bypass; Shift+Tab never lands on it, also from it', () => {
  const modes = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'allowEverything'];
  assert.deepEqual(W.modeMenu(modes).main.slice(-2), ['bypassPermissions', 'allowEverything']);
  let m = 'manual';
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    m = W.nextMode(m, modes);
    seen.add(m);
  }
  assert.ok(!seen.has('allowEverything'));
  assert.ok(seen.has('bypassPermissions'));
  assert.ok(W.nextMode('allowEverything', modes) !== 'allowEverything', 'the ring goes on from it');
  assert.ok(!W.MODE_CYCLE.includes('allowEverything'));
});

test('the chip keeps Allow everything while the process says bypassPermissions', () => {
  assert.equal(W.modeOf({ permissionMode: 'allowEverything', liveMode: 'bypassPermissions' }), 'allowEverything');
  assert.equal(W.modeOf({ permissionMode: 'bypassPermissions', liveMode: 'bypassPermissions' }), 'bypassPermissions');
  assert.equal(W.modeOf({ permissionMode: 'allowEverything', liveMode: 'plan' }), 'plan', 'left inside the tool: what it says');
  assert.equal(W.modeOf({ permissionMode: 'allowEverything', modeLater: 'manual' }), 'manual');
  assert.equal(W.modeOf({ permissionMode: 'allowEverything' }), 'allowEverything');
});

test('askOnce asks once, posts once, and never again after the yes', async () => {
  const posts = [];
  const said = [];
  let sheets = 0;
  const deps = (answer) => ({ call: async (p, b) => (b === undefined ? { everything: false } : (posts.push([p, b]), {})), sheet: async (o) => (sheets++, assert.equal(o.title, A.ACK_TITLE), assert.equal(o.danger, true), answer), say: (x) => said.push(x) });
  const state = {};
  assert.equal(await A.askOnce(state, deps(false)), false, 'a no goes nowhere');
  assert.deepEqual(posts, []);
  assert.equal(await A.askOnce(state, deps(true)), true);
  assert.deepEqual(posts, [['/api/settings/bypass/everything', { confirm: true }]]);
  assert.deepEqual(said, [A.ACK_TOAST]);
  assert.equal(await A.askOnce(state, deps(true)), true);
  assert.equal(sheets, 2, 'no third sheet');
  assert.equal(posts.length, 1);
  // already accepted on this computer (the server says so): no sheet at all
  const known = await A.askOnce({}, { call: async () => ({ everything: true }), sheet: async () => assert.fail('no sheet'), say: () => {} });
  assert.equal(known, true);
});

test('the choice is asked through askOnce in the chat menu and Settings (the New session popup no longer offers a mode); Bypass\'s own text is untouched', () => {
  const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
  for (const f of ['chat/composer.js', 'sessiondefaults.js']) assert.match(read(f), /askOnce\(/, f);
  assert.match(read('chat/chat.css'), /\.chat-modechip\.chat-is-all/);
  assert.match(read('chat/timeline.js'), /Allowed without asking \(Allow everything\): /);
  assert.match(read('session.js'), /Allowed without asking \(Allow everything\): /);
});
