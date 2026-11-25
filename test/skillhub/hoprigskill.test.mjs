// What is learned about using Hoprig itself goes into the learned skill `hoprig-learned`, beside the generated
// `hoprig` skill, which stays as tools/build-skill.mjs makes it. A temporary computer: an AI brain that is a git
// repository with a local bare "server", a Work list in it, and a stand-in for the model turn.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { tempWork } from '../work/helpers.mjs';

const t = tempWork('hoprigskill');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { resolvePlace } = await import('../../src/work/place.mjs');
const { writeRun, writerId } = await import('../../src/work/runs.mjs');
const { learnFeature } = await import('../../src/skillhub/learnfeature.mjs');
const { parseLook, lookPrompt, HOPRIG_LEARNED, LEARNED_DESCRIPTION } = await import('../../src/skillhub/learnlook.mjs');
const { writeLearnSettings, learnDir } = await import('../../src/skillhub/learnset.mjs');
const learned = await import('../../src/skillhub/learned.mjs');
const { listInstalled } = await import('../../src/skillhub/store.mjs');

const OWN = '---\nname: testing-first\ndescription: How tests are run in this workspace.\n---\n\n# Testing first\n\nRun the tests.\n';
const GENERATED = '---\nname: hoprig\ndescription: Use Hoprig on this computer.\n---\n\n# Hoprig\n\nThe generated skill.\n';
t.repo(t.brain, { 'BRAIN.md': '# brain\n', 'work/tasks.json': '{\n  "items": []\n}\n', 'skills/testing-first/SKILL.md': OWN, 'skills/hoprig/SKILL.md': GENERATED });
saveConfig({});
writeProfile('sub', { label: 'Main' });
const place = () => resolvePlace({});
const git = (...a) => t.git(t.brain, ...a);

const answers = [];
const calls = [];
const turn = async (req) => {
  calls.push(req);
  if (!req.system.startsWith('You review')) return { ok: true, text: `answer (${req.system.includes('<skill>') ? 'with' : 'without'})`, usd: 0, tokens: 10 };
  const a = answers.length ? answers.shift() : { kind: 'nothing', why: 'nothing to keep' };
  return { ok: true, text: JSON.stringify(a), usd: 0.002, tokens: 1500 };
};
const sctx = { config: () => ({}), readJson: async (req) => req.body || {}, notify: async () => ({ sent: false }), caller: () => 'page' };
const feature = learnFeature(sctx, { turn, now: () => Date.parse('2026-11-18T10:00:00Z'), log: () => {} });
const call = async (method, p, body = {}) => {
  for (const [m, re, fn] of feature.routes) {
    const match = re.exec(p);
    if (match && m === method) return fn(Object.assign(Readable.from([]), { body, headers: {} }), match, new URLSearchParams());
  }
  throw new Error(`no route ${method} ${p}`);
};

let n = 0;
function runOf(item) {
  n += 1;
  const id = `20261118-0900${String(n).padStart(2, '0')}-${crypto.randomBytes(4).toString('hex')}`;
  const doc = JSON.parse(fs.readFileSync(place().file, 'utf8'));
  doc.items = doc.items.filter((x) => x.id !== item);
  doc.items.push({ id: item, title: `Task ${item}`, date: null, kind: 'task', status: 'review', created: '2026-11-18' });
  fs.writeFileSync(place().file, `${JSON.stringify(doc, null, 2)}\n`);
  const run = {
    v: 1, id, item, title: `Task ${item}`, writer: writerId(), by: 'owner', startedAt: '2026-11-18T09:00:00Z', endedAt: '2026-11-18T09:05:00Z',
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null, session: null, conversation: null, message: null,
    brief: 'Start a session on the second provider.', state: 'done', reason: null, answer: 'Started it from the dashboard.', commits: [], changed: [],
    more: 0, was: 'open', statusError: null,
  };
  writeRun(place(), run);
  return run;
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('it did not happen in time');
}
const resetLedger = () => {
  for (const f of ['ledger.json', 'declined.json']) fs.rmSync(path.join(learnDir(), f), { force: true });
};
const turnOn = () => writeLearnSettings({ on: true, provider: 'sub', perWeek: 10 }, { providers: ['sub', 'auto'] });
const lookAt = async (answer, item, run = runOf(item)) => {
  answers.push(answer);
  return feature.look({ run, trigger: 'sent-back', words: 'start it from the Sessions page next time' });
};
const draftFrom = async (answer, item) => {
  const r = await lookAt(answer, item);
  assert.equal(r.result, 'draft', JSON.stringify(r));
  await until(() => learned.readDraft(r.id).state === 'ready');
  return learned.readDraft(r.id);
};

const NEW = { kind: 'new', name: 'hoprig', description: 'Start a session on another provider from the Sessions page.', steps: '1. Open Sessions.\n2. Press Continue on the other provider.', why: 'The owner sent it back: the dashboard does this.', tests: ['Continue my session on the other provider', 'My provider is at its limit, go on'] };
const PATCH = { kind: 'patch', skill: 'hoprig', body: 'Use `hop doctor` before a setup step.', why: 'The owner asked for the check first.', tests: ['Set up this computer', 'Check that Hoprig is fine'] };
const SHOWN = { skills: ['testing-first'], hoprigLearned: { body: null } };

// ---------- the parse ----------

test('a lesson aimed at hoprig is a new hoprig-learned the first time, never a change of hoprig', () => {
  for (const answer of [NEW, PATCH, { ...NEW, name: HOPRIG_LEARNED }]) {
    const p = parseLook(JSON.stringify(answer), SHOWN);
    assert.equal(p.kind, 'new', JSON.stringify(answer));
    assert.equal(p.name, HOPRIG_LEARNED);
    assert.notEqual(p.target, 'hoprig');
    assert.equal(p.description, LEARNED_DESCRIPTION);
    assert.match(p.body, /^# Hoprig learned\n\n## When to use\n\nWhat was learned about using Hoprig on this computer/);
    assert.ok(p.body.includes(answer.kind === 'new' ? answer.steps : answer.body), 'the lesson is in it');
  }
  assert.equal(LEARNED_DESCRIPTION.startsWith('What was learned about using Hoprig on this computer'), true);
});

test('after the first, a lesson aimed at hoprig or hoprig-learned is added to hoprig-learned as a change', () => {
  const was = '# Hoprig learned\n\n## When to use\n\nx\n\n## Lesson\n\nThe first one.';
  const shown = { skills: ['testing-first', HOPRIG_LEARNED], hoprigLearned: { body: was } };
  for (const answer of [NEW, PATCH, { ...PATCH, skill: HOPRIG_LEARNED }]) {
    const p = parseLook(JSON.stringify(answer), shown);
    assert.equal(p.kind, 'patch');
    assert.equal(p.target, HOPRIG_LEARNED);
    assert.ok(p.body.startsWith(`${was}\n\n## Lesson\n\n`), 'the lessons before it are kept');
    assert.ok(p.body.includes(answer.kind === 'new' ? answer.steps : answer.body));
  }
  assert.throws(() => parseLook(JSON.stringify(NEW), { ...shown, waiting: [HOPRIG_LEARNED] }), (e) => e.rule === 'waiting');
  assert.throws(() => parseLook(JSON.stringify({ ...PATCH, body: '---\nname: x\n---\nbody' }), shown), (e) => e.rule === 'front-matter');
  assert.throws(() => parseLook(JSON.stringify({ ...PATCH, body: 'Open /home/alex/shop/.env' }), shown), (e) => e.rule === 'path');
  const long = Array(150).fill('Open the Sessions page first.').join('\n');
  assert.throws(() => parseLook(JSON.stringify({ ...NEW, steps: long }), { ...shown, hoprigLearned: { body: 'y'.repeat(4500) } }), (e) => e.rule === 'too-long');
  assert.throws(() => parseLook(JSON.stringify(NEW), { ...shown, hoprigLearned: { blocked: true } }), (e) => e.rule === 'yours');
  assert.throws(() => parseLook(JSON.stringify({ ...PATCH, body: `${was}\n\n## Lesson\n\n` }), shown), (e) => e.rule === 'empty');
  // His whole text sent back with one lesson more: only the new lesson is added, once.
  const again = parseLook(JSON.stringify({ ...PATCH, skill: HOPRIG_LEARNED, body: `${was}\n\n## Lesson\n\nThe second one.` }), shown);
  assert.equal(again.body, `${was}\n\n## Lesson\n\nThe second one.`);
  assert.equal(again.lesson, 'The second one.');
});

test('without the place for lessons, hoprig stays refused as before: reserved for a new one, not shown for a change', () => {
  assert.throws(() => parseLook(JSON.stringify(NEW), { skills: ['testing-first'] }), (e) => e.rule === 'reserved');
  assert.throws(() => parseLook(JSON.stringify(PATCH), { skills: ['testing-first'] }), (e) => e.rule === 'not-shown');
  // A plain new skill of any other name is what it was.
  const other = parseLook(JSON.stringify({ ...NEW, name: 'start-elsewhere' }), SHOWN);
  assert.deepEqual([other.kind, other.name, other.description], ['new', 'start-elsewhere', NEW.description]);
});

// ---------- the whole way: a look, Install, the next lesson, Undo, Discard ----------

/** Every file below `root`: path → hash and mode. */
function snapshot(root) {
  const out = {};
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isSymbolicLink()) out[p] = `link:${fs.readlinkSync(p)}`;
      else out[p] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:${fs.statSync(p).mode}`;
    }
  };
  visit(root);
  return out;
}
const learnedFile = () => path.join(t.brain, 'skills', HOPRIG_LEARNED, 'SKILL.md');

test('with learning off a lesson about Hoprig drafts nothing and nothing on the computer changes', async () => {
  const run = runOf('off-task');
  const before = snapshot(t.root);
  answers.push(NEW);
  const r = await feature.look({ run, trigger: 'sent-back', words: 'use the dashboard' });
  assert.deepEqual(r, { skipped: 'off' });
  answers.length = 0;
  assert.deepEqual(snapshot(t.root), before);
  assert.equal(learned.listDrafts().length, 0);
  assert.equal(calls.length, 0, 'the model was called');
});

test('first lesson: a new hoprig-learned at user scope; Install is one commit; hoprig itself is never touched', async () => {
  turnOn();
  resetLedger();
  const generated = fs.readFileSync(path.join(t.brain, 'skills/hoprig/SKILL.md'), 'utf8');
  const d = await draftFrom(NEW, 'first-lesson');
  assert.deepEqual([d.kind, d.name, d.description], ['new', HOPRIG_LEARNED, LEARNED_DESCRIPTION]);
  assert.equal(d.risky, false, JSON.stringify(d.riskyWhy));
  assert.match(d.skillMd, /^---\nname: hoprig-learned\n[\s\S]*learned-by: hoprig[\s\S]*## Lesson\n\nStart a session on another provider/);
  assert.ok(d.tests.every((x) => x.without && x.with), 'its test requests were tried');
  const r = await call('POST', `/api/skills/learned/${d.id}/install`);
  assert.equal(r.name, HOPRIG_LEARNED);
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['skills/hoprig-learned/SKILL.md']);
  assert.equal(fs.readFileSync(path.join(t.brain, 'skills/hoprig/SKILL.md'), 'utf8'), generated, 'the generated skill changed');
  // Listed beside hoprig in the user's skills folder (the brain's skills/, which Claude Code reads through its link).
  const listed = listInstalled({ kind: 'user', dir: path.join(t.brain, 'skills') });
  assert.ok(listed.some((s) => s.name === 'hoprig'));
  assert.deepEqual(listed.find((s) => s.name === HOPRIG_LEARNED).learned, { from: `work run ${d.source.run}`, on: '2026-11-18' });
  assert.ok(!(await learned.ownSkills({ brain: t.brain })).some((s) => s.name === 'hoprig'), 'hoprig is never offered for a change');
});

test('the next lesson is a change of hoprig-learned that keeps the first; Undo takes back only it', async () => {
  resetLedger();
  const first = fs.readFileSync(learnedFile(), 'utf8');
  const d = await draftFrom(PATCH, 'second-lesson');
  assert.deepEqual([d.kind, d.name], ['patch', HOPRIG_LEARNED]);
  assert.equal(d.before, first);
  assert.ok(d.skillMd.startsWith(first.trimEnd()), 'the first lesson and the front matter are kept');
  assert.match(d.skillMd, /## Lesson\n\nUse `hop doctor` before a setup step\.\n$/);
  assert.equal(d.risky, false, JSON.stringify(d.riskyWhy));
  await call('POST', `/api/skills/learned/${d.id}/install`);
  assert.equal(fs.readFileSync(learnedFile(), 'utf8'), d.skillMd);
  await call('POST', `/api/skills/learned/${d.id}/undo`);
  assert.equal(fs.readFileSync(learnedFile(), 'utf8'), first, 'Undo did not bring the first lesson back');
  // The first lesson's Undo now meets the rule every learned skill has: a later commit touched it (the second and
  // its revert), so it is refused and nothing is lost.
  const firstDraft = learned.listDrafts().find((x) => x.kind === 'new' && x.name === HOPRIG_LEARNED);
  await assert.rejects(call('POST', `/api/skills/learned/${firstDraft.id}/undo`), (e) => e.details && e.details.code === 'changed-since');
  assert.equal(fs.readFileSync(learnedFile(), 'utf8'), first);
  assert.ok(fs.existsSync(path.join(t.brain, 'skills/hoprig/SKILL.md')));
  // The tests below start without hoprig-learned, as he would after removing it himself.
  git('rm', '-q', '-r', `skills/${HOPRIG_LEARNED}`);
  git('commit', '-q', '-m', 'Remove hoprig-learned');
});

test('a discarded lesson is not offered again, and it does not stop another lesson', async () => {
  resetLedger();
  const d = await draftFrom(NEW, 'discard-lesson');
  await call('POST', `/api/skills/learned/${d.id}/discard`);
  assert.deepEqual(await lookAt(NEW, 'discard-again'), { result: 'declined' });
  const other = await draftFrom({ ...NEW, description: 'Read the limits on the Providers page.', steps: '1. Open Providers.\n2. Read when each limit resets.' }, 'other-lesson');
  assert.equal(other.name, HOPRIG_LEARNED);
  await call('POST', `/api/skills/learned/${other.id}/discard`);
});

test('hoprig-learned with a change of his not committed: the look is refused and the brain is as it was', async () => {
  resetLedger();
  fs.mkdirSync(path.dirname(learnedFile()), { recursive: true });
  fs.writeFileSync(learnedFile(), '---\nname: hoprig-learned\ndescription: mine\n---\n\nMy own notes.\n');
  const run = runOf('his-change');
  const before = snapshot(t.brain);
  const r = await lookAt(NEW, 'his-change', run);
  assert.deepEqual([r.result, r.rule], ['refused', 'yours']);
  assert.deepEqual(snapshot(t.brain), before);
  assert.equal(learned.listDrafts().filter((x) => x.state === 'ready' || x.state === 'trying').length, 0);
  fs.rmSync(path.dirname(learnedFile()), { recursive: true });
});

test('the guide, the changelog and the generated skill say what the code does', async () => {
  const ROOT = path.resolve(import.meta.dirname, '..', '..');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const flat = (s) => s.replace(/\s+/g, ' ');
  const { DRAFTS_PER_WEEK } = await import('../../src/skillhub/learnset.mjs');
  assert.equal(DRAFTS_PER_WEEK, 3);
  const doc = flat(read('docs/SKILLS.md'));
  const section = doc.slice(doc.indexOf('## Skills learned from your work'), doc.indexOf('## The catalog'));
  assert.ok(section.includes('The `hoprig` skill itself is made by Hoprig and is never changed by a look. A lesson about using Hoprig (its pages, its `hop` commands) becomes a draft for a skill of its own, `hoprig-learned`, beside it in your skills: a new skill the first time, and after that a change that adds one lesson below the ones there, by every rule above (off until you turn learning on, your **Install**, **Undo**, the scan, at most three drafts a week). The `hoprig` skill tells your coding tool to read `hoprig-learned` too when it is there.'));
  assert.ok(read('site/content/changelog.md').includes('- **What is learned about using Hoprig is kept in a skill of its own.** A lesson about Hoprig\'s own pages and commands becomes a draft for `hoprig-learned`'));
  const line = 'If a skill named hoprig-learned is installed, read it too: it holds what was learned about using Hoprig on this computer.';
  for (const f of ['templates/skills/hoprig.src.md', 'templates/skills/hoprig/SKILL.md', 'packages/hoprig-skill/skill/SKILL.md']) assert.ok(read(f).includes(line), f);
  assert.equal(HOPRIG_LEARNED, 'hoprig-learned');
});

test('the look is told where a lesson about Hoprig goes', () => {
  const { system } = lookPrompt({ brief: 'b', words: null, answer: 'a', files: [] }, {});
  assert.match(system, /about using Hoprig itself[^\n]*"hoprig-learned"[^\n]*never into "hoprig"/);
});
