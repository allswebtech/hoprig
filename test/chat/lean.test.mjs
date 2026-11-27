// A chat without the many-agents chip starts Claude Code without its Workflow tool (its definition is in every
// request and is used only when the person opted in); switching the chip on starts it again with the tool. A
// terminal session has no chip and is left as it is.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('chatlean');
test.after(() => box.cleanup());
const { Chat } = await import('../../src/chat/chat.mjs');

function newChat(o = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(cwd, '..', `${path.basename(cwd)}.args`);
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }), ...o });
  c.argsFile = argsFile;
  return c;
}
const turnEnd = (c) => new Promise((r) => c.once('turn', r));
const starts = (c) => fs.readFileSync(c.argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray);
const left = (a) => (a.includes('--disallowed-tools') ? a[a.indexOf('--disallowed-tools') + 1] : null);

test('the start line of a chat leaves the Workflow tool out unless the chip is on', async (t) => {
  const off = newChat();
  const on = newChat({ ultracode: true });
  t.after(() => Promise.all([off.stopAndWait(), on.stopAndWait()]));
  let d = turnEnd(off);
  await off.send('hi');
  await d;
  d = turnEnd(on);
  await on.send('hi');
  await d;
  assert.equal(left(starts(off)[0]), 'Workflow', 'chip off: only the Workflow tool is left out');
  assert.equal(left(starts(on)[0]), null, 'chip on: the tool is there');
});

test('switching the chip on starts the tool again, off keeps the process', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  let d = turnEnd(c);
  await c.send('one');
  await d;
  assert.equal((await c.setSettings({ ultracode: true })).restart, true, 'the process has no Workflow tool: it starts again');
  d = turnEnd(c);
  await c.send('two');
  await d;
  const [s0, s1] = starts(c);
  assert.equal(left(s0), 'Workflow');
  assert.equal(left(s1), null);
  assert.ok(s1.includes('--resume'));
  assert.equal((await c.setSettings({ ultracode: false })).restart, false, 'off again: the tool is only unused, nothing restarts');
});

test('a terminal session is started as before: no tool is left out', () => {
  const src = fs.readFileSync(new URL('../../src/launch.mjs', import.meta.url), 'utf8');
  assert.equal(/Workflow/.test(src), false);
});
