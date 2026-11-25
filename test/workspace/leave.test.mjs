// `hoprig pc leave --check` (src/workspace/leave.mjs): a computer with exactly one thing of each git kind that exists
// only on it is looked at. Each is named, with a size where it has one and what to do; only a non-default branch may
// be pushed by the one press; the daily look starts no program that reaches a git server; and the look changes nothing
// in the home. With all of them resolved, it says nothing is only here.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { dropWorld, getOn } from './dropfix.mjs';

const { capture } = await import('../../src/setup/system.mjs');
const { leaveCheck, AS_OF_FETCH } = await import('../../src/workspace/leave.mjs');

let w;
let c;
let api;
let web;

/** Every entry under `dir`: a file by size, time, mode and content, a folder, a link by its target. */
function listing(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    out[rel] = st.isSymbolicLink() ? `link ${fs.readlinkSync(p)}` : st.isDirectory() ? `dir ${st.mode}` : `${st.size} ${st.mtimeMs} ${st.mode} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
  }
  return out;
}

/** A runner that keeps every program line it is given, and runs it. */
function recorder() {
  const calls = [];
  const run = (argv, o) => {
    calls.push(argv);
    return capture(argv, o);
  };
  return { calls, run };
}

// The home part is another module's (leavehome.mjs): a stand-in that finds nothing, so these counts are this part's.
const homeLook = async () => ({ items: [], asks: [], outside: [], notChecked: [] });
const look = (extra = {}) => leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, homeLook, ...extra });
const said = (r) => JSON.stringify({ items: r.items, notChecked: r.notChecked, asks: r.asks }, null, 1);

before(async () => {
  w = await dropWorld('leave');
  c = w.computers[0];
  const got = await getOn(c, ['shop']);
  assert.equal(got.code, 0, got.text);
  // The computer's own file that set-up wrote: committed and pushed, so the brain holds nothing only here.
  w.sh(c.brain, 'add', '-A');
  w.sh(c.brain, 'commit', '-q', '-m', 'this computer');
  w.sh(c.brain, 'push', '-q');
  api = path.join(c.shop, 'code', 'shop-api');
  web = path.join(c.shop, 'code', 'shop-web');
});
after(() => w && w.cleanup());

test('a computer just set up from its git servers has nothing only here', async () => {
  const r = await look();
  assert.deepEqual(r.items, [], said(r));
  assert.deepEqual(r.notChecked, [], said(r));
  assert.equal(r.nothingOnlyHere, true);
  assert.equal(r.cheap, false);
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('one thing of each git kind is named with its size and what to do; only a non-default branch is pushable; nothing changed', async () => {
  // A branch ahead of its copy on the server, and one that has no copy there.
  w.sh(api, 'switch', '-q', '-c', 'feature/login');
  w.commit(api, 'login.js', 'one\n');
  w.sh(api, 'push', '-q', '-u', 'origin', 'feature/login');
  w.commit(api, 'login.js', 'two\n');
  w.sh(api, 'switch', '-q', 'main');
  w.sh(web, 'switch', '-q', '-c', 'spike');
  w.commit(web, 'spike.txt', 'try\n');
  w.sh(web, 'switch', '-q', 'main');
  // A commit on the default branch, work not committed, a stash.
  w.commit(c.shop, 'docs/plan.md', 'plan\n');
  fs.writeFileSync(path.join(api, 'notes.txt'), 'note\n'.repeat(10));
  fs.appendFileSync(path.join(web, 'README.md'), 'more\n');
  w.sh(web, 'stash', '-q');
  // A repository with no git server, and a plain folder in the projects folder.
  const tool = path.join(c.projects, 'local-tool');
  fs.mkdirSync(tool, { recursive: true });
  w.sh(tool, 'init', '-q', '-b', 'main');
  w.commit(tool, 'tool.sh', 'echo tool\n');
  fs.mkdirSync(path.join(c.projects, 'old-notes'));
  fs.writeFileSync(path.join(c.projects, 'old-notes', 'readme.txt'), 'x'.repeat(100));

  const before = listing(c.home);
  const whole = recorder();
  const r = await look({ run: whole.run });
  const daily = recorder();
  const d = await look({ cheap: true, run: daily.run });
  assert.deepEqual(listing(c.home), before, 'the look changed nothing in the home');

  const at = (rel) => `~/Workspace/projects/${rel}`;
  for (const rep of [r, d]) {
    const by = (kind, where, key = '') => rep.items.find((i) => i.kind === kind && i.where === where && (!key || i.id.endsWith(`:${key}`)));
    assert.equal(rep.items.length, 7, said(rep));
    const login = by('branch', at('shop/code/shop-api'), 'feature/login');
    assert.ok(login, said(rep));
    assert.match(login.what, /1 commit on feature\/login is on no git server/);
    assert.equal(login.command, `git -C ${api} push origin feature/login`);
    const spike = by('branch', at('shop/code/shop-web'), 'spike');
    assert.ok(spike, said(rep));
    assert.match(spike.what, /spike \(1 commit\) has no copy on the git server/);
    assert.equal(spike.command, `git -C ${web} push -u origin spike`);
    const main = by('branch', at('shop'), 'main');
    assert.ok(main, said(rep));
    assert.match(main.what, /1 commit on main, the default branch/);
    assert.match(main.todo, /push it yourself when it may go live/);
    assert.equal(main.command, `git -C ${c.shop} push origin main`);
    const work = by('work', at('shop/code/shop-api'));
    assert.equal(work.size, 50, said(rep));
    assert.match(work.todo, /commit/);
    const stash = by('stash', at('shop/code/shop-web'));
    assert.ok(stash && /stash/.test(stash.todo), said(rep));
    const none = by('noserver', at('local-tool'));
    assert.ok(none && none.size > 0, said(rep));
    assert.match(none.todo, /git server/);
    const plain = by('folder', at('old-notes'));
    assert.equal(plain && plain.size, 100, said(rep));
    assert.match(plain.command, /^hoprig pc leave --outside ~\/Workspace\/projects\/old-notes$/);
    // Each line says what to do; only the two non-default branches may be pushed by the one press.
    for (const i of rep.items) assert.ok(i.todo && i.what && i.id.startsWith(`${i.kind}:${i.where}`), JSON.stringify(i));
    assert.deepEqual(rep.items.filter((i) => i.pushable).map((i) => i.id).sort(), [login.id, spike.id].sort());
    assert.equal(rep.nothingOnlyHere, false);
  }
  // The same things are found with and without asking the servers, under the same ids (the daily look's "first seen").
  assert.deepEqual(d.items.map((i) => i.id).sort(), r.items.map((i) => i.id).sort());

  // The daily look reaches no git server; the whole check asks with ls-remote and fetches nothing.
  const reaches = (calls, word) => calls.filter((a) => a.includes(word));
  assert.deepEqual(reaches(daily.calls, 'ls-remote'), []);
  assert.deepEqual(reaches(daily.calls, 'fetch'), []);
  assert.ok(reaches(whole.calls, 'ls-remote').length >= 3, 'the whole check asks each server');
  assert.deepEqual(reaches(whole.calls, 'fetch'), []);
  assert.equal(d.cheap, true);
  assert.equal(d.notes.filter((n) => n === AS_OF_FETCH).length, 1, 'said once');
  assert.ok(!r.notes.includes(AS_OF_FETCH));
});

test('with each of them resolved, nothing is only here', async () => {
  w.sh(api, 'push', '-q', 'origin', 'feature/login');
  w.sh(web, 'push', '-q', '-u', 'origin', 'spike');
  w.sh(c.shop, 'push', '-q', 'origin', 'main');
  w.commit(api, 'notes.txt', 'note\n'.repeat(10));
  w.sh(api, 'push', '-q', 'origin', 'main');
  w.sh(web, 'stash', 'drop', '-q');
  fs.rmSync(path.join(c.projects, 'local-tool'), { recursive: true, force: true });
  fs.rmSync(path.join(c.projects, 'old-notes'), { recursive: true, force: true });
  for (const cheap of [false, true]) {
    const r = await look({ cheap });
    assert.deepEqual(r.items, [], said(r));
    assert.deepEqual(r.notChecked, [], said(r));
    assert.equal(r.nothingOnlyHere, true);
  }
});
