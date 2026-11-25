// "Do it" on a branch of its own (src/work/doit.mjs with alonegit.mjs's worktrees), with a stand-in chat feature, on a
// temporary computer: a task of a git project runs in a linked worktree on work/<id> in Hoprig's state folder, never
// in the owner's checkout; a second run continues there; Accept leaves the branch (nothing merged, nothing pushed) for
// Go live, which lists it as it lists a mission's; a folder that is no git repository, and "In the project's folder
// itself", run in the folder as before.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repoTree, tempWork, write } from './helpers.mjs';

const t = tempWork('work-doitbranch');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore, readDoc } = await import('../../src/work/store.mjs');
const { workRuns } = await import('../../src/work/doit.mjs');
const { listRuns, newRunId, readRun, writeRun, writerId } = await import('../../src/work/runs.mjs');
const { candidates } = await import('../../src/ship/together.mjs');

t.repo(t.brain, { 'README.md': '# brain\n' });
const shop = path.join(t.projects, 'shop');
const shopServer = t.repo(shop, { 'README.md': '# shop\n' });
const blog = path.join(t.projects, 'blog'); // a project that is no git repository
write(blog, { 'notes.md': '# blog\n' });
// The allowed folders hold the state folder (as the home folder holds it on a person's computer).
const cfg = { server: { roots: [t.root] }, work: { ownerId: 'alex' } };
saveConfig(cfg);
writeProfile('sub', { label: 'Main' });
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const trees = path.join(process.env.HOPRIG_STATE_DIR, 'work-trees');

/** A stand-in chat feature: a session works in the folder it was opened in until the test ends its turn. */
const chats = new Map();
const chat = {
  opened: [],
  async open(o) {
    const id = crypto.randomUUID();
    chat.opened.push(o);
    chats.set(id, { busy: true, lastEnd: null, lastText: '', dir: o.dir, fns: [] });
    return { sent: true, id, messageId: crypto.randomUUID() };
  },
  peek(id) {
    const c = chats.get(id);
    return c ? { busy: c.busy, pending: false, lastEnd: c.lastEnd, lastText: c.lastText, conversationId: 'conv1' } : null;
  },
  follow(id, fn) {
    chats.get(id).fns.push(fn);
    return () => {};
  },
  turnEnd: () => null,
  end(id, lastEnd, text) {
    const c = chats.get(id);
    Object.assign(c, { busy: false, lastEnd, lastText: text });
    for (const f of c.fns) f(this.peek(id));
  },
};
const runs = workRuns({ config: () => cfg, chat, defaultProvider: async () => 'sub', log: () => {} });
test.after(() => runs.close());

const itemOf = (id) => readDoc(place().file).doc.items.find((x) => x.id === id);
const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const ended = (runId) => until(`run ${runId} to end`, () => {
  const r = readRun(place(), runId);
  return r && r.state !== 'running' ? r : null;
});
const task = async (title, project = 'shop') => (await store().add({ title, project })).item.id;
const seen = async (id) => (await runs.plan(id)).brief;
/** The session commits a file in the folder it works in (the stand-in coding tool's own git). */
const commitIn = (dir, file, subject) => {
  write(dir, { [file]: `${file}\n` });
  t.git(dir, 'add', file);
  t.git(dir, 'commit', '-q', '-m', subject);
};
const serverRefs = () => t.git(shopServer, 'for-each-ref', '--format=%(refname) %(objectname)');

test('a git project: the session works on work/<id> in a worktree of the state folder; the owner\'s checkout is not changed', async () => {
  const id = await task('Add the price list');
  const before = repoTree(shop);
  const p = await runs.plan(id);
  assert.deepEqual(p.branch, { name: `work/${id}`, again: false });
  assert.equal(p.branchWhy, null);
  const { run } = await runs.start(id, { seen: p.brief });
  assert.equal(run.branch, `work/${id}`);
  const dir = chat.opened.at(-1).dir;
  assert.ok(dir.startsWith(`${fs.realpathSync(trees)}${path.sep}`), dir);
  assert.equal(t.git(dir, 'symbolic-ref', '--short', 'HEAD'), `work/${id}`);
  commitIn(dir, 'prices.md', 'Add the price list');
  write(dir, { 'draft.md': 'x\n' });
  chat.end(run.session, 'ok', `Done in ${dir}.`);
  const r = await ended(run.id);
  assert.equal(r.state, 'done');
  assert.equal(r.branch, `work/${id}`);
  assert.deepEqual(r.commits.map((c) => [c.repo, c.subject]), [['.', 'Add the price list']]);
  assert.deepEqual(r.changed.map((c) => c.path), ['draft.md']);
  assert.equal(r.answer, 'Done in ..', 'the worktree is named as the run\'s folder, never by its full path');
  assert.equal(itemOf(id).status, 'review');
  assert.deepEqual(repoTree(shop).files, before.files, 'no file of the checkout changed');
  assert.equal(repoTree(shop).head, before.head);
  assert.equal(repoTree(shop).index, before.index);
  assert.equal(t.git(shop, 'symbolic-ref', '--short', 'HEAD'), 'main', 'the checkout stays on its branch');
  assert.equal(t.git(shop, 'rev-parse', 'main'), before.head, 'main did not move');
});

test('Send back, then Start again: the same branch and the same worktree, its earlier commit there', async () => {
  const id = await task('Write the about page');
  const first = await runs.start(id, { seen: await seen(id) });
  const dir = chat.opened.at(-1).dir;
  commitIn(dir, 'about.md', 'Add the about page');
  chat.end(first.run.session, 'ok', 'First go.');
  await ended(first.run.id);
  await runs.sendBack(id, 'Shorter, please.');
  const p = await runs.plan(id);
  assert.deepEqual(p.branch, { name: `work/${id}`, again: true });
  const second = await runs.start(id, { seen: p.brief });
  assert.equal(chat.opened.at(-1).dir, dir, 'the same worktree');
  assert.equal(second.run.branch, `work/${id}`);
  assert.ok(fs.existsSync(path.join(dir, 'about.md')), 'what the first run committed is there');
  commitIn(dir, 'about.md.short', 'Shorten the about page');
  chat.end(second.run.session, 'ok', 'Second go.');
  const r = await ended(second.run.id);
  assert.deepEqual(r.commits.map((c) => c.subject), ['Shorten the about page'], 'only this run\'s commit is on this run');
});

test('Accept: the task is done, its branch stays, not merged into main, nothing pushed; Go live lists it with its title', async () => {
  const id = await task('Fix the cart total');
  const refs0 = serverRefs();
  const main0 = t.git(shop, 'rev-parse', 'main');
  const { run } = await runs.start(id, { seen: await seen(id) });
  commitIn(chat.opened.at(-1).dir, 'cart.md', 'Fix the cart total');
  chat.end(run.session, 'ok', 'Fixed.');
  await ended(run.id);
  await runs.accept(id);
  assert.equal(itemOf(id).status, 'done');
  assert.match(t.git(shop, 'rev-parse', '--verify', `refs/heads/work/${id}`), /^[0-9a-f]{40}$/, 'the branch stays');
  assert.equal(t.git(shop, 'rev-parse', 'main'), main0, 'main did not move: nothing merged');
  assert.equal(serverRefs(), refs0, 'the server has no new ref: nothing pushed');
  // Go live's titles come from Work's runs that have a branch (src/ship/feature.mjs titles()).
  const titles = {};
  for (const x of listRuns(place())) if (x.branch && x.title && !titles[x.branch]) titles[x.branch] = x.title;
  const c = await candidates(fs.realpathSync(shop), { titles });
  const b = c.branches.find((x) => x.name === `work/${id}`);
  assert.ok(b, JSON.stringify(c.branches));
  assert.equal(b.title, 'Fix the cart total');
  assert.equal(b.commits, 1);
});

test('a project that is no git repository runs in its own folder, and the sheet says why there is no branch', async () => {
  const id = await task('Draft the post', 'blog');
  const p = await runs.plan(id);
  assert.equal(p.branch, null);
  assert.equal(p.branchWhy, 'not-git');
  const { run } = await runs.start(id, { seen: p.brief });
  assert.equal(run.branch, null);
  assert.equal(chat.opened.at(-1).dir, fs.realpathSync(blog));
  write(blog, { 'post.md': 'p\n' });
  chat.end(run.session, 'ok', 'Drafted.');
  const r = await ended(run.id);
  assert.equal(r.state, 'done');
  assert.equal(r.branch ?? null, null, 'the run file names no branch');
  assert.equal(itemOf(id).status, 'review');
});

test('"In the project\'s folder itself": the session works in the checkout, as before, and no branch is made', async () => {
  const id = await task('Tidy the readme');
  const { run } = await runs.start(id, { seen: await seen(id), inFolder: true });
  assert.equal(run.branch, null);
  assert.equal(chat.opened.at(-1).dir, fs.realpathSync(shop));
  assert.throws(() => t.git(shop, 'rev-parse', '--verify', '--quiet', `refs/heads/work/${id}`));
  commitIn(shop, 'tidy.md', 'Tidy the readme');
  chat.end(run.session, 'ok', 'Tidied.');
  const r = await ended(run.id);
  assert.deepEqual(r.commits.map((c) => c.subject), ['Tidy the readme']);
});

test('the state folder outside the allowed folders: no branch is offered, and the run works in the folder', async () => {
  const was = cfg.server.roots;
  cfg.server.roots = [t.home];
  try {
    const id = await task('Check the links');
    const p = await runs.plan(id);
    assert.equal(p.branch, null);
    assert.equal(p.branchWhy, 'outside');
    const { run } = await runs.start(id, { seen: p.brief });
    assert.equal(run.branch, null);
    assert.equal(chat.opened.at(-1).dir, fs.realpathSync(shop));
    chat.end(run.session, 'ok', 'Checked.');
    await ended(run.id);
  } finally {
    cfg.server.roots = was;
  }
});

test('a run that ends by itself works on the task now (a mission\'s): Do it is refused, no second session on its branch', async () => {
  const id = await task('Rename the cart button');
  const r = {
    v: 1, id: newRunId(new Date()), item: id, title: 'Rename the cart button', writer: writerId(), by: 'mission', startedAt: new Date().toISOString(), endedAt: null,
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null, session: null, conversation: null, message: null,
    brief: 'Rename it', state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null, branch: `work/${id}`, schedule: null,
  };
  writeRun(place(), r);
  const opened = chat.opened.length;
  await assert.rejects(runs.start(id, { seen: await seen(id) }), (e) => e.status === 409 && e.details.code === 'running-alone');
  assert.equal(chat.opened.length, opened, 'no session opened');
  writeRun(place(), { ...r, state: 'stopped', endedAt: new Date().toISOString() });
});
