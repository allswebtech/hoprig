// The drop from the Workspace page (dropweb.mjs) is the terminal's drop, question for question, on temporary homes
// with local bare repositories: the check first in the terminal's own words, then each question answered only by the
// owner's press (work → a wip/ branch; a default branch → pushed only by that very answer) or by the name he typed;
// a ticket is used once and lasts ten minutes; a project that changed after the sheet opened is not dropped and the
// new list comes back. A grep test: only the drop modules decide what a drop may remove.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropWorld, onServer, reset, serverHeads } from './dropfix.mjs';

const w = await dropWorld('page', { labels: ['desk', 'box2'] });
test.after(() => w.cleanup());
const [D] = w.computers;
const { pageDrop, TICKET_MS } = await import('../../src/workspace/dropweb.mjs');
const { QUESTION } = await import('../../src/workspace/dropcli.mjs');
let clock = Date.now();
const page = pageDrop({ ctx: () => D.ctx, now: () => clock, share: async () => ({ done: false }) });
const api = () => path.join(D.shop, 'code', 'shop-api');
const API = 'projects/shop/code/shop-api';

test('a clean project: the check gives a ticket; the drop with it removes the project', async () => {
  await reset(D);
  const c = await page.check('shop', { ticket: true });
  assert.equal(c.result, 'nothing only here', JSON.stringify(c));
  assert.match(c.ticket, /^[0-9a-f]{64}$/);
  assert.ok(c.lines.some((l) => /nothing of it exists only here: it can be dropped/.test(l)), 'the terminal\'s own words');
  const r = await page.drop(c.ticket, {});
  assert.equal(r.result, 'dropped', JSON.stringify(r));
  assert.equal(fs.existsSync(D.shop), false);
  const again = await page.drop(c.ticket, {});
  assert.equal(again.result, 'expired', 'a ticket is used once');
});

test('work not committed: the terminal\'s question; only his press pushes a wip/ branch', async () => {
  await reset(D);
  fs.writeFileSync(path.join(api(), 'README.md'), 'changed\n');
  const c = await page.check('shop', { ticket: true });
  const q = c.questions.find((x) => x.ask === 'work');
  assert.equal(q.words, QUESTION.work(1), 'the same words as the terminal');
  const no = await page.drop(c.ticket, {});
  assert.equal(no.result, 'stopped', 'no press: nothing is pushed or dropped');
  assert.ok(fs.existsSync(D.shop));
  const before = Object.keys(serverHeads(w, 'shop-api')).filter((n) => n.startsWith('wip/'));
  const c2 = await page.check('shop', { ticket: true });
  const yes = await page.drop(c2.ticket, { work: true });
  assert.equal(yes.result, 'dropped', JSON.stringify(yes));
  const made = Object.keys(serverHeads(w, 'shop-api')).filter((n) => n.startsWith('wip/') && !before.includes(n));
  assert.equal(made.length, 1);
  assert.match(made[0], /^wip\/desk-\d{8}-\d{6}$/);
});

test('commits on a default branch: pushed only by his press of that very answer', async () => {
  await reset(D);
  const main0 = onServer(w, 'shop-api', 'refs/heads/main');
  w.commit(api(), 'release.txt', 'ship\n');
  const c = await page.check('shop', { ticket: true });
  const q = c.questions.find((x) => x.ask === 'default branch');
  assert.equal(q.repo, API);
  assert.equal(q.words, 'This pushes main of projects/shop/code/shop-api: 1 commit.');
  assert.deepEqual(q.choices.map((x) => x.value), ['push', 'wip', 'stop']);
  const none = await page.drop(c.ticket, { work: true });
  assert.equal(none.result, 'stopped', 'no answer for that repository stops');
  assert.equal(onServer(w, 'shop-api', 'refs/heads/main'), main0);
  const other = await page.drop((await page.check('shop', { ticket: true })).ticket, { defaults: { 'projects/shop/code/shop-web': 'push' } });
  assert.equal(other.result, 'stopped', 'an answer for another repository is no answer for this one');
  assert.equal(onServer(w, 'shop-api', 'refs/heads/main'), main0);
  const yes = await page.drop((await page.check('shop', { ticket: true })).ticket, { defaults: { [API]: 'push' } });
  assert.equal(yes.result, 'dropped', JSON.stringify(yes));
  assert.notEqual(onServer(w, 'shop-api', 'refs/heads/main'), main0, 'his press pushed main');
});

test('files that cannot be made again: only the name he typed; no press, empty or another name stops', async () => {
  await reset(D);
  fs.writeFileSync(path.join(D.shop, '.env'), 'SECRET=1\n');
  const c = await page.check('shop', { ticket: true });
  const q = c.questions.find((x) => x.ask === 'confirm');
  assert.equal(q.words, QUESTION.confirmPage('shop'));
  assert.doesNotMatch(q.words, /Enter/, 'Enter does nothing on the page');
  assert.ok(c.confirm.some((i) => i.path === '.env'));
  assert.ok(!JSON.stringify(c).includes('SECRET'), 'no content');
  for (const typed of [undefined, '', '  ', 'shoop', 'SHOP']) {
    const r = await page.drop((await page.check('shop', { ticket: true })).ticket, { work: true, defaults: { [API]: 'push' }, ...(typed === undefined ? {} : { typed }) });
    assert.equal(r.result, 'stopped', `typed ${JSON.stringify(typed)}`);
    assert.ok(fs.existsSync(path.join(D.shop, '.env')));
  }
  const ok = await page.drop((await page.check('shop', { ticket: true })).ticket, { typed: 'shop' });
  assert.equal(ok.result, 'dropped', JSON.stringify(ok));
});

test('the project changed after the sheet opened: nothing is dropped, the new list comes back with a new ticket', async () => {
  await reset(D);
  const c = await page.check('shop', { ticket: true });
  assert.equal(c.questions.length, 0);
  fs.writeFileSync(path.join(api(), 'late.txt'), 'written after the sheet opened\n');
  const r = await page.drop(c.ticket, { work: true, typed: 'shop' });
  assert.equal(r.result, 'changed', JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(api(), 'late.txt')), 'nothing removed');
  assert.ok(r.check.questions.some((x) => x.ask === 'work'), 'the new list');
  assert.match(r.check.ticket, /^[0-9a-f]{64}$/);
  assert.notEqual(r.check.ticket, c.ticket);
});

test('a ticket older than ten minutes, or none, is refused', async () => {
  await reset(D);
  const c = await page.check('shop', { ticket: true });
  clock += TICKET_MS + 1;
  assert.equal((await page.drop(c.ticket, {})).result, 'expired');
  assert.equal((await page.drop('x', {})).result, 'expired');
  assert.ok(fs.existsSync(D.shop));
  const read = await page.check('shop');
  assert.equal(read.ticket, undefined, 'a plain check gives no ticket');
});

test('one implementation: no file outside the drop modules decides what a drop may remove', () => {
  const src = path.join(import.meta.dirname, '..', '..', 'src');
  const deciders = /from '\.{1,2}\/(?:workspace\/)?(dropcheck|dropsilent|dropfind|dropacts)\.mjs'|import\('\.{1,2}\/(?:workspace\/)?(dropcheck|dropsilent|dropfind|dropacts)\.mjs'\)/;
  // Callers that only finish a cut-off drop (get) or name a leftover (status): the drop modules' own functions.
  // And one that removes nothing: the commit of a run that has no git (work/alonecommit.mjs) is made the way a drop
  // makes its own (the exact bytes, on an index of its own), so that there is ONE such way, not two.
  const allowed = new Set(['workspace/drop.mjs', 'workspace/dropcheck.mjs', 'workspace/dropsilent.mjs', 'workspace/dropfind.mjs', 'workspace/dropacts.mjs', 'workspace/dropcli.mjs', 'pcsetup/getproject.mjs', 'workspace/cli.mjs', 'work/alonecommit.mjs',
    // The whole-computer check's walk asks dropsilent.mjs what a build makes again (so it keeps no second list) and
    // prints sizes with dropfind.mjs's words; it removes nothing.
    'workspace/leavewalk.mjs',
    // The whole-computer check puts every repository through drop's own check (lookAt, checkRepo) so that it names
    // exactly what a drop would refuse, with drop's words; it only reads and removes nothing.
    'workspace/leave.mjs', 'workspace/leaveitems.mjs']);
  const bad = [];
  for (const e of fs.readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
    const rel = path.relative(src, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    const text = fs.readFileSync(path.join(src, rel), 'utf8');
    if (deciders.test(text) && !allowed.has(rel)) bad.push(rel);
    if (rel !== 'workspace/dropsilent.mjs' && rel !== 'workspace/dropcheck.mjs' && /check-ignore/.test(text) && /\bdrop/i.test(text) && !allowed.has(rel)) bad.push(`${rel} (check-ignore)`);
  }
  assert.deepEqual(bad, [], 'a second place that decides what a drop removes');
  const web = fs.readFileSync(path.join(src, 'workspace', 'dropweb.mjs'), 'utf8');
  assert.match(web, /dropProject\(/, 'the page calls drop.mjs');
  assert.doesNotMatch(web, /rmSync|renameSync|unlinkSync|gitIn|'push'\]/, 'the page module removes and pushes nothing itself');
});

test('a default branch amended after the check (same count, another commit): changed, the server untouched', async () => {
  await reset(D);
  const main0 = onServer(w, 'shop-api', 'refs/heads/main');
  w.commit(api(), 'amend-me.txt', 'the commit the sheet showed\n');
  const c = await page.check('shop', { ticket: true });
  assert.equal(c.questions.find((x) => x.ask === 'default branch').commits, 1);
  fs.writeFileSync(path.join(api(), 'amend-me.txt'), 'other content\n');
  w.sh(api(), 'commit', '-q', '-a', '--amend', '-m', 'amended after the sheet opened');
  const r = await page.drop(c.ticket, { defaults: { [API]: 'push' } });
  assert.equal(r.result, 'changed', JSON.stringify(r));
  assert.equal(onServer(w, 'shop-api', 'refs/heads/main'), main0, 'nothing was pushed');
  assert.ok(fs.existsSync(D.shop));
});

test('a file of the work list changed again after the check: changed, no wip/ branch', async () => {
  await reset(D);
  fs.writeFileSync(path.join(api(), 'README.md'), 'changed\n');
  const c = await page.check('shop', { ticket: true });
  const before = Object.keys(serverHeads(w, 'shop-api')).filter((n) => n.startsWith('wip/'));
  fs.writeFileSync(path.join(api(), 'README.md'), 'changed again, with something else\n');
  const r = await page.drop(c.ticket, { work: true });
  assert.equal(r.result, 'changed', JSON.stringify(r));
  assert.deepEqual(Object.keys(serverHeads(w, 'shop-api')).filter((n) => n.startsWith('wip/')), before, 'no wip/ branch pushed');
});

test('stopped at a question: a fresh check and ticket come back, and the next press can drop; a used ticket is named as used', async () => {
  await reset(D);
  fs.writeFileSync(path.join(api(), 'README.md'), 'changed\n');
  const c = await page.check('shop', { ticket: true });
  const no = await page.drop(c.ticket, {});
  assert.equal(no.result, 'stopped');
  assert.match(no.check.ticket, /^[0-9a-f]{64}$/, 'a fresh ticket for the next press');
  assert.ok(no.check.questions.some((q) => q.ask === 'work'));
  const again = await page.drop(c.ticket, { work: true });
  assert.equal(again.result, 'expired');
  assert.match(again.error, /used already/);
  assert.doesNotMatch(again.error, /ten minutes/);
  const yes = await page.drop(no.check.ticket, { work: true });
  assert.equal(yes.result, 'dropped', JSON.stringify(yes));
});

test('a tracked file replaced by a FIFO: the check and the drop come back, and the event loop is never held', { skip: process.platform === 'win32' && 'no FIFOs (mkfifo, sh) on Windows' }, async () => {
  await reset(D);
  const fifo = path.join(api(), 'README.md');
  fs.rmSync(fifo);
  execFileSync('mkfifo', [fifo]);
  // A writer that comes only after 3 s: a check that opens the FIFO waits for it, and no timer runs meanwhile.
  const writer = spawn('sh', ['-c', 'sleep 3; exec printf x > "$1"', 'sh', fifo], { stdio: 'ignore' });
  let last = Date.now();
  let gap = 0;
  const tick = setInterval(() => {
    gap = Math.max(gap, Date.now() - last);
    last = Date.now();
  }, 50);
  try {
    const c = await page.check('shop', { ticket: true });
    gap = Math.max(gap, Date.now() - last);
    assert.ok(gap < 2000, `the event loop was held for ${gap} ms`);
    assert.ok(c.questions.some((q) => q.ask === 'work'), JSON.stringify(c));
    const r = await page.drop(c.ticket, {});
    assert.equal(r.result, 'stopped', JSON.stringify(r));
    assert.ok(fs.lstatSync(fifo).isFIFO(), 'nothing removed');
  } finally {
    clearInterval(tick);
    writer.kill();
  }
});

test('a memory note changed again after the check: changed, the server\'s main untouched', async () => {
  await reset(D);
  const main0 = onServer(w, 'shop-workspace', 'refs/heads/main');
  const note = path.join(D.shop, 'ai_brain', 'claude-memory', 'MEMORY.md');
  fs.appendFileSync(note, 'a note the sheet shows\n');
  const c = await page.check('shop', { ticket: true });
  const q = c.questions.find((x) => x.ask === 'default branch');
  assert.equal(q.repo, 'projects/shop', JSON.stringify(c.questions));
  fs.appendFileSync(note, 'added after the sheet opened\n');
  const r = await page.drop(c.ticket, { defaults: { 'projects/shop': 'push' } });
  assert.equal(r.result, 'changed', JSON.stringify(r));
  assert.equal(onServer(w, 'shop-workspace', 'refs/heads/main'), main0, 'nothing was pushed');
  assert.ok(fs.readFileSync(note, 'utf8').includes('added after the sheet opened'), 'nothing removed');
});

test('a memory note changed during the press itself (while a code repository is fetched): changed, main untouched, his line kept', async () => {
  await reset(D);
  const { dropProject } = await import('../../src/workspace/drop.mjs');
  const { fingerprint } = await import('../../src/workspace/dropweb.mjs');
  const main0 = onServer(w, 'shop-workspace', 'refs/heads/main');
  const note = path.join(D.shop, 'ai_brain', 'claude-memory', 'MEMORY.md');
  fs.appendFileSync(note, 'shown on the sheet\n');
  const fp = fingerprint(await dropProject('shop', { ctx: D.ctx, mode: 'check' }));
  const steps = [];
  const r = await dropProject('shop', {
    ctx: D.ctx, mode: 'drop', checked: (x) => fingerprint(x) === fp, share: async () => ({ done: false }),
    ask: { work: async () => false, defaultBranch: async () => 'push', confirm: async () => false },
    onStep: (s, what) => {
      steps.push(s);
      if (s === 'fetch' && String(what).endsWith('shop-api')) fs.appendFileSync(note, 'LATE-LINE\n');
    },
  });
  assert.equal(r.result, 'changed', JSON.stringify(r));
  assert.ok(!steps.includes('push'), `nothing pushed: ${steps.join(' ')}`);
  assert.equal(onServer(w, 'shop-workspace', 'refs/heads/main'), main0, 'main on the server as it was');
  assert.ok(fs.readFileSync(note, 'utf8').endsWith('shown on the sheet\nLATE-LINE\n'), 'his late line is still in his file');
  const local = w.sh(D.shop, 'log', '-1', '--format=%s', 'main');
  assert.notEqual(local, 'Update AI memory', 'no commit of the press on his branch');
  assert.equal(w.sh(D.shop, 'status', '--porcelain', '--', 'ai_brain'), 'M ai_brain/claude-memory/MEMORY.md', 'his note is still a change of his, not staged');
});

test('a work file changed during the press itself: changed, no wip/ branch on the server, the repository on its own branch', async () => {
  await reset(D);
  const { dropProject } = await import('../../src/workspace/drop.mjs');
  const { fingerprint } = await import('../../src/workspace/dropweb.mjs');
  const readme = path.join(api(), 'README.md');
  fs.writeFileSync(readme, 'shown on the sheet\n');
  const fp = fingerprint(await dropProject('shop', { ctx: D.ctx, mode: 'check' }));
  const before = Object.keys(serverHeads(w, 'shop-api'));
  const r = await dropProject('shop', {
    ctx: D.ctx, mode: 'drop', checked: (x) => fingerprint(x) === fp, share: async () => ({ done: false }),
    ask: { work: async () => true, defaultBranch: async () => 'push', confirm: async () => false },
    onStep: (s, what) => {
      if (s === 'fetch' && String(what).endsWith('shop-web')) fs.appendFileSync(readme, 'LATE-LINE\n');
    },
  });
  assert.equal(r.result, 'changed', JSON.stringify(r));
  assert.deepEqual(Object.keys(serverHeads(w, 'shop-api')), before, 'no wip/ branch went up');
  assert.equal(fs.readFileSync(readme, 'utf8'), 'shown on the sheet\nLATE-LINE\n', 'his file as he left it');
  assert.equal(w.sh(api(), 'symbolic-ref', '--short', 'HEAD'), 'main', 'still on its own branch');
  assert.equal(w.sh(api(), 'for-each-ref', '--format=%(refname)', 'refs/heads/wip'), '', 'no wip/ branch here either');
});
