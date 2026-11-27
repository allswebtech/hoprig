// hoprig tasks: each command with --json; --dry-run checks everything and writes nothing; a refusal is exit 2 with
// the reason; save from the terminal commits by name. Also once through bin/hoprig.mjs as a person types it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-cli');
test.after(() => t.cleanup());
const { main } = await import('../../src/work/cli.mjs');
fs.mkdirSync(path.join(t.projects, 'shop'), { recursive: true });
t.repo(t.brain, { 'README.md': '# brain\n' });
const file = path.join(t.brain, 'work', 'tasks.json');

async function work(...args) {
  let out = '';
  let err = '';
  const code = await main(args, { out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`) });
  return { code, out, err, json: args.includes('--json') && out ? JSON.parse(out) : null };
}

test('add, list, edit, done, open, drop, remove and today, each with --json', async () => {
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const soon = ymd(new Date(today.getTime() + 2 * 86_400_000));
  let r = await work('add', 'Renew the domain', '--date', soon, '--project', 'shop', '--priority', 'high', '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.item.id, 'renew-the-domain');
  assert.equal(r.json.item.project, 'shop');
  assert.equal(r.json.item.days, 2);
  assert.equal(r.json.written, true);
  r = await work('add', 'Write the release notes', '--by', 'ai', '--note=Short, plain words', '--json');
  assert.equal(r.json.item.by, 'ai');
  assert.equal(r.json.item.note, 'Short, plain words');

  r = await work('list', '--json');
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.items.map((i) => i.id), ['renew-the-domain', 'write-the-release-notes']);
  assert.equal(r.json.place.label, 'ai_brain/work');
  assert.deepEqual((await work('list', '--by', 'ai', '--json')).json.items.map((i) => i.id), ['write-the-release-notes']);
  assert.deepEqual((await work('list', '--project', 'shop', '--json')).json.items.map((i) => i.id), ['renew-the-domain']);
  const plain = await work('list');
  assert.match(plain.out, /^! \d{4}-\d{2}-\d{2}\s+in 2d\s+open\s+me\s+shop\s+renew-the-domain\s+Renew the domain$/m);

  r = await work('edit', 'write-the-release-notes', '--note', 'none', '--status', 'waiting', '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.item.note, '');
  assert.equal(r.json.item.status, 'waiting');
  r = await work('done', 'renew-the-domain', '--json');
  assert.equal(r.json.before, 'open');
  assert.equal(r.json.item.status, 'done');
  assert.equal(r.json.item.doneAt, ymd(today));
  r = await work('today', '--json');
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.needsYou.map((i) => [i.id, i.why]), [['write-the-release-notes', 'waiting for you']]);
  assert.deepEqual(r.json.doneLately.map((i) => i.id), ['renew-the-domain']);
  assert.equal(r.json.week.length, 7);
  assert.equal((await work('list', '--json')).json.items.length, 1, 'done items only with --all');
  assert.equal((await work('list', '--all', '--json')).json.items.length, 2);
  r = await work('open', 'renew-the-domain', '--json');
  assert.equal(r.json.item.doneAt, null);
  r = await work('drop', 'renew-the-domain', '--json');
  assert.equal(r.json.item.status, 'dropped');
  r = await work('remove', 'renew-the-domain', '--json');
  assert.equal(r.code, 0);
  assert.equal(r.json.item.id, 'renew-the-domain');
  assert.equal((await work('list', '--all', '--json')).json.items.length, 1);
  const t2 = await work();
  assert.match(t2.out, /^Work: ai_brain\/work · today /);
  assert.match(t2.out, /Write the release notes {2}\(waiting for you\)/);
});

test('--dry-run checks everything and writes nothing; refusals are exit 2 with the reason', async () => {
  const before = fs.readFileSync(file, 'utf8');
  let r = await work('add', 'Something new to do', '--dry-run', '--json');
  assert.equal(r.code, 0);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.written, false);
  assert.equal(r.json.item.id, 'something-new-to-do');
  for (const args of [['done', 'write-the-release-notes'], ['edit', 'write-the-release-notes', '--title', 'A new title'], ['remove', 'write-the-release-notes'], ['drop', 'write-the-release-notes']]) {
    r = await work(...args, '--dry-run');
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.match(r.out, /dry run: nothing written/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file did not change');
  const refusals = [
    [['add', 'ok'], /3 to 200/],
    [['add', 'Fine title', '--date', 'tomorrow'], /not a date/],
    [['add', 'Fine title', '--project', 'elsewhere'], /not a project of the workspace/],
    [['add', 'Fine title', '--colour', 'red'], /unknown option --colour/],
    [['add', 'Fine', 'title'], /too many words/],
    [['edit', 'nobody', '--title', 'A new title'], /there is no item "nobody"/],
    [['done'], /needs the id/],
    [['open', 'write-the-release-notes', '--title', 'x'], /takes only the id/],
    [['list', '--dry-run'], /--dry-run is for the commands that change/],
    [['fly'], /unknown command "fly"/],
  ];
  for (const [args, re] of refusals) {
    r = await work(...args);
    assert.ok(r.code === 2 || r.code === 1, `${args.join(' ')} → ${r.code}`);
    assert.match(r.err, re, args.join(' '));
  }
  assert.equal((await work('edit', 'nobody', '--title', 'A new title')).code, 1, 'not found: 1');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a refusal with --json is one JSON object with ok false, a code and the message, and the same exit code', async () => {
  const before = fs.readFileSync(file, 'utf8');
  for (const [args, exit, code] of [
    [['add', 'Done at once', '--status', 'done'], 2, 'usage'],
    [['add', 'A positional title', '--title', 'Another title'], 2, 'usage'],
    [['list', '--dry-run'], 2, 'usage'],
    [['frobnicate'], 2, 'usage'],
    [['edit', 'nobody', '--title', 'A new title'], 1, 'refused'],
    [['done', 'write-the-release-notes', '--note', 'x'], 2, 'usage'],
  ]) {
    const r = await work(...args, '--json');
    assert.equal(r.code, exit, args.join(' '));
    assert.equal(r.err, '', `${args.join(' ')}: nothing on standard error`);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.ok, j.code], [false, code], args.join(' '));
    assert.equal(typeof j.message, 'string');
    // The same refusal without --json: one line that starts with the command's name.
    const plain = await work(...args);
    assert.equal(plain.code, exit);
    assert.match(plain.err, /^tasks: /);
  }
  assert.match((await work('add', 'Done at once', '--status', 'done')).err, /^tasks: add takes no --status: a new task is open/);
  assert.match((await work('add', 'A title', '--title', 'Another')).err, /^tasks: add takes its title as the word after add/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written by any of them');
});

test('save from the terminal: --dry-run names the file and the changes; then it commits by name', async () => {
  let r = await work('save', '--dry-run', '--json');
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.plan.files, [{ path: 'work/tasks.json', state: 'new' }]);
  assert.equal(t.git(t.brain, 'log', '-1', '--format=%s'), 'Start');
  r = await work('save');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Kept a copy of your list \(1 change\) and uploaded it to your git server\.\n {2}work\/tasks\.json \(new\)\n {2}added: Write the release notes/);
  assert.equal(t.git(t.brain, 'log', '-1', '--format=%s'), 'Update work items');
});

test('save from the terminal with another computer\'s change of the same task: shown, then decided with --decide on what he saw', async () => {
  const other = t.otherClone(path.join(t.server, 'ai_brain.git'));
  const f = path.join(other, 'work', 'tasks.json');
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc.items[0].title = 'Release notes, written elsewhere';
  fs.writeFileSync(f, `${JSON.stringify(doc, null, 2)}\n`);
  t.git(other, 'commit', '-q', '-am', 'Update work items');
  t.git(other, 'push', '-q');
  await work('edit', 'write-the-release-notes', '--title', 'Release notes, written here');
  let r = await work('save');
  assert.equal(r.code, 1);
  const m = /To decide: hoprig tasks save --seen ([0-9a-f]{16}\.[0-9a-f]{16}) --decide "<task>=mine,<task>=theirs"\n {2}write-the-release-notes\n {4}mine: {3}"Release notes, written here" waiting\n {4}theirs: "Release notes, written elsewhere" waiting/.exec(r.out);
  assert.ok(m, r.out);
  const seen = m[1];
  assert.equal((await work('save', '--seen', seen, '--decide', 'write-the-release-notes=maybe')).code, 2);
  // A choice without what it was made on is refused: it could override a change he never saw.
  r = await work('save', '--decide', 'write-the-release-notes=mine');
  assert.equal(r.code, 2);
  assert.match(r.err, /--decide needs --seen <token>/);
  // The other computer changes the task again after he looked: his choice is not taken, the new conflict is shown.
  const doc2 = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc2.items[0].title = 'Release notes, written elsewhere again';
  fs.writeFileSync(f, `${JSON.stringify(doc2, null, 2)}\n`);
  t.git(other, 'commit', '-q', '-am', 'Update work items');
  t.git(other, 'push', '-q');
  const head = t.git(t.brain, 'rev-parse', 'HEAD');
  r = await work('save', '--seen', seen, '--decide', 'write-the-release-notes=mine', '--json');
  assert.equal(r.code, 1);
  assert.equal(r.json.code, 'moved');
  assert.equal(r.json.plan.remote.conflicts[0].theirs.title, 'Release notes, written elsewhere again');
  assert.notEqual(r.json.seen, seen);
  assert.equal(t.git(t.brain, 'rev-parse', 'HEAD'), head, 'nothing committed');
  r = await work('save', '--seen', r.json.seen, '--decide', 'write-the-release-notes=mine');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^Merged 1 change of yours with 1 change from another computer, 1 task decided by you and uploaded it to your git server\./);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].title, 'Release notes, written here');
  t.git(t.brain, 'pull', '-q', '--ff-only');
});

test('through the hoprig command, as a person types it', async () => {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hoprig.mjs');
  const out = execFileSync(process.execPath, [bin, 'tasks', 'list', '--json'], { encoding: 'utf8', env: process.env });
  assert.deepEqual(JSON.parse(out).items.map((i) => i.id), ['write-the-release-notes']);
  assert.equal(JSON.parse(out).items[0].title, 'Release notes, written here');
  const help = execFileSync(process.execPath, [bin, 'help'], { encoding: 'utf8', env: process.env });
  assert.match(help, /hoprig tasks {16}your tasks and what needs you today/);
  // "work" stays free for a provider of that name (hoprig work -c starts it, as before).
  const { validName } = await import('../../src/profiles.mjs');
  assert.equal(validName('work'), true);
  assert.equal(validName('tasks'), false);
});

test('list and today name the program that added a task, in the text too', async () => {
  const { loadConfig } = await import('../../src/config.mjs');
  const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
  const { workStore } = await import('../../src/work/store.mjs');
  const store = workStore(resolvePlace(loadConfig()), { projects: projectNames() });
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const it = (await store.addFrom({ title: 'Third task', date: ymd }, { token: 'a1b2c3d4e5f6', name: 'Docs script' })).item;
  const list = await work('list');
  assert.match(list.out.split('\n').find((l) => l.includes(it.id)), /Third task {2}\(from Docs script\)$/);
  assert.doesNotMatch(list.out.split('\n').find((l) => l.includes('write-the-release-notes')), /from /, 'the owner\'s own task says nothing');
  const day = await work('today');
  assert.ok(day.out.split('\n').filter((l) => l.includes('Third task')).every((l) => l.includes('(from Docs script)')), day.out);
  await work('remove', it.id);
});
