// Which program a terminal has in front (src/server/backends/front.mjs), and Deck#sendToTool's own steps around it:
// what is refused before anything is typed, the second look before the Enter, and the built-in terminal's check
// (on Windows: its own child) in the same step as the write. The real terminals are in typedtext.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('front');
test.after(() => box.cleanup());
const { FRONT_GONE, assertFront, groups, notInFront, parseStat } = await import('../../src/server/backends/front.mjs');
const { Deck, toolText } = await import('../../src/server/deck.mjs');
const { PtyBackend } = await import('../../src/server/backends/pty.mjs');

test('a stat line: the name may hold spaces and parentheses', () => {
  assert.deepEqual(parseStat('42 (node) S 1 42 42 34816 4711 4194304 0'), { pgrp: 42, tpgid: 4711 });
  assert.deepEqual(parseStat('7 (a) b (c) d) R 1 9 9 0 -1 0'), { pgrp: 9, tpgid: -1 });
  assert.equal(parseStat('garbage'), null);
});

test('groups: this process on this system, a gone one, Windows, and ps elsewhere', { skip: process.platform === 'win32' && 'POSIX' }, () => {
  const mine = groups(process.pid);
  const ps = String(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)])).trim();
  assert.equal(mine.pgrp, Number(ps), 'the same group ps names');
  assert.equal(groups(2 ** 22 + 12345), null, 'a pid that does not exist');
  assert.equal(groups(process.pid, { platform: 'win32' }), null);
  assert.equal(groups(0), null);
  const asked = [];
  const run = (cmd, args) => (asked.push([cmd, ...args]), '  501   777\n');
  assert.deepEqual(groups(55, { platform: 'darwin', run }), { pgrp: 501, tpgid: 777 });
  assert.deepEqual(asked, [['ps', '-o', 'pgid=,tpgid=', '-p', '55']]);
  assert.equal(groups(55, { platform: 'darwin', run: () => null }), null, 'ps failed: not known, so not in front');
});

test('assertFront: only the group in front passes; no group named, nothing to check', () => {
  const read = () => '10 (bash) S 1 10 10 34816 99 0';
  assert.doesNotThrow(() => assertFront(10, { group: 99 }, { platform: 'linux', read }));
  assert.throws(() => assertFront(10, { group: 98 }, { platform: 'linux', read }), (e) => e.status === 409 && e.code === 'not_in_front' && e.message === FRONT_GONE);
  assert.throws(() => assertFront(10, { group: 99 }, { platform: 'linux', read: () => { throw new Error('ENOENT'); } }), /not the program in front/);
  assert.doesNotThrow(() => assertFront(10, null));
  assert.doesNotThrow(() => assertFront(10, { pid: 3 }));
  const e = notInFront('x');
  assert.deepEqual([e.status, e.code, e.details], [409, 'not_in_front', { code: 'not_in_front' }], 'the page and the assistant get its code');
});

test('toolText: every run of control characters is one space; line breaks stay', () => {
  assert.equal(toolText('a\x03\x03b'), 'a b');
  assert.equal(toolText('\x1b[31mred\x1b[0m'), ' [31mred [0m');
  assert.equal(toolText('tab\there\x7f\x00end\u0085\u009b'), 'tab here end ');
  assert.equal(toolText('one\r\ntwo\rthree\nfour'), 'one\ntwo\nthree\nfour');
  assert.equal(toolText('x\n\x15y'), 'x\n y', 'Ctrl-U after a line break is a space, the break stays');
  assert.equal(toolText('नमस्ते 🙂 ÄÖÜ "\'$`!'), 'नमस्ते 🙂 ÄÖÜ "\'$`!', 'text itself is untouched');
});

/** A deck whose `find` answers from `looks` one after the other, on a backend that records what it was asked. */
function rig(looks) {
  const calls = [];
  const backend = {
    kind: 'tmux',
    async list() { return []; },
    async sendText(id, text, o) { calls.push(['text', id, text, o]); },
    async sendKey(id, key, o) {
      if (backend.refuseKey) throw notInFront(FRONT_GONE);
      calls.push(['key', id, key, o]);
    },
  };
  const deck = new Deck({ backend, config: () => ({}), profiles: () => [] });
  let i = 0;
  deck.find = async () => looks[Math.min(i++, looks.length - 1)];
  return { deck, backend, calls };
}
const run = (o = {}) => ({ runId: 'r1', pid: process.pid, ...o });
const term = { id: '%1', session: 's' };

test('sendToTool: the launcher\'s group is what must be in front, for the text and again for the Enter', { skip: process.platform === 'win32' && 'POSIX groups' }, async () => {
  const r = rig([{ term, run: run() }]);
  await r.deck.sendToTool('s', 'go\x03on');
  const group = groups(process.pid).pgrp;
  assert.deepEqual(r.calls, [
    ['text', '%1', 'go on', { front: { group, pid: process.pid } }],
    ['key', '%1', 'Enter', { front: { group, pid: process.pid } }],
  ]);
  const quiet = rig([{ term, run: run() }]);
  await quiet.deck.sendToTool('s', 'x', { enter: false });
  assert.equal(quiet.calls.length, 1, 'no Enter asked for, none sent');
});

test('sendToTool: refused before anything is typed', async () => {
  for (const [look, re] of [
    [null, /no session "s" any more/],
    [{ term, run: null }, /no coding tool runs in session "s" now/],
    [{ term, run: run({ pid: 2 ** 22 + 12345 }) }, /not the program in front/],
  ]) {
    const r = rig([look]);
    await assert.rejects(r.deck.sendToTool('s', 'touch X'), (e) => e.status === 409 && e.code === 'not_in_front' && re.test(e.message));
    assert.deepEqual(r.calls, [], 'nothing typed');
  }
});

test('sendToTool: the tool ended between the text and the Enter: no Enter, and it says the text may stand there', { skip: process.platform === 'win32' && 'POSIX groups' }, async () => {
  for (const second of [{ term, run: null }, { term, run: run({ runId: 'r2' }) }, { term: { id: '%2', session: 's' }, run: run() }]) {
    const r = rig([{ term, run: run() }, second]);
    await assert.rejects(r.deck.sendToTool('s', 'hello'), (e) => e.code === 'not_in_front' && /typed but not sent|no coding tool runs/.test(e.message));
    assert.deepEqual(r.calls.map((c) => c[0]), ['text'], 'no Enter');
  }
  const r = rig([{ term, run: run() }]);
  r.backend.refuseKey = true;
  await assert.rejects(r.deck.sendToTool('s', 'hello'), /typed but not sent/);
});

test('the owner\'s send is as before: no check, the text as written', async () => {
  const r = rig([]);
  await r.deck.send('%1', 'ls\x15 -la\r\n', { enter: false });
  assert.deepEqual(r.calls, [['text', '%1', 'ls\x15 -la\n', undefined]]);
});

/** A built-in terminal of `platform` whose program is a stand-in with pid `pid` that records what it is sent. */
async function pty(platform, pid) {
  const written = [];
  const spawn = () => ({ pid, process: 'node', onData() {}, onExit() {}, write: (d) => written.push(d), resize() {}, kill() {} });
  const b = new PtyBackend({ platform, spawn, shell: platform === 'win32' ? { file: 'powershell.exe', args: [] } : { file: '/bin/sh', args: ['-l'] } });
  const { id } = await b.create({ name: 'w', dir: platform === 'win32' ? 'C:\\w' : '/w', argv: platform === 'win32' ? ['node.exe', 'hoprig.mjs', '--launch', 'C:\\s\\launch\\f.json'] : null });
  written.length = 0;
  return { b, id, written };
}

test('built-in terminal, Windows: typed only while its own child is still the launcher', async () => {
  const { b, id, written } = await pty('win32', 4242);
  await b.sendText(id, 'hi', { front: { pid: 4242 } });
  await b.sendKey(id, 'Enter', { front: { pid: 4242 } });
  await assert.rejects(b.sendText(id, 'touch X', { front: { pid: 999 } }), (e) => e.code === 'not_in_front');
  await assert.rejects(b.sendKey(id, 'Enter', { front: { pid: 999 } }), (e) => e.code === 'not_in_front');
  assert.deepEqual(written, ['hi', '\r']);
  await b.close();
});

test('built-in terminal, POSIX: a group that is not in front gets nothing; the owner\'s keys still go', async () => {
  const { b, id, written } = await pty('linux', 2 ** 22 + 12345); // a shell pid the system does not know: nothing is in front
  await assert.rejects(b.sendText(id, 'touch X', { front: { group: process.pid } }), (e) => e.code === 'not_in_front');
  await b.sendText(id, 'ls\x15');
  await b.sendKey(id, 'C-c');
  assert.deepEqual(written, ['ls\x15', '\x03'], 'without `front` (the owner) every byte goes as before');
  await b.close();
});
