// Save with run files (src/work/runs.mjs): the run files of "Do it" are Work's files. A save commits the list and the
// new or changed run files by name, nothing else, and sends them; a commit that changes only Work's files (the list or
// files right in runs/) is Work's for the rule of what a save may send; a send that fails takes the commit back and
// leaves the run files as they were before the save (not staged).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { endSignal, tempWork, write } from './helpers.mjs';

const t = tempWork('work-saveruns');
test.after(() => t.cleanup());
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { savePlan, saveWork } = await import('../../src/work/save.mjs');
const { sortUnsent } = await import('../../src/work/git.mjs');
const { writeRun, writerId } = await import('../../src/work/runs.mjs');

const SUBJECT = 'Update work items';
const shop = path.join(t.projects, 'shop');
const bare = t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n', 'src/app.js': 'one\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const lines = (...args) => t.git(shop, ...args).split('\n').filter(Boolean).map((l) => l.trim());
const run = (id, extra = {}) => writeRun(place(), {
  v: 1, id, item: 'renew-the-domain', title: 'Renew the domain', writer: writerId(), by: 'owner', startedAt: '2026-11-17T10:00:00.000Z', endedAt: null,
  project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null, session: null, conversation: null, message: null,
  brief: 'Renew the domain', state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null, ...extra,
});

const { STOP_ENV } = await import('../../src/work/save.mjs');
const { spawnSync } = await import('node:child_process');

test('the rule of what a save may send: the list and files right in runs/ are Work\'s; anything else beside them is the owner\'s', () => {
  const c = (files, parents = ['p']) => ({ sha: files.join(), short: 'abc1234', subject: 's', parents, files });
  const o = { rel: 'docs/plans/tasks.json', runsRel: 'docs/plans/runs' };
  const r = sortUnsent([
    c(['docs/plans/tasks.json', 'docs/plans/runs/20261117-100000-aaaaaaaa.json']),
    c(['docs/plans/runs/20261117-100000-bbbbbbbb.json']),
    c(['docs/plans/runs/20261117-100000-cccccccc.json', 'src/app.js']),
    c(['docs/plans/runs/notes.txt']),
    c(['docs/plans/runs/sub/20261117-100000-dddddddd.json']),
    c(['docs/plans/runs/20261117-100000-eeeeeeee.json'], ['p', 'q']),
  ], o);
  assert.equal(r.ours.length, 2);
  assert.equal(r.theirs.length, 4, 'another file beside a run, a file of another name, a nested one, a merge: the owner\'s');
  assert.equal(sortUnsent([c(['docs/plans/runs/20261117-100000-bbbbbbbb.json'])], { rel: o.rel }).theirs.length, 1, 'without the runs folder, a run file is not Work\'s');
});

test('save commits the list and the run files by name, nothing else, and sends them', async () => {
  await store().add({ title: 'Renew the domain' });
  run('20261117-100000-aaaaaaaa');
  run('20261117-110000-bbbbbbbb', { state: 'done', endedAt: '2026-11-17T11:05:00.000Z' });
  write(shop, { 'src/app.js': 'two\n', 'docs/plans/runs/notes.txt': 'not a run\n', 'docs/plans/numbers.json': '{}\n' });
  const plan = await savePlan(place());
  assert.deepEqual(plan.files, [
    { path: 'docs/plans/tasks.json', state: 'changed' },
    { path: 'docs/plans/runs/20261117-100000-aaaaaaaa.json', state: 'new' },
    { path: 'docs/plans/runs/20261117-110000-bbbbbbbb.json', state: 'new' },
  ]);
  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.sent, true);
  assert.match(r.message, /Kept a copy of your list \(1 change\) and 2 runs and uploaded it/);
  assert.deepEqual(lines('show', '--name-only', '--format=%s', 'HEAD'), [SUBJECT, 'docs/plans/runs/20261117-100000-aaaaaaaa.json', 'docs/plans/runs/20261117-110000-bbbbbbbb.json', 'docs/plans/tasks.json']);
  assert.equal(t.git(shop, 'rev-parse', 'HEAD'), t.git(bare, 'rev-parse', 'main'), 'the server has it');
  assert.deepEqual(lines('status', '--porcelain', '--untracked-files=all').sort(), ['?? docs/plans/numbers.json', '?? docs/plans/runs/notes.txt', 'M src/app.js'], 'the rest as it was');
  assert.deepEqual(lines('diff', '--cached', '--name-only'), [], 'nothing left staged');
  fs.rmSync(path.join(shop, 'docs/plans/runs/notes.txt'));
  fs.rmSync(path.join(shop, 'docs/plans/numbers.json'));
  t.git(shop, 'checkout', '-q', '--', 'src/app.js');
});

test('a file of a run\'s name that is no run record (a link to a private file, other content) is never committed nor sent', async () => {
  fs.mkdirSync(path.join(t.home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(t.home, '.ssh', 'id_test'), 'PRIVATE KEY\n');
  const runs = path.join(shop, 'docs/plans/runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.symlinkSync(path.join(t.home, '.ssh', 'id_test'), path.join(runs, '20261117-090000-11111111.json'));
  write(shop, { 'docs/plans/runs/20261117-090000-22222222.json': `PRIVATE NOTES: password=hunter2hunter2\n${'x'.repeat(100_000)}\n` });
  // A run record whose id is not its name, and one too large to be one: not Work's either.
  run('20261117-090000-33333333');
  fs.renameSync(path.join(runs, '20261117-090000-33333333.json'), path.join(runs, '20261117-090000-44444444.json'));
  run('20261117-090000-55555555', { state: 'done', endedAt: '2026-11-17T09:30:00.000Z', answer: 'All done.' });
  const plan = await savePlan(place());
  assert.deepEqual(plan.files, [{ path: 'docs/plans/runs/20261117-090000-55555555.json', state: 'new' }]);
  assert.deepEqual(plan.notRuns, ['docs/plans/runs/20261117-090000-11111111.json', 'docs/plans/runs/20261117-090000-22222222.json', 'docs/plans/runs/20261117-090000-44444444.json']);
  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^Kept 1 run and uploaded it to your git server\. 3 files in docs\/plans\/runs are not a run Work wrote \(a link, or something else\): Work left them alone\./);
  const sent = t.git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(sent.includes('docs/plans/runs/20261117-090000-55555555.json'));
  for (const n of ['11111111', '22222222', '44444444']) assert.ok(!sent.includes(`docs/plans/runs/20261117-090000-${n}.json`), n);
  assert.ok(!t.git(bare, 'log', '-p', 'main').includes('hunter2') && !t.git(bare, 'log', '-p', 'main').includes(t.home), 'nothing of them on the server');
  for (const n of ['11111111', '22222222', '44444444']) fs.rmSync(path.join(runs, `20261117-090000-${n}.json`));
});

test('a run-shaped file whose words were never masked (a key, a password, this computer\'s name) is never committed nor sent', async () => {
  const os = (await import('node:os')).default;
  const was = os.hostname;
  os.hostname = () => 'alexs-box2';
  const runs = path.join(shop, 'docs/plans/runs');
  const done = { state: 'done', endedAt: '2026-11-17T08:30:00.000Z' };
  const key = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const raw = {
    '20261117-080000-11111111': { answer: `password=hunter2hunter2 ${key} https://alex:s3cret@example.com/x` },
    '20261117-080000-22222222': { title: `Use ${key}` },
    '20261117-080000-33333333': { reason: 'It stopped: token=hunter2hunter2' },
    '20261117-080000-44444444': { statusError: 'The status could not be changed on alexs-box2' },
    '20261117-080000-55555555': { commits: [{ repo: '.', short: 'abc1234', subject: `Add ${key}` }] },
    '20261117-080000-66666666': { brief: 'Log in as alex@alexs-box2:~/shop' },
    // ... and in what is no words of a session, yet of a shape that holds a key.
    '20261117-080000-88888888': { provider: key },
    '20261117-080000-99999999': { conversation: key },
    '20261117-080000-aaaaaaaa': { model: `https://alex:s3cret@example.com/m` },
    '20261117-080000-bbbbbbbb': { project: key },
  };
  // A file's path that names a key or this computer: a run never lists it, so its check refuses it.
  const paths = { '20261117-080000-cccccccc': `notes/${key}.txt`, '20261117-080000-dddddddd': 'backup/alexs-box2/notes.txt' };
  try {
    for (const [id, extra] of Object.entries(raw)) run(id, { ...done, ...extra });
    for (const [id, p] of Object.entries(paths)) {
      run(id, done);
      const f = path.join(runs, `${id}.json`);
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), changed: [{ repo: '.', path: p, kind: 'new' }] }));
    }
    // Words as a run writes them (masked, the name taken out) are its own.
    run('20261117-080000-77777777', { ...done, answer: 'password=*** *** https://alex:***@example.com/x on this-computer', commits: [{ repo: '.', short: 'abc1234', subject: 'Add ***' }] });
    const plan = await savePlan(place());
    assert.deepEqual(plan.files, [{ path: 'docs/plans/runs/20261117-080000-77777777.json', state: 'new' }]);
    assert.deepEqual(plan.notRuns, [...Object.keys(raw), ...Object.keys(paths)].sort().map((id) => `docs/plans/runs/${id}.json`));
    const r = await saveWork(place(), { subject: SUBJECT });
    assert.equal(r.ok, true, r.message);
    const log = t.git(bare, 'log', '-p', 'main');
    assert.ok(!log.includes('hunter2') && !log.includes('A1b2C3') && !log.includes('s3cret') && !log.includes('alexs-box2'), 'nothing of them on the server');
  } finally {
    os.hostname = was;
    for (const id of [...Object.keys(raw), ...Object.keys(paths)]) fs.rmSync(path.join(runs, `${id}.json`), { force: true });
  }
});

test('a run of an ordinary task whose id, project or folder reads like the start of a key is Work\'s and is sent', async () => {
  const runs = path.join(shop, 'docs/plans/runs');
  const done = { state: 'done', endedAt: '2026-11-17T08:40:00.000Z' };
  const ordinary = {
    '20261117-084000-11111111': { item: 'add-sk-translation-for-the-settings-page', title: 'Add sk translation for the settings page', brief: 'Add sk translation for the settings page' },
    '20261117-084000-22222222': { item: 'fix-the-sk-learn-import-in-notebooks', project: 'sk-learn-notebooks-and-more', folder: 'code/sk-learn-notebooks-web' },
    '20261117-084000-33333333': { commits: [{ repo: 'code/xoxb-tools-for-the-bot', short: 'abc1234', subject: 'Add the bot' }], changed: [{ repo: 'code/xoxb-tools-for-the-bot', path: 'src/bot.js', kind: 'changed' }] },
  };
  // ... while a key without a dash in a project's name still makes it no run of Work's.
  const key = { '20261117-084000-44444444': { project: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' }, '20261117-084000-55555555': { folder: 'code/AKIA' + 'ABCDEFGHIJKLMNOP' } };
  try {
    for (const [id, extra] of Object.entries({ ...ordinary, ...key })) run(id, { ...done, ...extra });
    const plan = await savePlan(place());
    assert.deepEqual(plan.files.map((f) => f.path), Object.keys(ordinary).map((id) => `docs/plans/runs/${id}.json`));
    assert.deepEqual(plan.notRuns, Object.keys(key).map((id) => `docs/plans/runs/${id}.json`));
  } finally {
    for (const id of [...Object.keys(ordinary), ...Object.keys(key)]) fs.rmSync(path.join(runs, `${id}.json`), { force: true });
  }
});

test('only a run file changed, and the server moved the list meanwhile: its commits come in, then the run file is committed and sent', async () => {
  const other = t.otherClone(bare);
  write(other, { 'docs/plans/tasks.json': '{\n  "items": [],\n  "note": "from another computer"\n}\n' });
  t.git(other, 'commit', '-q', '-am', 'The list, elsewhere');
  t.git(other, 'push', '-q');
  run('20261117-100000-aaaaaaaa', { state: 'done', endedAt: '2026-11-17T10:30:00.000Z', answer: 'All done.' });
  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^Kept 1 run and uploaded it to your git server\. Brought in 1 new commit from the server first\./);
  assert.deepEqual(lines('show', '--name-only', '--format=%s', 'HEAD'), [SUBJECT, 'docs/plans/runs/20261117-100000-aaaaaaaa.json']);
  assert.match(fs.readFileSync(path.join(shop, 'docs/plans/tasks.json'), 'utf8'), /from another computer/);
  assert.equal(t.git(shop, 'rev-parse', 'HEAD'), t.git(bare, 'rev-parse', 'main'));
});

test('a send that fails takes the commit back: the run file is as before the save, not staged, and the next save sends it', async () => {
  run('20261117-120000-cccccccc');
  const url = t.git(shop, 'remote', 'get-url', 'origin');
  t.git(shop, 'remote', 'set-url', '--push', 'origin', path.join(t.root, 'nowhere.git'));
  // A push URL of its own is a "three-cornered" set-up (@{push} is still @{upstream} here, the URL only differs): the
  // send goes to the URL that does not exist, and fails.
  const headBefore = t.git(shop, 'rev-parse', 'HEAD');
  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.ok, false, r.message);
  assert.match(r.message, /^Not saved to git: the server did not answer\./);
  assert.equal(t.git(shop, 'rev-parse', 'HEAD'), headBefore, 'taken back');
  assert.deepEqual(lines('status', '--porcelain', '--untracked-files=all'), ['?? docs/plans/runs/20261117-120000-cccccccc.json']);
  t.git(shop, 'remote', 'set-url', '--push', 'origin', url);
  const again = await saveWork(place(), { subject: SUBJECT });
  assert.equal(again.ok, true, again.message);
  assert.equal(t.git(shop, 'rev-parse', 'HEAD'), t.git(bare, 'rev-parse', 'main'));
});

// A save with run files killed after a step (save.mjs HOPRIG_TEST_WORK_STOP_AFTER, as interrupt.test.mjs does): the
// next look finishes it, and the next Save has the list and the run file, here and on the server, with nothing left
// staged or over.
const SAVE = new URL('../../src/work/save.mjs', import.meta.url).href;
let n = 0;
for (const step of ['journal', 'commit', 'takeback']) {
  test(`a save of the list and a run file killed after "${step}": the next Save sends both, nothing left over`, async () => {
    const here = path.join(t.root, `k${++n}`);
    const bareK = t.repo(here, { 'README.md': '# brain\n', 'work/tasks.json': '{\n  "items": []\n}\n' });
    const p = { file: path.join(here, 'work', 'tasks.json'), folder: path.join(here, 'work'), base: here, label: 'brain/work', fileName: 'tasks.json', kind: 'project', settings: { timeZone: '', ownerId: 'me', saveSubject: SUBJECT } };
    await workStore(p).add({ title: 'Renew the domain' });
    writeRun(p, { v: 1, id: '20261117-100000-aaaaaaaa', item: 'renew-the-domain', title: 'Renew the domain', writer: writerId(), by: 'owner', startedAt: '2026-11-17T10:00:00.000Z', endedAt: null, project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null, session: null, conversation: null, message: null, brief: 'x', state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null });
    const pre = path.join(bareK, 'hooks', 'pre-receive');
    if (step === 'takeback') fs.writeFileSync(pre, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const code = `import { saveWork } from ${JSON.stringify(SAVE)};
      const r = await saveWork(${JSON.stringify(p)}, { subject: ${JSON.stringify(SUBJECT)} });
      process.stdout.write(JSON.stringify(r.message));`;
    const k = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, [STOP_ENV]: step }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(endSignal(k), 'SIGKILL', `${k.stdout} ${k.stderr}`);
    fs.rmSync(pre, { force: true });
    const plan = await savePlan(p);
    assert.match(plan.recovered || '', /^A save of the Work list was interrupted/, plan.problem);
    assert.equal(t.git(here, 'diff', '--cached', '--name-only'), '', 'nothing left staged by the save');
    const r = await saveWork(p, { subject: SUBJECT });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(t.git(bareK, 'show', '--name-only', '--format=', 'main').split('\n').filter(Boolean), ['work/runs/20261117-100000-aaaaaaaa.json', 'work/tasks.json']);
    assert.equal(t.git(here, 'status', '--porcelain'), '', 'nothing left over');
  });
}
