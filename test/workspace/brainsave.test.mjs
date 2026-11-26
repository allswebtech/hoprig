// The AI brain's files that are not saved to its git server yet: listed (the first few, how many more, the
// repository's name), and saved and uploaded only on the owner's yes from his own page, as a job. A brain that is
// behind or that moved on both sides is said plainly and nothing is forced. Tia's token, a script's token, a call
// with no sign-in (a session's own call) and another site are refused; nothing of it runs by itself. The only git
// server is a bare repository of this test's own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-brainsave');
const url = w.bare('ai_brain');
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const brain = w.clone(url, path.join(A.ws, 'ai_brain'));
const other = w.clone(url, path.join(w.root, 'other-brain')); // another computer's brain
const bareDir = path.join(w.server, 'team', 'ai_brain.git');
const serverLog = () => w.sh(bareDir, 'log', '--oneline', 'main').split('\n').filter(Boolean);

const { brainChanges, saveBrain, repoWords, changedPaths, uploadWords } = await import('../../src/workspace/brainsave.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { capture } = await import('../../src/setup/system.mjs');
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(brain, rel)), { recursive: true });
  fs.writeFileSync(path.join(brain, rel), text);
};

test('the words of a repository and of git status', () => {
  assert.equal(repoWords('https://git.example.test/team/ai_brain.git'), 'team/ai_brain on git.example.test');
  assert.equal(repoWords('https://alex:secret@git.example.test/team/ai_brain.git'), 'team/ai_brain on git.example.test', 'no sign-in part');
  assert.equal(repoWords('git@git.example.test:team/ai_brain.git'), 'team/ai_brain on git.example.test');
  assert.deepEqual(changedPaths(' M a.md\0?? skills/x/SKILL.md\0R  new.md\0old.md\0'), ['a.md', 'skills/x/SKILL.md', 'new.md']);
});

test('why an upload did not happen, without git\'s own terms', () => {
  const repo = 'team/ai_brain on git.example.test';
  for (const why of ['push failed: remote: Permission denied', 'fetch failed: could not resolve host', 'main has no upstream', 'main and its upstream have both moved (1 ahead, 2 behind)']) {
    const said = uploadWords(why, repo);
    assert.doesNotMatch(said, /upstream|push|fetch|commit/i, said);
  }
  assert.equal(uploadWords('push failed: remote: Permission denied', repo), 'team/ai_brain on git.example.test refused the upload (remote: Permission denied)');
});

test('the list: how many, the first few and how many more, where they go', async () => {
  for (let i = 1; i <= 7; i++) write(`skills/s${i}/SKILL.md`, `# s${i}\n`);
  write('README.md', '# changed\n');
  const c = await brainChanges({ dir: A.ws });
  assert.equal(c.count, 8);
  assert.equal(c.files.length, 5);
  assert.equal(c.more, 3);
  assert.equal(c.repo, 'team/ai_brain on git.example.test');
  assert.deepEqual([c.ahead, c.behind, c.upstream], [0, 0, 'origin/main']);
});

test('saved and uploaded on the press: one commit with every change, on the git server', async () => {
  const lines = [];
  const before = serverLog().length;
  const r = await saveBrain({ dir: A.ws, onLine: (l) => lines.push(l) });
  assert.deepEqual(r, { ok: true, saved: 8, uploaded: true });
  assert.equal(serverLog().length, before + 1);
  assert.match(serverLog()[0], /Save the AI brain/);
  assert.equal(w.sh(brain, 'status', '--porcelain'), '');
  assert.equal((await brainChanges({ dir: A.ws })).count, 0);
  assert.ok(lines.some((l) => /Uploaded to team\/ai_brain on git\.example\.test/.test(l)), lines.join('\n'));
});

test('newer changes on the git server are got first, then his are saved on top', async () => {
  w.sh(other, 'pull', '-q');
  w.commit(other, 'learnings.md', '# from the other computer\n');
  w.sh(other, 'push', '-q');
  write('notes.md', '# here\n');
  const r = await saveBrain({ dir: A.ws });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(brain, 'learnings.md')), 'the other computer\'s file came here');
  assert.match(serverLog()[0], /Save the AI brain/);
});

test('moved on both sides: said plainly, nothing committed, nothing forced', async () => {
  w.sh(other, 'pull', '-q');
  w.commit(other, 'a.md', 'there\n');
  w.sh(other, 'push', '-q');
  w.commit(brain, 'b.md', 'here\n'); // a commit here the server does not have
  write('c.md', 'loose\n');
  const head = w.sh(brain, 'rev-parse', 'HEAD');
  const server = serverLog();
  await assert.rejects(saveBrain({ dir: A.ws }), (e) => e.status === 409 && /changed here and on team\/ai_brain/.test(e.message) && /Nothing was saved or uploaded/.test(e.message) && !/upstream|rebase|force/i.test(e.message));
  assert.equal(w.sh(brain, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.deepEqual(serverLog(), server, 'nothing uploaded');
  assert.match(w.sh(brain, 'status', '--porcelain'), /\?\? c\.md/);
});

test('a file that looks like a key or a password, also beyond the names shown first: named, nothing saved or uploaded', async () => {
  const ws = path.join(w.root, 'secret-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(b, `n${i}.md`), 'x\n');
  fs.mkdirSync(path.join(b, 'zz'), { recursive: true });
  fs.writeFileSync(path.join(b, 'zz', '.env'), 'PORT=3000\n'); // by its name
  fs.writeFileSync(path.join(b, 'zz', 'note.md'), `key: sk-ant-${'a1'.repeat(12)}\n`); // by what it holds (made up)
  fs.writeFileSync(path.join(b, 'zz', 'tokens-explained.md'), 'How tokens are counted.\n'); // only a word in its name
  const c = await brainChanges({ dir: ws });
  assert.equal(c.files.length, 5);
  assert.deepEqual(c.secret.sort(), ['zz/.env', 'zz/note.md']);
  assert.equal(c.all.length, c.count, 'every path for the full list');
  const server = w.sh(bareDir, 'log', '--oneline', 'main');
  await assert.rejects(saveBrain({ dir: ws }), (e) => e.status === 409 && /zz\/\.env/.test(e.message) && /Nothing was saved or uploaded/.test(e.message) && !/sk-ant/.test(e.message));
  assert.equal(w.sh(bareDir, 'log', '--oneline', 'main'), server, 'nothing uploaded');
  assert.match(w.sh(b, 'status', '--porcelain'), /\?\? n1\.md/, 'nothing committed');
});

test('an .env pattern (.env.example, .sample, .template, .dist) is judged by what it holds, an .env by its name', async () => {
  const { secretPaths } = await import('../../src/workspace/brainsave.mjs');
  const dir = fs.mkdtempSync(path.join(w.root, 'envs-'));
  for (const n of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env', '.env.local', '.env.production', '.env.example.local']) fs.writeFileSync(path.join(dir, n), 'PORT=\n');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', '.env.example'), `API_KEY=sk-ant-${'e5'.repeat(12)}\n`); // a real-looking value in it (made up)
  const found = await secretPaths(dir, ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env', '.env.local', '.env.production', '.env.example.local', 'app/.env.example']);
  assert.deepEqual(found, ['.env', '.env.local', '.env.production', '.env.example.local', 'app/.env.example']);
});

test('a key file removed from the brain (the advice followed) is saved: its removal is uploaded', async () => {
  const ws = path.join(w.root, 'removed-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  w.commit(b, '.env', 'PORT=1\n', 'add env');
  w.sh(b, 'push', '-q');
  fs.rmSync(path.join(b, '.env'));
  const c = await brainChanges({ dir: ws });
  // A removal is said apart: the file does not go to the server, it is taken off it.
  assert.deepEqual([c.count, c.all, c.files, c.removed, c.secret], [1, [], [], ['.env'], []]);
  const r = await saveBrain({ dir: ws });
  assert.deepEqual(r, { ok: true, saved: 1, uploaded: true });
  assert.ok(!w.sh(bareDir, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes('.env'), 'gone on the server too');
  // Taken out of git but left on disk: the file itself is judged again (it would be uploaded as new otherwise).
  w.commit(b, '.env', 'PORT=2\n', 'add env again');
  w.sh(b, 'push', '-q');
  w.sh(b, 'rm', '-q', '--cached', '.env');
  assert.deepEqual((await brainChanges({ dir: ws })).secret, ['.env']);
});

test('a file git keeps already that now holds a key: the advice is not .gitignore, which does nothing for it', async () => {
  const ws = path.join(w.root, 'tracked-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  w.commit(b, 'learnings.md', 'x\n', 'add');
  w.sh(b, 'push', '-q');
  fs.writeFileSync(path.join(b, 'learnings.md'), `Keys look like sk-ant-${'a1'.repeat(12)} (made up)\n`);
  fs.writeFileSync(path.join(b, 'new.pem'), 'x\n'); // a new one: .gitignore is the way for it
  const c = await brainChanges({ dir: ws });
  assert.deepEqual([c.secret.sort(), c.secretTracked], [['learnings.md', 'new.pem'], ['learnings.md']]);
  assert.match(c.secretAdvice, /For new\.pem: ask your coding tool in a session to move it out of the AI brain \(naming it in the AI brain's \.gitignore works too\)\./);
  assert.match(c.secretAdvice, /For learnings\.md: take the key or password out of it, or ask your coding tool in a session to move it out of the AI brain/);
  // The first way of each kind is a sentence to the coding tool or an edit of the note, never a git word.
  assert.doesNotMatch(c.secretAdvice.replace(/\([^)]*\)/g, ''), /gitignore|git keeps|out of git/, c.secretAdvice);
  await assert.rejects(saveBrain({ dir: ws }), (e) => e.status === 409 && e.message.includes(c.secretAdvice) && !/sk-ant/.test(e.message));
  fs.rmSync(path.join(b, 'new.pem'));
  const only = await brainChanges({ dir: ws });
  assert.doesNotMatch(only.secretAdvice, /gitignore\./, only.secretAdvice);
  assert.match(only.secretAdvice, /^Take the key or password out of it/);
});

test('a file with a key taken out of git (the advice followed) is saved as a removal: the server does not get it back', async () => {
  const ws = path.join(w.root, 'untracked-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  w.commit(b, 'keep-notes.md', 'notes\n', 'add notes');
  w.commit(b, 'keep-conf.txt', 'port 1\n', 'add conf');
  w.sh(b, 'push', '-q');
  fs.writeFileSync(path.join(b, 'keep-notes.md'), `Keys look like sk-ant-${'f6'.repeat(12)} (made up)\n`);
  w.sh(b, 'rm', '-q', '--cached', 'keep-notes.md', 'keep-conf.txt');
  fs.writeFileSync(path.join(b, '.gitignore'), 'keep-notes.md\nkeep-conf.txt\n');
  const c = await brainChanges({ dir: ws });
  assert.deepEqual(c.secret, []);
  const r = await saveBrain({ dir: ws });
  assert.equal(r.ok, true);
  const tree = w.sh(bareDir, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(!tree.includes('keep-notes.md'), `the key's file is not on the server: ${tree.join(' ')}`);
  assert.ok(!tree.includes('keep-conf.txt'), `a file taken out of git stays out: ${tree.join(' ')}`);
  assert.ok(tree.includes('.gitignore'));
  assert.equal(w.sh(b, 'ls-files', 'keep-notes.md', 'keep-conf.txt'), '', 'not tracked here again');
});

test('a private folder of the brain (no-ai) is never listed, read, saved or uploaded; the note beside it is', async () => {
  const ws = path.join(w.root, 'private-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  fs.mkdirSync(path.join(b, 'no-ai', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(b, 'no-ai', 'mine.md'), `key: sk-ant-${'c3'.repeat(12)}\n`); // made up
  fs.writeFileSync(path.join(b, 'no-ai', 'deep', 'plan.md'), 'mine\n');
  fs.writeFileSync(path.join(b, 'note.md'), '# note\n');
  w.sh(b, 'add', 'no-ai/deep/plan.md'); // staged by hand before: still not his press's to upload
  const c = await brainChanges({ dir: ws });
  assert.deepEqual([c.count, c.all, c.secret], [1, ['note.md'], []]);
  const r = await saveBrain({ dir: ws });
  assert.deepEqual(r, { ok: true, saved: 1, uploaded: true });
  const tree = w.sh(bareDir, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(tree.includes('note.md'), tree.join(' '));
  assert.ok(!tree.some((f) => f.startsWith('no-ai/')), tree.join(' '));
  // Only the private folder changed: nothing is offered, and nothing is said to be saved.
  fs.writeFileSync(path.join(b, 'no-ai', 'mine.md'), 'changed\n');
  assert.equal((await brainChanges({ dir: ws })).count, 0);
});

test('the key check reads the changed files one at a time and lets the dashboard answer between them', async () => {
  const { secretPaths } = await import('../../src/workspace/brainsave.mjs');
  const dir = fs.mkdtempSync(path.join(w.root, 'scan-'));
  const names = Array.from({ length: 20 }, (_, i) => `n${i}.md`);
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'word '.repeat(2000));
  fs.writeFileSync(path.join(dir, 'n7.md'), `key: sk-ant-${'d4'.repeat(12)}\n`); // made up
  // Turns of the event loop while it runs: a scan that reads every file in one go leaves none between them.
  let turns = 0;
  let on = true;
  const spin = () => {
    if (!on) return;
    turns++;
    setImmediate(spin);
  };
  setImmediate(spin);
  const found = await secretPaths(dir, [...names, 'gone.md']);
  on = false;
  assert.deepEqual(found, ['n7.md']);
  assert.ok(turns >= names.length, `${turns} turns for ${names.length} files`);
});

test('a large changed file is checked for a key whole, and one too large to check is refused by name', async () => {
  const { CHECK_MAX, secretPaths } = await import('../../src/workspace/brainsave.mjs');
  const ws = path.join(w.root, 'large-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  const key = `sk-ant-api03-${'Ab3'.repeat(10)}`; // made up
  fs.writeFileSync(path.join(b, 'session-log.md'), `${'x'.repeat((1 << 20) + 10)}\n${key}\n`);
  const server = w.sh(bareDir, 'log', '--oneline', 'main');
  const c = await brainChanges({ dir: ws });
  assert.deepEqual(c.secret, ['session-log.md']);
  await assert.rejects(saveBrain({ dir: ws }), (e) => e.status === 409 && /session-log\.md/.test(e.message) && !e.message.includes(key));
  assert.equal(w.sh(bareDir, 'log', '--oneline', 'main'), server, 'nothing uploaded');
  // A key cut by the edge of a piece read is still seen whole.
  const dir = fs.mkdtempSync(path.join(w.root, 'edge-'));
  fs.writeFileSync(path.join(dir, 'edge.md'), `${'y'.repeat((1 << 20) - 11)}\n${key}\n`); // the key starts 10 bytes before the edge
  assert.deepEqual(await secretPaths(dir, ['edge.md']), ['edge.md']);
  // Over the limit (a sparse file: no room taken): never read, refused with what to do.
  fs.rmSync(path.join(b, 'session-log.md'));
  const fd = fs.openSync(path.join(b, 'huge.log'), 'w');
  fs.ftruncateSync(fd, CHECK_MAX + 1);
  fs.closeSync(fd);
  const h = await brainChanges({ dir: ws });
  assert.deepEqual([h.secret, h.secretLarge], [['huge.log'], ['huge.log']]);
  assert.match(h.secretAdvice, /^Ask your coding tool in a session to move it out of the AI brain: a file over 50 MB is too large to check for a key\.$/);
  await assert.rejects(saveBrain({ dir: ws }), (e) => e.status === 409 && /huge\.log is too large to check for a key/.test(e.message));
  assert.equal(w.sh(bareDir, 'log', '--oneline', 'main'), server, 'nothing uploaded');
});

test('a file that came after the sheet was opened is not saved unnamed: the press refuses and nothing is uploaded', async () => {
  const ws = path.join(w.root, 'seen-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  fs.writeFileSync(path.join(b, 'shown.md'), '# shown\n');
  const sheet = await brainChanges({ dir: ws });
  assert.match(sheet.seen, /^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(b, 'later-memory.md'), '# written by a session meanwhile\n');
  const server = w.sh(bareDir, 'log', '--oneline', 'main');
  await assert.rejects(saveBrain({ dir: ws, seen: sheet.seen }), (e) => e.status === 409 && /the files changed since you opened this/.test(e.message));
  assert.equal(w.sh(bareDir, 'log', '--oneline', 'main'), server, 'nothing uploaded');
  assert.match(w.sh(b, 'status', '--porcelain'), /\?\? later-memory\.md/, 'nothing committed');
  // Opened again: the list names both, and that press saves them.
  const again = await brainChanges({ dir: ws });
  assert.deepEqual(again.all.sort(), ['later-memory.md', 'shown.md']);
  const r = await saveBrain({ dir: ws, seen: again.seen });
  assert.deepEqual([r.ok, r.saved], [true, 2]);
});

// A session writes into the brain while the press runs: `when` picks the git call (its arguments) at which `act` runs,
// once; `after`: right after that call instead of before it.
const writing = (when, act, after = false) => {
  let done = false;
  return async (argv, opts) => {
    const hit = !done && when(argv);
    if (hit) done = true;
    if (hit && !after) act();
    const r = await capture(argv, opts);
    if (hit && after) act();
    return r;
  };
};
const isFetch = (argv) => argv.includes('fetch');
const isAdd = (argv) => argv.includes('add') && argv.includes('-A');

test('a file that looks like a key, written while the press gets the server\'s changes: refused, nothing committed or uploaded', async () => {
  const ws = path.join(w.root, 'race-key-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  fs.writeFileSync(path.join(b, 'notes.md'), 'a plain note\n');
  const sheet = await brainChanges({ dir: ws });
  assert.deepEqual([sheet.all, sheet.secret], [['notes.md'], []]);
  const key = `sk-ant-api03-${'Qx7'.repeat(10)}`; // made up
  const head = w.sh(b, 'rev-parse', 'HEAD');
  const server = w.sh(bareDir, 'log', '--oneline', 'main');
  const run = writing(isFetch, () => fs.writeFileSync(path.join(b, 'memory-new.md'), `a session wrote this: ${key}\n`));
  await assert.rejects(saveBrain({ dir: ws, run, seen: sheet.seen }), (e) => e.status === 409 && /memory-new\.md/.test(e.message) && /Nothing was saved or uploaded/.test(e.message) && !e.message.includes(key));
  assert.equal(w.sh(b, 'rev-parse', 'HEAD'), head, 'nothing committed');
  assert.equal(w.sh(bareDir, 'log', '--oneline', 'main'), server, 'nothing uploaded');
  assert.ok(!w.sh(bareDir, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes('memory-new.md'));
  assert.equal(w.sh(b, 'diff', '--cached', '--name-only'), '', 'the staging is as it was');
  // Without the sheet's list (an older page): the same.
  fs.rmSync(path.join(b, 'memory-new.md'));
  const run2 = writing(isFetch, () => fs.writeFileSync(path.join(b, 'memory-new.md'), `again: ${key}\n`));
  await assert.rejects(saveBrain({ dir: ws, run: run2 }), (e) => e.status === 409 && /memory-new\.md/.test(e.message));
  assert.equal(w.sh(b, 'rev-parse', 'HEAD'), head, 'nothing committed');
});

test('a plain file written while the press gets the server\'s changes is not saved unnamed: refused, staging as it was', async () => {
  const ws = path.join(w.root, 'race-new-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  fs.writeFileSync(path.join(b, 'shown-first.md'), '# shown\n');
  fs.writeFileSync(path.join(b, 'by-hand.md'), '# staged by hand\n');
  w.sh(b, 'add', 'by-hand.md');
  const sheet = await brainChanges({ dir: ws });
  const head = w.sh(b, 'rev-parse', 'HEAD');
  const run = writing(isFetch, () => fs.writeFileSync(path.join(b, 'later.md'), '# a memory written meanwhile\n'));
  await assert.rejects(saveBrain({ dir: ws, run, seen: sheet.seen }), (e) => e.status === 409 && /the files changed since you opened this/.test(e.message));
  assert.equal(w.sh(b, 'rev-parse', 'HEAD'), head, 'nothing committed');
  assert.equal(w.sh(b, 'diff', '--cached', '--name-only'), 'by-hand.md', 'what he staged by hand stays staged, nothing else');
  // Opened again, the list names it, and that press saves all three.
  const again = await brainChanges({ dir: ws });
  assert.deepEqual(again.all.sort(), ['by-hand.md', 'later.md', 'shown-first.md']);
  assert.deepEqual((await saveBrain({ dir: ws, seen: again.seen })).ok, true);
});

test('a shown file changed again right after it was staged: the staged copy is not committed unchecked', async () => {
  const ws = path.join(w.root, 'race-staged-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  const note = path.join(b, 'notes.md');
  fs.writeFileSync(note, 'a plain note\n');
  const sheet = await brainChanges({ dir: ws });
  const key = `sk-ant-api03-${'Zt4'.repeat(10)}`; // made up
  const head = w.sh(b, 'rev-parse', 'HEAD');
  // The key is on disk when git stages the file, and gone again before the check reads the disk.
  let n = 0;
  const run = writing(isAdd, () => fs.writeFileSync(note, `a plain note, edited ${++n}\n`), true);
  const swap = async (argv, opts) => {
    if (isAdd(argv) && !n) fs.writeFileSync(note, `a key: ${key}\n`);
    return run(argv, opts);
  };
  await assert.rejects(saveBrain({ dir: ws, run: swap, seen: sheet.seen }), (e) => e.status === 409 && /Nothing was saved or uploaded/.test(e.message));
  assert.equal(w.sh(b, 'rev-parse', 'HEAD'), head, 'nothing committed');
  assert.ok(!w.sh(bareDir, 'log', '-p', 'main').includes(key), 'the key is not on the server');
  assert.equal(w.sh(b, 'diff', '--cached', '--name-only'), '', 'the staging is as it was');
});

test('a renamed file is saved: its new path goes up and its old one is taken off, as the sheet says', async () => {
  const ws = path.join(w.root, 'rename-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  w.commit(b, 'old-name.md', '# kept\n', 'add');
  w.sh(b, 'push', '-q');
  w.sh(b, 'mv', 'old-name.md', 'new-name.md');
  const sheet = await brainChanges({ dir: ws });
  assert.deepEqual([sheet.all, sheet.removed], [['new-name.md'], ['old-name.md']]);
  const r = await saveBrain({ dir: ws, seen: sheet.seen });
  assert.equal(r.ok, true);
  const tree = w.sh(bareDir, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.deepEqual([tree.includes('new-name.md'), tree.includes('old-name.md')], [true, false]);
});

test('a brain whose branch here is not linked: the press links it to the server\'s branch, then saves and uploads', async () => {
  const ws = path.join(w.root, 'link-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  w.sh(b, 'branch', '--unset-upstream');
  fs.writeFileSync(path.join(b, 'linked.md'), '# linked\n');
  const before = await brainChanges({ dir: ws });
  assert.deepEqual([before.upstream, before.elsewhere], [null, undefined], 'the server has its branch: it can be linked');
  const lines = [];
  const r = await saveBrain({ dir: ws, onLine: (l) => lines.push(l) });
  assert.deepEqual([r.ok, r.saved, r.uploaded], [true, 1, true]);
  assert.equal(w.sh(b, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main', 'linked to the server\'s branch');
  assert.match(serverLog()[0], /Save the AI brain/);
  assert.ok(lines.some((l) => /Linked to team\/ai_brain on git\.example\.test/.test(l)), lines.join('\n'));
});

test('a git server with no branch yet: the press uploads the brain\'s branch there and links them', async () => {
  const emptyUrl = w.bare('empty_brain', { empty: true });
  const emptyDir = path.join(w.server, 'team', 'empty_brain.git');
  const ws = path.join(w.root, 'new-branch-ws');
  const b = path.join(ws, 'ai_brain');
  fs.mkdirSync(b, { recursive: true });
  w.sh(b, 'init', '-q', '-b', 'notes');
  w.commit(b, 'README.md', '# brain\n', 'Start the AI brain');
  w.sh(b, 'remote', 'add', 'origin', emptyUrl);
  fs.writeFileSync(path.join(b, 'notes.md'), '# notes\n');
  const r = await saveBrain({ dir: ws });
  assert.deepEqual(r, { ok: true, saved: 1, uploaded: true, linked: true });
  assert.equal(w.sh(b, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/notes');
  assert.match(w.sh(emptyDir, 'log', '--oneline', '-1', 'notes'), /Save the AI brain/);
  assert.equal((await brainChanges({ dir: ws })).upstream, 'origin/notes');
});

test('the brain here on master, the git server keeps it on main: nothing is pushed, said with what to ask', async () => {
  const ws = path.join(w.root, 'master-ws');
  const b = w.clone(url, path.join(ws, 'ai_brain'));
  w.sh(b, 'branch', '-q', '-m', 'main', 'master');
  w.sh(b, 'branch', '--unset-upstream');
  fs.writeFileSync(path.join(b, 'mine.md'), 'm\n');
  const head = w.sh(b, 'rev-parse', 'HEAD');
  const branches = w.sh(bareDir, 'branch', '--list', '--format=%(refname:short)');
  // Said before any press: the sheet gets why it cannot be linked, and the same words as the refusal.
  const c = await brainChanges({ dir: ws });
  assert.equal(c.upstream, null);
  assert.match(c.elsewhere || '', /on "master", and team\/ai_brain on git\.example\.test keeps it on "main"\. Ask your coding tool/);
  await assert.rejects(saveBrain({ dir: ws }), (e) => e.status === 409 && /Nothing was done/.test(e.message) && /"master"/.test(e.message) && /"main"/.test(e.message) && /coding tool/.test(e.message));
  assert.equal(w.sh(bareDir, 'branch', '--list', '--format=%(refname:short)'), branches, 'no new branch on the server');
  assert.equal(w.sh(b, 'rev-parse', 'HEAD'), head, 'nothing committed here');
  assert.match(w.sh(b, 'status', '--porcelain'), /\?\? mine\.md/);
});

test('the route: his own page only, a job with its output; refused to Tia, a token, no sign-in and another site', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [A.home], backend: 'pty' } });
  const script = createToken('a script');
  let saves = 0;
  let seenAtPress = null;
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, workspace: { saveBrain: async ({ onLine, seen }) => (saves++, (seenAtPress = seen), onLine('Uploaded'), { ok: true, saved: 1, uploaded: true }) } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  saveConfig({ server: { port } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = async (body, headers) => {
      const r = await fetch(`${origin}/api/workspace/git/brain`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    assert.equal((await post({ save: true }, { Authorization: 'Bearer tia_0123456789abcdef' })).status, 401, 'Tia\'s token alone is not signed in');
    assert.ok([401, 403].includes((await post({ save: true }, { Authorization: 'Bearer tia_0123456789abcdef', Cookie: cookie, Origin: origin })).status), 'Tia\'s token, also with the cookie');
    assert.equal((await post({ save: true }, { Authorization: `Bearer ${script.token}` })).status, 403, 'a script\'s or another dashboard\'s token');
    // A session's own call has no sign-in: refused by the origin check or the sign-in check, whichever comes first.
    assert.ok([401, 403].includes((await post({ save: true }, {})).status), 'a call with no sign-in, as a session\'s own would be');
    assert.equal((await post({ save: true }, { Origin: origin })).status, 401, 'no sign-in, from this dashboard\'s own address');
    assert.equal((await post({ save: true }, { Cookie: cookie, Origin: 'http://evil.example' })).status, 403, 'another site');
    assert.equal((await post({ save: 'yes' }, { Cookie: cookie, Origin: origin })).status, 400);
    assert.equal((await post({ save: true, seen: 'not-a-list' }, { Cookie: cookie, Origin: origin })).status, 400, 'seen is only the fingerprint brainChanges gives');
    assert.equal((await post({ save: true, force: true }, { Cookie: cookie, Origin: origin })).status, 400);
    assert.equal(saves, 0, 'none of those saved anything');
    const ok = await post({ save: true, seen: 'a'.repeat(64) }, { Cookie: cookie, Origin: origin });
    assert.deepEqual([ok.status, ok.json], [200, { started: true, kind: 'brain-save' }]);
    await new Promise((r) => setTimeout(r, 50));
    const job = await (await fetch(`${origin}/api/workspace/job?from=0`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual([job.kind, job.running, job.lines, job.result.ok], ['brain-save', false, ['Uploaded'], true]);
    assert.equal(saves, 1);
    assert.equal(seenAtPress, 'a'.repeat(64), 'what the sheet showed reaches the save');
    // The list for the sheet: read only, signed in.
    assert.equal((await fetch(`${origin}/api/workspace/git/brain`)).status, 401);
    const list = await (await fetch(`${origin}/api/workspace/git/brain`, { headers: { Cookie: cookie } })).json();
    assert.equal(list.repo, 'team/ai_brain on git.example.test');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('Tia\'s own call (in the dashboard, not over HTTP) is refused, also with her confirm card', async () => {
  const { Readable } = await import('node:stream');
  const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
  let saves = 0;
  const f = workspaceFeature({ config: () => ({}), readJson: async (req) => req.body, caller: () => 'self' }, { saveBrain: async () => (saves++, { ok: true }) });
  const [, , fn] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/workspace/git/brain'));
  await assert.rejects(fn(Object.assign(Readable.from([]), { body: { save: true }, headers: {} })), (e) => e.status === 403 && /owner's own step/.test(e.message));
  assert.equal(saves, 0);
});

test('nothing runs it by itself: only the workspace routes import it', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const users = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith('.mjs') && /brainsave\.mjs/.test(fs.readFileSync(path.join(src, f), 'utf8')));
  // brainmove.mjs (the sheet's Move out) reads the refusal list from it; only the routes import that one in turn.
  assert.deepEqual(users.map((f) => f.split(path.sep).join('/')), ['workspace/brainmove.mjs', 'workspace/feature.mjs'], 'no automation, upkeep or set-up imports it');
});

test.after(() => w.cleanup());
