// Which program a terminal has in front (src/server/backends/front.mjs), and the steps of src/server/typing.mjs around
// it: what is refused before anything is typed, the record read again under the typing lock, the second look before
// the Enter and what it says when that fails, the keys of anyone but the owner, and the built-in terminal's check (on
// Windows: its own child) in the same step as the write. The real terminals are in typedtext.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('front');
test.after(() => box.cleanup());
const { FRONT_GONE, assertFront, groups, notInFront, parseStat } = await import('../../src/server/backends/front.mjs');
const { Deck } = await import('../../src/server/deck.mjs');
const { toolText } = await import('../../src/server/typing.mjs');
const { lockOf, noteTyped, removeLocked, typedOf, whileTyping } = await import('../../src/typinglock.mjs');
const { runsDir } = await import('../../src/paths.mjs');
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

/**
 * A deck whose `find` answers from `looks` one after the other, on a backend that records what it was asked. The
 * first look is given twice: the deck looks once to find the conversation's queue (deck.mjs #inTurn), then typing.mjs.
 */
function rig(looks) {
  looks = [looks[0], ...looks];
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
const recordOf = (r) => path.join(runsDir(), `${r.runId}.json`);
/** A run as find() gives it, with its record on disk (the typing lock reads it again). */
const run = (o = {}) => {
  const r = { runId: 'r1', pid: process.pid, ...o };
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(recordOf(r), JSON.stringify(r));
  return r;
};
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

test('sendToTool: the record went after the look, before the bytes: nothing typed', { skip: process.platform === 'win32' && 'POSIX groups' }, async () => {
  const r = rig([{ term, run: run({ runId: 'gone' }) }]);
  fs.rmSync(recordOf({ runId: 'gone' }));
  await assert.rejects(r.deck.sendToTool('s', 'touch X'), (e) => e.status === 409 && e.code === 'not_in_front' && /no coding tool runs/.test(e.message));
  // Another launcher wrote a record of the same name since (a pid that is not the one looked at).
  const other = rig([{ term, run: run({ runId: 'r9' }) }]);
  fs.writeFileSync(recordOf({ runId: 'r9' }), JSON.stringify({ runId: 'r9', pid: 1 }));
  await assert.rejects(other.deck.sendToTool('s', 'touch X'), (e) => e.code === 'not_in_front');
  assert.deepEqual([...r.calls, ...other.calls], [], 'nothing typed');
});

test('sendToTool: the text went, its Enter did not: "typed but not sent", a code of its own, whatever stopped the Enter', { skip: process.platform === 'win32' && 'POSIX groups' }, async () => {
  const gone = { term, run: run({ runId: 'r3' }) };
  const cases = [
    ['no run any more', [{ term, run: run() }, { term, run: null }]],
    ['another run', [{ term, run: run() }, { term, run: run({ runId: 'r2' }) }]],
    ['another terminal', [{ term, run: run() }, { term: { id: '%2', session: 's' }, run: run() }]],
    ['no session', [{ term, run: run() }, null]],
    ['the record went in the pause', [gone, gone]],
  ];
  for (const [what, looks] of cases) {
    const r = rig(looks);
    if (what === 'the record went in the pause') r.backend.sendText = async (id, text, o) => { r.calls.push(['text', id, text, o]); fs.rmSync(recordOf(gone.run)); };
    await assert.rejects(r.deck.sendToTool('s', 'hello'), (e) => {
      assert.equal(e.status, 409, what);
      assert.equal(e.code, 'typed_not_sent', what);
      assert.deepEqual(e.details, { code: 'typed_not_sent' }, 'the route sends the code along');
      assert.match(e.message, /^The text was typed into session "s" but not sent: its coding tool ended or changed before the Enter\. Look at the session before you send it again$/);
      return true;
    }, what);
    assert.deepEqual(r.calls.map((c) => c[0]), ['text'], `${what}: no Enter`);
  }
  const r = rig([{ term, run: run() }]);
  r.backend.refuseKey = true;
  await assert.rejects(r.deck.sendToTool('s', 'hello'), (e) => e.code === 'typed_not_sent');
  const broken = rig([{ term, run: run() }]);
  broken.backend.sendKey = async () => { throw new Error('tmux went away'); };
  await assert.rejects(broken.deck.sendToTool('s', 'hello'), (e) => e.code === 'typed_not_sent');
});

test('keyToTool: a key for anyone but the owner goes only to the coding tool in front, a digit as text', { skip: process.platform === 'win32' && 'POSIX groups' }, async () => {
  const group = groups(process.pid).pgrp;
  const r = rig([{ term, run: run() }]);
  await r.deck.keyToTool('s', 'Enter');
  await r.deck.keyToTool('s', '2');
  assert.deepEqual(r.calls, [['key', '%1', 'Enter', { front: { group, pid: process.pid } }], ['text', '%1', '2', { front: { group, pid: process.pid } }]]);
  for (const look of [null, { term, run: null }, { term, run: run({ pid: 2 ** 22 + 12345 }) }]) {
    const n = rig([look]);
    await assert.rejects(n.deck.keyToTool('s', 'Enter'), (e) => e.status === 409 && e.code === 'not_in_front' && /^Nothing was typed/.test(e.message));
    assert.deepEqual(n.calls, []);
  }
});

test('the typing lock: the launcher removes its record only after a message being typed is out', async () => {
  const file = recordOf(run({ runId: 'lock1' }));
  const order = [];
  // A launcher (another process, as in life: its side waits without an event loop) ends its run while we type.
  let child;
  await whileTyping(file, async () => {
    assert.ok(fs.existsSync(lockOf(file)), 'held while typing');
    const script = path.join(box.root, 'end-run.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs';
import { removeLocked } from ${JSON.stringify(new URL('../../src/typinglock.mjs', import.meta.url).href)};
removeLocked(process.argv[2], (f) => { process.stdout.write(String(Date.now())); fs.rmSync(f); });
`);
    child = spawn(process.execPath, [script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(fs.existsSync(file), 'the record stands while the lock is held');
    order.push(['typed', Date.now()]);
  });
  const removedAt = await new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => resolve(Number(out)));
  });
  assert.ok(removedAt >= order[0][1], 'removed after the typing');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(lockOf(file)), false, 'no lock left');
  // A lock left by a process that died is taken over after a while; a missing runs folder is "no record".
  const stale = recordOf(run({ runId: 'lock2' }));
  fs.writeFileSync(lockOf(stale), '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockOf(stale), old, old);
  assert.equal(removeLocked(stale), false, 'nobody typed: no input to settle');
  assert.equal(fs.existsSync(stale), false);
  // Something was typed for the tool during the run: the launcher is told to settle its input, and the note goes.
  const noted = recordOf(run({ runId: 'lock4' }));
  noteTyped(noted);
  assert.equal(removeLocked(noted), true);
  assert.equal(fs.existsSync(typedOf(noted)), false);
  await assert.rejects(whileTyping(path.join(box.root, 'no-such-folder', 'x.json'), async () => {}), (e) => e.code === 'ENOENT');
  // Someone holds it for longer than the wait: nothing is typed, 409.
  const busy = recordOf(run({ runId: 'lock3' }));
  fs.writeFileSync(lockOf(busy), '');
  await assert.rejects(whileTyping(busy, async () => assert.fail('typed'), { wait: 100 }), (e) => e.status === 409 && /another message is being typed/.test(e.message));
  fs.rmSync(lockOf(busy));
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
