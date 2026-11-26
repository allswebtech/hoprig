// The runner of "Do it" (src/work/doit.mjs workRuns) with a stand-in chat feature, on a temporary computer: what a run
// keeps of a session's commits and files, what it never keeps (a key, a full path), and that a run always ends
// (a strange file name, a long list, a write that fails) and never blocks its task for good.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork, write } from './helpers.mjs';

const t = tempWork('work-doitrun');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore, readDoc } = await import('../../src/work/store.mjs');
const { workRuns } = await import('../../src/work/doit.mjs');
const { isRunFile, listRuns, readRun, writeRun, writerId } = await import('../../src/work/runs.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
writeProfile('sub', { label: 'Main' });
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });

/** A stand-in for the chat feature: a session works until the test ends its turn (end). */
const chats = new Map();
const chat = {
  async open(o) {
    const id = crypto.randomUUID();
    chats.set(id, { busy: true, lastEnd: null, lastText: '', text: o.text, title: o.title, model: chat.model || null, fns: [] });
    return { sent: true, id, messageId: crypto.randomUUID() };
  },
  peek(id) {
    const c = chats.get(id);
    return c ? { busy: c.busy, pending: false, lastEnd: c.lastEnd, lastText: c.lastText, conversationId: 'conv1', model: c.model } : null;
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
const logs = [];
const runs = workRuns({ config: () => cfg, chat, defaultProvider: async () => 'sub', log: (s) => logs.push(s) });
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
let n = 0;
/** A new task of project shop: its id. */
async function task(title = `Task number ${++n}`) {
  const r = await store().add({ title, project: 'shop' });
  return r.item.id;
}
/** Start a run of task `id` as the page does (with the brief it showed): the run. */
async function start(id, c = {}) {
  const r = await runs.start(id, c);
  assert.ok(r.run, JSON.stringify(r));
  return r;
}

test('a commit\'s subject is masked and has no full path, in the run file and in what the routes show', async () => {
  const id = await task();
  const { run } = await start(id);
  write(shop, { 'notes.txt': 'n\n' });
  t.git(shop, 'add', 'notes.txt');
  t.git(shop, 'commit', '-q', '-m', `Add key ${'sk-ant-api03-' + 'AAAAAAAAAAAAAAAAAAAAAAAA'} from ${t.home}/secret/notes.txt`);
  chat.end(run.session, 'ok', 'Done.');
  const r = await ended(run.id);
  assert.equal(r.state, 'done');
  assert.equal(r.commits.length, 1);
  assert.equal(r.commits[0].subject, 'Add key *** from ~/secret/notes.txt');
  const text = fs.readFileSync(path.join(place().folder, 'runs', `${run.id}.json`), 'utf8');
  assert.ok(!text.includes(t.root) && !text.includes('sk-ant-api03'), text);
  assert.ok(!JSON.stringify(runs.list()).includes(t.root));
});

test('a project with hundreds of files changed before Start: the run file stays small and the run settles', async () => {
  const many = {};
  for (let i = 0; i < 400; i++) many[`src/components/some/deeper/folder/name/file-number-${String(i).padStart(4, '0')}-with-a-much-longer-name-than-before.tsx`] = `${i}\n`;
  write(shop, many);
  try {
    const id = await task();
    const { run } = await start(id);
    const file = path.join(place().folder, 'runs', `${run.id}.json`);
    assert.ok(fs.statSync(file).size < 8 * 1024, 'what it started from is not in the shared file');
    assert.equal(readRun(place(), run.id).session, run.session, 'it reads back, with its session');
    chat.end(run.session, 'ok', 'All done.');
    const r = await ended(run.id);
    assert.equal(r.state, 'done');
    assert.deepEqual(r.changed, [], 'the files were there before');
    assert.equal(itemOf(id).status, 'review');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('file-number-'), 'no name of a file the owner had before');
  } finally {
    fs.rmSync(path.join(shop, 'src'), { recursive: true, force: true });
  }
});

test('a file name with a control character, before Start and made by the session: Start works and the run ends', { skip: process.platform === 'win32' && 'Windows does not allow this file name (a control character, \':\', \'*\' or \'"\')' }, async () => {
  write(shop, { 'notes\tdraft.md': 'x\n' });
  try {
    const id = await task();
    const { run } = await start(id);
    assert.equal(run.state, 'running');
    write(shop, { 'odd\nname.txt': 'y\n', 'made.txt': 'm\n' });
    chat.end(run.session, 'ok', 'Wrote the notes.');
    const r = await ended(run.id);
    assert.equal(r.state, 'done');
    assert.deepEqual(r.changed.map((c) => c.path), ['made.txt']);
    assert.equal(r.more, 1);
    assert.equal(itemOf(id).status, 'review');
  } finally {
    for (const f of ['notes\tdraft.md', 'odd\nname.txt', 'made.txt']) fs.rmSync(path.join(shop, f), { force: true });
  }
});

test('a model name the coding tool reports in words a run does not take: the run starts and ends all the same', async () => {
  chat.model = 'Opus 4.5 (1M context)';
  try {
    const id = await task();
    const { run } = await start(id, { model: 'opus' });
    assert.equal(run.state, 'running');
    assert.equal(run.model, 'opus', 'the model chosen stays');
    chat.end(run.session, 'ok', 'Done.');
    assert.equal((await ended(run.id)).state, 'done');
  } finally {
    chat.model = null;
  }
});

test('a stop between the task\'s status and the run\'s final record never leaves the task doing for good', { skip: process.platform === 'win32' && 'POSIX modes: a folder made read-only by chmod is still written on Windows' }, async () => {
  const id = await task();
  const { run } = await start(id);
  const dir = path.join(place().folder, 'runs');
  // The final record cannot be written (as if the dashboard stopped right before it): the status is set already, and the
  // run, still running, is settled on the next look.
  fs.chmodSync(dir, 0o555);
  try {
    const before = logs.length;
    chat.end(run.session, 'ok', 'Done.');
    await until('the failed write to be logged', () => logs.slice(before).some((l) => /could not be settled/.test(l)));
    assert.equal(itemOf(id).status, 'review', 'the status first');
    assert.equal(readRun(place(), run.id).state, 'running');
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  runs.settleRunning();
  const r = await ended(run.id);
  assert.equal(r.state, 'done');
  assert.equal(r.statusError, null);
  assert.equal(itemOf(id).status, 'review');
});

test('a running run of another computer is said, and does not block Do it here', async () => {
  const id = await task();
  writeRun(place(), {
    v: 1, id: '20261101-100000-abcdef01', item: id, title: 'Elsewhere', writer: 'ffffffffffffffff', by: 'owner', startedAt: '2026-11-01T10:00:00.000Z', endedAt: null,
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null, session: crypto.randomUUID(), conversation: null, message: null,
    brief: 'Elsewhere', state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null,
  });
  runs.settleRunning();
  const plan = await runs.plan(id);
  assert.equal(plan.running, null);
  assert.equal(plan.elsewhere.id, '20261101-100000-abcdef01');
  assert.equal(plan.elsewhere.here, false);
  const r = await runs.start(id);
  assert.notEqual(r.existing, true);
  assert.notEqual(r.run.id, '20261101-100000-abcdef01');
  assert.equal(r.run.here, true);
  assert.equal(readRun(place(), '20261101-100000-abcdef01').state, 'running', 'another computer\'s run is never written here');
  chat.end(r.run.session, 'ok', 'Done here.');
  assert.equal((await ended(r.run.id)).state, 'done');
});

test('a task waiting for the owner goes back to waiting when its run has no result; a task in review is not started again', async () => {
  const id = await task();
  await store().status(id, 'waiting');
  const { run } = await start(id);
  assert.equal(itemOf(id).status, 'doing');
  chat.end(run.session, 'limit', 'At the limit.');
  const r = await ended(run.id);
  assert.equal(r.state, 'limit');
  assert.equal(r.was, 'waiting');
  assert.equal(itemOf(id).status, 'waiting', 'as he had set it');
  // Done: review. Do it again before Accept or Send back is refused.
  const two = await start(id);
  chat.end(two.run.session, 'ok', 'Done.');
  await ended(two.run.id);
  assert.equal(itemOf(id).status, 'review');
  await assert.rejects(runs.start(id), (e) => e.status === 409 && /waits for your review/.test(e.message));
});

test('a brief made from a task that came from elsewhere is checked before a session gets it: nothing unseen, not too long', async () => {
  const id = await task();
  const doc = JSON.parse(fs.readFileSync(place().file, 'utf8'));
  const raw = doc.items.find((x) => x.id === id);
  // As a merge would write it: a zero-width space and invisible tag characters in the title, a long note.
  raw.title = `Echo merged\u200b\u{E0049}\u{E0047}\u{E004E}`;
  fs.writeFileSync(place().file, `${JSON.stringify(doc, null, 2)}\n`);
  const plan = await runs.plan(id);
  assert.match(plan.briefProblem, /a character that cannot be seen \(U\+200B\)/);
  await assert.rejects(runs.start(id), (e) => e.status === 400 && /cannot be seen \(U\+200B\)/.test(e.message));
  raw.title = 'Echo merged';
  raw.note = 'n'.repeat(5000);
  fs.writeFileSync(place().file, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match((await runs.plan(id)).briefProblem, /1 to 4000 characters/);
  await assert.rejects(runs.start(id), (e) => e.status === 400 && /1 to 4000 characters/.test(e.message));
  assert.equal(listRuns(place(), { item: id }).length, 0, 'nothing started');
  // One emoji made of two joined is text; a brief he writes is checked the same way.
  const ok = await runs.start(id, { brief: 'Fix the \u{1F468}\u200D\u{1F4BB} icon' });
  assert.equal(ok.run.state, 'running');
  chat.end(ok.run.session, 'ok', 'Done.');
  await ended(ok.run.id);
  await store().status(id, 'open');
  await assert.rejects(runs.start(id, { brief: 'Fix it\u2060 now' }), (e) => e.status === 400 && /U\+2060/.test(e.message));
});

test('a brief with characters that cannot be seen comes with the brief without them, and that one, once started, is kept on the task', async () => {
  const id = await task();
  const doc = JSON.parse(fs.readFileSync(place().file, 'utf8'));
  const raw = doc.items.find((x) => x.id === id);
  raw.title = 'Echo the login\u{1F600}\u{E0139}\u{E0137}\u{E013E}';
  raw.note = 'Then\u200b check\u3164it.';
  fs.writeFileSync(place().file, `${JSON.stringify(doc, null, 2)}\n`);
  const plan = await runs.plan(id);
  assert.match(plan.briefProblem, /cannot be seen \(U\+E0139\)/);
  assert.equal(plan.briefClean, 'Echo the login\u{1F600}\n\nThen check it.', 'a filler that showed as a blank is a space');
  // A start with it refused says the same and brings the same (the page offers it then too).
  await assert.rejects(runs.start(id, { seen: plan.brief }), (e) => e.status === 400 && e.details.code === 'brief-hidden' && e.details.clean === plan.briefClean);
  await assert.rejects(runs.start(id, { brief: `${plan.briefClean}\u2060` }), (e) => e.details.code === 'brief-hidden' && e.details.clean === plan.briefClean);
  assert.equal((await runs.plan(id)).briefClean, plan.briefClean);
  const ok = await runs.start(id, { brief: plan.briefClean });
  assert.equal(ok.run.state, 'running');
  chat.end(ok.run.session, 'ok', 'Done.');
  await ended(ok.run.id);
  await store().status(id, 'open');
  const again = await runs.plan(id);
  assert.equal(again.briefProblem, null, 'the next Do it starts from the brief kept on the task');
  assert.equal(again.briefClean, null);
  assert.equal(again.brief, plan.briefClean);
  // A problem of another kind brings nothing to take out.
  const other = await task();
  const d2 = JSON.parse(fs.readFileSync(place().file, 'utf8'));
  d2.items.find((x) => x.id === other).note = 'n'.repeat(5000);
  fs.writeFileSync(place().file, `${JSON.stringify(d2, null, 2)}\n`);
  const long = await runs.plan(other);
  assert.match(long.briefProblem, /1 to 4000/);
  assert.equal(long.briefClean, null);
});

test('Send back again and again: the brief keeps the task\'s own text and the newest words, within its limit', async () => {
  const id = await task('Write the long report');
  const texts = ['a', 'b', 'c', 'd'].map((x) => x.repeat(1500));
  for (const text of texts) {
    const { run } = await start(id);
    chat.end(run.session, 'ok', 'Done.');
    await ended(run.id);
    const r = await runs.sendBack(id, text);
    assert.ok(r.brief.length <= 4000, String(r.brief.length));
    assert.ok(r.brief.startsWith('Write the long report\n\nAfter the last run: '), r.brief.slice(0, 60));
    assert.ok(r.brief.endsWith(`After the last run: ${text}`), 'the newest is there');
  }
  assert.equal((await runs.plan(id)).brief, `Write the long report\n\nAfter the last run: ${texts[2]}\n\nAfter the last run: ${texts[3]}`, 'the oldest that no longer fit left out');
  const { run } = await start(id);
  chat.end(run.session, 'ok', 'Done.');
  await ended(run.id);
  await assert.rejects(runs.sendBack(id, 'e'.repeat(3990)), (e) => e.status === 400 && /write at most 3957 characters/.test(e.message));
  assert.equal(itemOf(id).status, 'review', 'nothing changed');
});

test('the answer on a task\'s row is cut with an ellipsis', async () => {
  const id = await task();
  const { run } = await start(id);
  chat.end(run.session, 'ok', `Line 1: ${'checked the thing. '.repeat(30)}`);
  await ended(run.id);
  const a = runs.latest()[id].answer;
  assert.equal(a.length, 300);
  assert.ok(a.endsWith('…'), a.slice(-20));
});

test('a file whose relative path holds the home folder is counted, never listed, and the run keeps its commits and other files', { skip: process.platform === 'win32' && 'Windows does not allow this file name (a control character, \':\', \'*\' or \'"\')' }, async () => {
  const id = await task();
  const { run } = await start(id);
  write(shop, { 'kept.txt': 'k\n' });
  t.git(shop, 'add', 'kept.txt');
  t.git(shop, 'commit', '-q', '-m', 'Keep the notes');
  const odd = `backup${t.home}/notes.txt`; // relative, yet it holds the full home path
  const keyName = 'notes/ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8.txt'; // a name that is a key
  write(shop, { [odd]: 'n\n', [keyName]: 'k\n', 'made.txt': 'm\n' });
  try {
    chat.end(run.session, 'ok', 'Copied the notes.');
    const r = await ended(run.id);
    assert.equal(r.state, 'done');
    assert.equal(r.reason, null);
    assert.deepEqual(r.commits.map((c) => c.subject), ['Keep the notes']);
    assert.deepEqual(r.changed.map((c) => c.path), ['made.txt']);
    assert.equal(r.more, 2, 'the odd files are counted');
    assert.equal(itemOf(id).status, 'review');
    const file = path.join(place().folder, 'runs', `${run.id}.json`);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(t.home) && !fs.readFileSync(file, 'utf8').includes('A1b2C3'));
    assert.equal(isRunFile(file), true, 'Save takes it as Work\'s');
  } finally {
    fs.rmSync(path.join(shop, 'backup'), { recursive: true, force: true });
    fs.rmSync(path.join(shop, 'notes'), { recursive: true, force: true });
    fs.rmSync(path.join(shop, 'made.txt'), { force: true });
  }
});
