// "Plan with AI" (src/work/planai.mjs) with a stand-in chat feature on a temporary computer: the session starts in the
// project with the first message, its answer becomes a proposal and nothing is in the repository before Accept (the
// whole tree compared); Accept with the owner's changes writes plan, note and tasks; Dismiss leaves nothing; an answer
// that does not parse is shown with the reason and stays readable; characters that cannot be seen are taken out on his
// word; a restart settles a proposal whose session ended meanwhile; a task that waits for another is not started.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repoTree as wholeRepo, tempWork } from './helpers.mjs';

const t = tempWork('work-planai');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { resolvePlace } = await import('../../src/work/place.mjs');
const { readDoc } = await import('../../src/work/store.mjs');
const { planRunner } = await import('../../src/work/planai.mjs');
const { workRuns } = await import('../../src/work/doit.mjs');
const { readPlan, readNote } = await import('../../src/work/plans.mjs');
const { proposalHash } = await import('../../src/work/proposal.mjs');
const { withWaits } = await import('../../src/work/planview.mjs');
const { listProposals } = await import('../../src/work/proposals.mjs');
const { readProposal: readProposalRaw } = await import('../../src/work/proposals.mjs');

t.repo(t.brain, { 'README.md': '# brain\n', 'work/tasks.json': '{\n  "items": []\n}\n' });
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'index.html': '<p>shop</p>\n' });
t.repo(path.join(t.projects, 'blog'));
const cfg = { work: { ownerId: 'alex' }, sessionDefaults: { model: 'haiku', effort: 'low' } };
saveConfig(cfg);
writeProfile('sub', { label: 'Main' });
const place = () => resolvePlace(cfg);

/** A stand-in for the chat feature: a session works until the test ends its turn. */
const chats = new Map();
const chat = {
  async open(o) {
    const id = crypto.randomUUID();
    chats.set(id, { busy: true, lastEnd: null, lastText: '', o, fns: [] });
    return { sent: true, id, messageId: crypto.randomUUID() };
  },
  peek(id) {
    const c = chats.get(id);
    return c ? { busy: c.busy, pending: false, lastEnd: c.lastEnd, lastText: c.lastText, lastError: c.lastError || null, conversationId: 'conv1', model: 'haiku', effort: 'low' } : null;
  },
  follow(id, fn) {
    chats.get(id).fns.push(fn);
    return () => {
      chats.get(id).fns = chats.get(id).fns.filter((f) => f !== fn);
    };
  },
  turnEnd: () => null,
  end(id, lastEnd, text, { quiet = false, error = null } = {}) {
    const c = chats.get(id);
    Object.assign(c, { busy: false, lastEnd, lastText: text, lastError: error });
    if (!quiet) for (const f of c.fns) f(this.peek(id));
  },
};
const runner = (o = {}) => planRunner({ config: () => cfg, chat, defaultProvider: async () => 'sub', now: () => new Date('2026-11-18T09:00:00Z'), ...o });
const planner = runner();
test.after(() => planner.close());

const good = {
  title: 'Make the shop site faster',
  goal: 'The home page loads in two seconds on a phone.',
  note: '## What exists\n- One page, `index.html`.\n- See https://example.com/speed.',
  milestones: [{ title: 'Measured', date: '2026-11-25' }, { title: 'Fast', date: '2026-12-04' }],
  tasks: [
    { title: 'Measure the page', date: '2026-11-24', milestone: 1, by: 'ai', after: [], brief: 'Measure the load time of index.html.', check: 'A table of load times.' },
    { title: 'Shrink what is large', date: '2026-12-01', milestone: 2, by: 'ai', after: [1], brief: 'Make the large files small.', check: null },
    { title: 'Say yes to the new page', date: null, milestone: 2, by: 'me', after: [2], brief: null, check: null },
  ],
};
const answer = (p) => `I read the project.\n\n\`\`\`json\n${JSON.stringify(p, null, 2)}\n\`\`\``;
/** The whole Work repository: every file and its content, and its HEAD. */
const repoTree = () => wholeRepo(t.brain);
const until = async (what, fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('the compare of the Work repository sees the index and ignored files, not only the working tree and HEAD', () => {
  const before = repoTree();
  fs.writeFileSync(path.join(t.brain, '.gitignore'), 'out/\n');
  t.git(t.brain, 'add', '.gitignore');
  fs.rmSync(path.join(t.brain, '.gitignore'));
  assert.notDeepEqual(repoTree(), before, 'a change only in the index');
  t.git(t.brain, 'rm', '-q', '--cached', '.gitignore');
  assert.deepEqual(repoTree(), before);
  fs.mkdirSync(path.join(t.brain, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(t.brain, '.git', 'info', 'exclude'), 'report.txt\n');
  fs.writeFileSync(path.join(t.brain, 'report.txt'), 'written by a session\n');
  assert.notDeepEqual(repoTree(), before, 'an ignored file');
  fs.rmSync(path.join(t.brain, 'report.txt'));
  fs.rmSync(path.join(t.brain, '.git', 'info', 'exclude'));
  assert.deepEqual(repoTree(), before);
});

test('Plan starts a session in the project with the first message; its answer is a proposal, and nothing is in the repository before Accept', async () => {
  const before = repoTree();
  const ch = await planner.choices({ project: 'shop' });
  assert.deepEqual([ch.provider, ch.model, ch.effort], ['sub', 'haiku', 'low'], 'the defaults as Do it has them');
  const r = await planner.start({ goal: 'Make this small site load faster', project: 'shop', also: ['blog'] });
  const p = r.proposal;
  assert.equal(p.state, 'working');
  const c = chats.get(p.session);
  assert.equal(c.o.dir, shop);
  assert.equal(c.o.profile, 'sub');
  assert.equal(c.o.permissionMode, 'manual', 'it asks before any change, whatever the New-session default');
  assert.match(c.o.text, /^Make a plan for this goal/);
  assert.match(c.o.text, /Make this small site load faster/);
  assert.match(c.o.text, /## Procedure/);
  assert.match(c.o.title, /^Plan: Make this small site load faster/);
  assert.deepEqual(repoTree(), before, 'nothing while it plans');
  chat.end(p.session, 'ok', answer(good));
  const ready = await until('ready', () => planner.list().find((x) => x.id === p.id && x.state === 'ready'));
  assert.equal(ready.title, 'Make the shop site faster');
  assert.equal(ready.tasks, 3);
  const full = planner.get(p.id);
  assert.deepEqual(full.proposal.projects, ['shop', 'blog']);
  assert.deepEqual(repoTree(), before, 'nothing before the yes: the whole tree as it was');
  // A restart of the dashboard: the proposal is still there for a new runner.
  const again = runner();
  assert.equal(again.get(p.id).state, 'ready');
  again.close();

  // Accept with his changes: a title, a date, who does it, a task taken out.
  await assert.rejects(planner.accept(p.id, { seen: 'deadbeefdeadbeef' }), /changed since it was shown/);
  const a = await planner.accept(p.id, { seen: full.hash, title: 'Faster shop', tasks: { 0: { date: '2026-11-23', by: 'tester' } }, drop: { tasks: [1] } });
  const plan = readPlan(place(), a.plan);
  assert.equal(plan.title, 'Faster shop');
  assert.match(readNote(place(), plan), /One page/);
  const items = readDoc(place().file).doc.items;
  assert.deepEqual(items.map((x) => [x.id, x.date, x.by, x.after || []]), [['measure-the-page', '2026-11-23', 'tester', []], ['say-yes-to-the-new-page', null, 'me', []]]);
  assert.throws(() => planner.get(p.id), /no such proposal/);
  assert.notDeepEqual(repoTree().files, before.files, 'after the yes the files are there');
});

test('Dismiss throws a proposal away and leaves nothing', async () => {
  const before = repoTree();
  const { proposal: p } = await planner.start({ goal: 'Grow the blog', project: 'blog' });
  chat.end(p.session, 'ok', answer({ ...good, projects: ['blog'], tasks: [good.tasks[0]], milestones: [good.milestones[0]] }));
  await until('ready', () => planner.list().find((x) => x.id === p.id && x.state === 'ready'));
  assert.deepEqual(planner.dismiss(p.id), { dismissed: true });
  assert.equal(listProposals(place()).some((x) => x.id === p.id), false);
  assert.deepEqual(repoTree(), before);
});

test('an answer that does not parse is shown with the reason, and stays readable as text; hidden characters are taken out on his word', async () => {
  const { proposal: p } = await planner.start({ goal: 'A plan that fails', project: 'shop' });
  chat.end(p.session, 'ok', 'I could not decide. Here is some text instead, with no plan in it.');
  const u = await until('unreadable', () => planner.list().find((x) => x.id === p.id && x.state === 'unreadable'));
  assert.match(u.problem, /^the session did not answer with a plan in the shape Hoprig reads/, 'plain words; the answer itself is shown below them');
  assert.match(planner.get(p.id).answer, /I could not decide/);
  await assert.rejects(planner.accept(p.id, { seen: 'x' }), /only a proposal that was read/);

  const { proposal: h } = await planner.start({ goal: 'A plan with hidden words', project: 'shop' });
  chat.end(h.session, 'ok', answer({ ...good, title: 'Make the shop​ site\u{E0041} faster' }));
  const hv = await until('unreadable', () => planner.list().find((x) => x.id === h.id && x.state === 'unreadable'));
  assert.match(hv.problem, /cannot be seen.*take it out/);
  const cleaned = planner.clean(h.id);
  assert.equal(cleaned.state, 'ready');
  assert.equal(cleaned.cleaned, true);
  assert.equal(cleaned.proposal.title, 'Make the shop site faster');
  assert.throws(() => planner.clean(p.id), /no characters that cannot be seen/);

  // A mark that turns the direction of the text around is one of them too: refused, and taken out on his word.
  const { proposal: d } = await planner.start({ goal: 'A plan with a turned title', project: 'shop' });
  chat.end(d.session, 'ok', answer({ ...good, title: 'Measure \u202Egnp.exe the page', note: 'One \u2067page\u2069.' }));
  const dv = await until('unreadable', () => planner.list().find((x) => x.id === d.id && x.state === 'unreadable'));
  assert.match(dv.problem, /direction/);
  assert.equal(planner.get(d.id).problem.code, 'hidden');
  const dc = planner.clean(d.id);
  assert.equal(dc.state, 'ready', JSON.stringify(dc.problem));
  assert.equal(dc.proposal.title, 'Measure gnp.exe the page');
  assert.equal(dc.proposal.note, 'One page.');
});

test('an answer is masked before it is kept: a key and this computer\'s home folder never reach a plan', async () => {
  const key = `sk-ant-api03-${'a'.repeat(90)}`;
  const { proposal: p } = await planner.start({ goal: 'A plan with a secret in it', project: 'shop' });
  chat.end(p.session, 'ok', answer({ ...good, note: `Found ${key} in ${t.home}/Workspace/projects/shop/.env` }));
  await until('ready', () => planner.list().find((x) => x.id === p.id && x.state !== 'working'));
  const v = planner.get(p.id);
  assert.ok(!JSON.stringify(v).includes(key), 'the key is masked');
  assert.ok(!JSON.stringify(v).includes(t.home), 'no home folder');
  planner.dismiss(p.id);
});

test('a session that ends at a limit or in an error is a failed proposal with the reason; a restart settles one that ended meanwhile', async () => {
  const { proposal: p } = await planner.start({ goal: 'Hit the limit', project: 'shop' });
  chat.end(p.session, 'limit', '');
  const f = await until('failed', () => planner.list().find((x) => x.id === p.id && x.state === 'failed'));
  assert.match(f.reason, /usage limit/);
  // A crash: plain words first and what to do, the coding tool's own words after them.
  const { proposal: e } = await planner.start({ goal: 'Crash on the way', project: 'shop' });
  chat.end(e.session, 'error', '', { error: 'Claude Code stopped (3)' });
  const ef = await until('failed', () => planner.list().find((x) => x.id === e.id && x.state === 'failed'));
  assert.equal(ef.reason, 'The session stopped with an error before it answered: open the session to see what happened, or plan again (the coding tool said: Claude Code stopped (3))');
  // The dashboard was down when the turn ended (nobody followed it): the next runner settles it from the chat.
  const { proposal: q } = await planner.start({ goal: 'Ends while the dashboard is down', project: 'shop' });
  planner.close();
  chat.end(q.session, 'ok', answer(good), { quiet: true });
  const next = runner();
  next.settleWorking();
  assert.equal(next.get(q.id).state, 'ready');
  // A session that is gone for good.
  const { proposal: g } = await next.start({ goal: 'Gone for good', project: 'shop' });
  next.close();
  chats.delete(g.session);
  const third = runner();
  third.settleWorking();
  assert.equal(third.get(g.id).state, 'failed');
  assert.match(third.get(g.id).reason, /gone/);
  third.close();
});

test('a task of a plan that waits for another not done yet is not started by Do it', async () => {
  const runs = workRuns({ config: () => cfg, chat, defaultProvider: async () => 'sub' });
  try {
    const doc = readDoc(place().file).doc;
    doc.items.push({ id: 'first-step', title: 'First step', status: 'open', source: 'alex', project: 'shop' }, { id: 'second-step', title: 'Second step', status: 'open', source: 'alex', project: 'shop', after: ['first-step'] });
    fs.writeFileSync(place().file, `${JSON.stringify(doc, null, 2)}\n`);
    await assert.rejects(runs.start('second-step', { seen: 'Second step' }), (e) => e.status === 409 && /waits for "first-step"/.test(e.message));
    doc.items.find((x) => x.id === 'first-step').status = 'done';
    fs.writeFileSync(place().file, `${JSON.stringify(doc, null, 2)}\n`);
    const r = await runs.start('second-step', { seen: 'Second step' });
    assert.ok(r.run && r.run.state === 'running');
    // A task it waits for that was dropped will never be done: it no longer holds the next one back.
    doc.items.push({ id: 'dropped-step', title: 'Dropped step', status: 'dropped', source: 'alex', project: 'shop' }, { id: 'after-dropped', title: 'After the dropped step', status: 'open', source: 'alex', project: 'shop', after: ['dropped-step'] });
    fs.writeFileSync(place().file, `${JSON.stringify(doc, null, 2)}\n`);
    assert.deepEqual(withWaits(readDoc(place().file).doc.items).find((x) => x.id === 'after-dropped').waits, [], 'the page says it waits for nothing');
    const r2 = await runs.start('after-dropped', { seen: 'After the dropped step' });
    assert.ok(r2.run && r2.run.state === 'running');
  } finally {
    runs.close();
  }
});

test('the proposal\'s hash is what Accept names as seen', () => {
  assert.equal(proposalHash({ a: 1 }).length, 16);
});

test('Plan with AI and "Lead model": off as before; on from a choice or Settings, saved with the proposal', async () => {
  const ch = await planner.choices({ project: 'shop' });
  assert.equal(ch.lead, false, 'off unless Settings has it');
  assert.match(ch.leadLine, /\S/, 'one line on which models it would use, or why not');
  const off = await planner.start({ goal: 'Plan the footer', project: 'shop' });
  assert.equal(chats.get(off.proposal.session).o.lead, false, 'off: the chat is opened without Lead');
  assert.equal('lead' in readProposalRaw(off.proposal.id), false, 'off writes nothing new into the proposal');
  const on = await planner.start({ goal: 'Plan the header', project: 'shop', lead: true });
  assert.equal(chats.get(on.proposal.session).o.lead, true);
  assert.equal(readProposalRaw(on.proposal.id).lead, true, 'saved with the proposal');
  cfg.sessionDefaults.lead = true;
  try {
    assert.equal((await planner.choices({ project: 'shop' })).lead, true);
    const byDefault = await planner.start({ goal: 'Plan the menu', project: 'shop' });
    assert.equal(chats.get(byDefault.proposal.session).o.lead, true, 'Settings → New-session defaults');
    const chosen = await planner.start({ goal: 'Plan the logo', project: 'shop', lead: false });
    assert.equal(chats.get(chosen.proposal.session).o.lead, false, 'a choice wins over the default');
  } finally {
    delete cfg.sessionDefaults.lead;
  }
  await assert.rejects(planner.start({ goal: 'x', project: 'shop', lead: 'yes' }), /lead is true or false/);
  writeProfile('alpha', { label: 'Alpha', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8243', ANTHROPIC_AUTH_TOKEN: 'sk-alpha-test-0123456789' } });
  const ticked = await planner.start({ goal: 'Plan the cart', project: 'shop', lead: true, others: ['alpha'] });
  assert.deepEqual(chats.get(ticked.proposal.session).o.others, ['alpha'], 'the ticks go to the chat');
  assert.deepEqual(readProposalRaw(ticked.proposal.id).others, ['alpha'], 'and are saved with the proposal');
  await assert.rejects(planner.start({ goal: 'x', project: 'shop', lead: true, others: ['nobody'] }), /no provider "nobody"/);
  chat.end(ticked.proposal.session, 'ok', 'no plan');
  for (const id of [off, on].map((x) => x.proposal.session)) chat.end(id, 'ok', 'no plan');
});

test('Plan with AI without a provider says so with the code that draws the button to Providers', async () => {
  const none = runner({ defaultProvider: async () => null });
  try {
    await assert.rejects(none.start({ goal: 'Plan the footer', project: 'shop' }), (e) => {
      assert.match(e.message, /there is no provider for this coding tool yet: add one under Providers first/);
      assert.equal(e.status, 400);
      assert.deepEqual(e.details, { code: 'no-provider' });
      return true;
    });
  } finally {
    none.close();
  }
});
