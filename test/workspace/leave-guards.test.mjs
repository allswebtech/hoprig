// The guards of the check before a format (leave.mjs, leavemarks.mjs, leavefeature.mjs, tools/lostcomputer.mjs) on
// temporary homes: a folder the check must look at cannot be left out by an "outside" mark, and a mark of it made by
// hand or by an older Hoprig is looked at all the same; a private folder named with --also is never looked into; a
// mark that holds the host name after the host was renamed leaves the computer's file readable; the whole look is the
// owner's own page; the lost-computer proof refuses a home that is not a temporary one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { dropWorld, getOn } from './dropfix.mjs';

process.env.HOPRIG_HOSTNAME = 'boxhost.example.test';
const w = await dropWorld('leave-guards', { labels: ['desk'] });
test.after(() => w.cleanup());
const [D] = w.computers;
D.use();
const got = await getOn(D, ['shop']);
assert.equal(got.code, 0, got.text);
const C = await import('../../src/workspace/computer.mjs');
const L = await import('../../src/workspace/leavemarks.mjs');
const { leaveCheck } = await import('../../src/workspace/leave.mjs');
const { leaveFeature } = await import('../../src/workspace/leavefeature.mjs');
const { refusal, REFUSED } = await import('../../tools/lostcomputer.mjs');
const api = path.join(D.shop, 'code', 'shop-api');
const noHome = async () => ({ items: [], asks: [], outside: [], notChecked: [] });
const look = (extra = {}) => leaveCheck({ dir: D.ws, projects: D.projects, home: D.home, cheap: true, homeLook: noHome, ...extra });

test('the workspace, its projects, the SSH keys and Hoprig\'s own folders cannot be left out, and a hand-made mark of them is not honoured', async () => {
  D.use();
  w.sh(api, 'switch', '-q', '-c', 'feature/only-here');
  w.commit(api, 'only.txt', 'only here\n');
  w.sh(api, 'switch', '-q', 'main');
  for (const what of ['~/Workspace', '~/Workspace/projects', '~/Workspace/projects/shop/code', '~/.ssh', '~/.config', '~/.state', '~/.claude', '~/Workspace/ai_brain']) {
    const r = await L.setMark({ dir: D.ws, home: D.home, kind: 'outside', what });
    assert.equal(r.ok, false, what);
    assert.match(r.why, /is looked at by the check itself, so it cannot be left out/, what);
  }
  assert.equal((await L.setMark({ dir: D.ws, home: D.home, kind: 'outside', what: '~/Desktop/old' })).ok, true, 'a folder of his own can');
  const r = await look({ marks: { keep: [], ignore: [], outside: ['~/Workspace'], testData: [], label: 'desk' } });
  assert.ok(r.items.some((i) => i.id.endsWith(':feature/only-here')), JSON.stringify(r.items.map((i) => i.id)));
  assert.equal(r.nothingOnlyHere, false);
  assert.ok(r.notes.some((n) => /~\/Workspace is marked as yours to keep, but the workspace is looked at by the check itself/.test(n)), JSON.stringify(r.notes));
  assert.deepEqual(r.outside, []);
  w.sh(api, 'branch', '-q', '-D', 'feature/only-here');
});

test('--also of a private folder, or of a folder inside one, never looks into it', async () => {
  const priv = path.join(D.home, 'ignore', 'sub');
  fs.mkdirSync(path.join(priv, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(priv, 'deep', 'secret-name.txt'), 'x\n');
  for (const a of [path.join(D.home, 'ignore'), priv]) {
    const r = await look({ also: [a] });
    assert.ok(r.notChecked.some((n) => n.why === 'a private folder: never looked into'), JSON.stringify(r.notChecked));
    assert.ok(!JSON.stringify(r).includes('secret-name') && !JSON.stringify(r).includes('deep'), JSON.stringify(r));
  }
});

test('the brain\'s own branches are named, but not as pushable: the one press pushes the projects only', async () => {
  D.use();
  w.sh(D.brain, 'switch', '-q', '-c', 'notes');
  w.commit(D.brain, 'notes.md', 'n\n');
  w.sh(D.brain, 'switch', '-q', 'main');
  const r = await look();
  const b = r.items.find((i) => i.id.endsWith(':notes'));
  assert.ok(b, JSON.stringify(r.items.map((i) => i.id)));
  assert.equal(b.pushable, false);
  w.sh(D.brain, 'branch', '-q', '-D', 'notes');
});

test('a mark that holds the host name after the host was renamed: the computer\'s file still reads, without that mark', async () => {
  D.use();
  assert.equal((await L.setMark({ dir: D.ws, home: D.home, kind: 'keep', what: '~/.toolq' })).ok, true);
  process.env.HOPRIG_HOSTNAME = 'toolq.example.test';
  try {
    const mine = C.computersHere(D.ws).files.find((f) => f.label === 'desk');
    assert.ok(mine, JSON.stringify(C.computersHere(D.ws).refused));
    assert.ok(!L.readMarks({ dir: D.ws, home: D.home }).keep.includes('~/.toolq'));
    assert.equal((await C.writeOwnFile({ dir: D.ws, projects: D.projects })).why, undefined);
  } finally {
    process.env.HOPRIG_HOSTNAME = 'boxhost.example.test';
  }
});

test('the whole look is the owner\'s own page: Tia and another computer\'s token are refused', async () => {
  let looks = 0;
  const route = (by, headers = {}) => {
    const f = leaveFeature({ caller: () => by, readJson: async () => ({}), config: () => ({}) }, { leaveCheck: async () => (looks++, { items: [], asks: [], outside: [], notChecked: [], nothingOnlyHere: true }) });
    const [, , fn] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/workspace/leave'));
    return fn(Object.assign(Readable.from([]), { headers }), null, new URLSearchParams());
  };
  await assert.rejects(route('page', { authorization: 'Bearer tia_0123456789abcdef0123456789' }), (e) => e.status === 403);
  await assert.rejects(route('self'), (e) => e.status === 403);
  await assert.rejects(route('computer', { authorization: 'Bearer hop_madeuptoken0123456789' }), (e) => e.status === 403);
  assert.equal(looks, 0, 'no look was started by a refused request');
  assert.equal((await route('page')).running, true);
});

test('the lost-computer proof refuses a home that is not a temporary one, and traps that are not there', () => {
  const traps = process.env.HOPRIG_TEST_TRAPS;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-home-'));
  assert.equal(refusal({ HOPRIG_TEST_TRAPS: traps, HOME: tmpHome }), '', 'a temporary home behind the runner may run');
  for (const env of [{ HOPRIG_TEST_TRAPS: traps, HOME: '/' }, { HOPRIG_TEST_TRAPS: traps, HOME: '.' }, { HOPRIG_TEST_TRAPS: traps, HOME: os.tmpdir() },
    { HOPRIG_TEST_TRAPS: traps, HOME: os.userInfo().homedir }, { HOPRIG_TEST_TRAPS: path.join(tmpHome, 'no-such-traps'), HOME: tmpHome }, { HOME: tmpHome }]) {
    assert.equal(refusal(env), REFUSED, JSON.stringify(env));
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
