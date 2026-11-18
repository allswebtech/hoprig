// The run records of "Do it" (src/work/runs.mjs) and the folders a task's session works in (src/work/folders.mjs), on
// a temporary computer: a run is checked strictly before it is written (an unknown key, a full path, a bad state are
// refused), a secret and the computer's own paths are taken out of a session's words, the files are read tolerantly
// (a broken or misnamed file is passed over, a link is not followed), and a folder is one of the project's own
// choices, never a path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tempWork, write } from './helpers.mjs';

const t = tempWork('work-runs');
test.after(() => t.cleanup());
const runsMod = await import('../../src/work/runs.mjs');
const { HOST_WORD, RUN_ID_RE, checkRun, cleanText, listRuns, newRunId, pathsOf, readRun, writeRun, writerId } = runsMod;
const folders = await import('../../src/work/folders.mjs');

const place = { folder: path.join(t.root, 'workdata'), label: 'ai_brain/work' };
fs.mkdirSync(place.folder, { recursive: true });
const base = () => ({
  v: 1, id: newRunId(new Date('2026-11-17T10:00:00Z')), item: 'renew-the-domain', title: 'Renew the domain', writer: writerId(), by: 'owner',
  startedAt: '2026-11-17T10:00:00.000Z', endedAt: null, project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null,
  session: null, conversation: null, message: null, brief: 'Renew the domain', state: 'running', reason: null, answer: '',
  commits: [], changed: [], more: 0, was: 'open', statusError: null,
});

test('a run id holds the day and time and random characters; the writer id is this dashboard\'s own and stays', () => {
  const id = newRunId(new Date('2026-11-17T10:04:05Z'));
  assert.match(id, RUN_ID_RE);
  assert.ok(id.startsWith('20261117-100405-'));
  assert.notEqual(newRunId(), newRunId(), 'two runs at once still differ');
  assert.equal(writerId(), writerId());
  assert.match(writerId(), /^[0-9a-f]{16}$/);
});

test('a run is checked strictly before it is written: unknown keys, bad values and full paths are refused', async () => {
  assert.doesNotThrow(() => checkRun(base()));
  assert.doesNotThrow(() => checkRun({ ...base(), model: 'sonnet[1m]' }), 'a model name Settings allows');
  assert.equal((await import('../../src/work/dofeature.mjs')).cleanChoices({ model: 'sonnet[1m]' }).model, 'sonnet[1m]');
  const bad = [
    { ...base(), extra: 1 },
    { ...base(), state: 'finished' },
    { ...base(), folder: '../elsewhere' },
    { ...base(), folder: '/etc' },
    { ...base(), project: '../x' },
    { ...base(), provider: 'a b' },
    { ...base(), answer: 'x'.repeat(4001) },
    { ...base(), changed: [{ repo: '.', path: '/etc/passwd', kind: 'changed' }] },
    { ...base(), changed: [{ repo: '.', path: '../up.txt', kind: 'changed' }] },
    { ...base(), commits: [{ repo: '.', short: 'zzzz', subject: 'x' }] },
    { ...base(), answer: `I wrote ${t.home}/notes.txt` },
    { ...base(), commits: [{ repo: '.', short: 'abc1234', subject: `Add ${t.home}/notes.txt` }] },
    { ...base(), by: 'someone' },
    { ...base(), title: 'two\nlines' },
  ];
  for (const r of bad) assert.throws(() => checkRun(r), /a run record/, JSON.stringify(r).slice(0, 120));
  const { answer, ...noAnswer } = base();
  assert.throws(() => checkRun(noAnswer), /has no "answer"/);
});

test('a session\'s words: a secret masked, the computer\'s paths taken out, escapes and control characters gone, cut at the limit', () => {
  const paths = pathsOf({ projectsDir: t.projects, workspace: t.ws, home: t.home });
  const said = `Done in ${t.projects}/shop/src and ${t.ws}/ai_brain; also ${t.home}/x.\nKey: ${'sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz'} \x1b[31mred\x1b[0m`;
  const out = cleanText(said, 4000, paths);
  assert.ok(!out.includes(t.root), out);
  assert.ok(!out.includes('sk-ant-api03'), out);
  assert.match(out, /Done in shop\/src and ai_brain; also ~\/x\./);
  assert.match(out, /red/);
  assert.ok(!out.includes('\x1b'));
  assert.equal(cleanText('x'.repeat(5000), 4000).length, 4000);
  // A longer name that starts like a path is not taken for it.
  assert.equal(cleanText(`${t.home}2/y`, 100, paths), `${t.home}2/y`);
  // A key broken by an escape sequence (coloured output) is masked whole, not stored as one piece once the escape goes.
  const colored = cleanText('token ghp_A1b2C3d4E5f6\x1b[1mG7h8I9j0K1l2M3n4O5p6Q7r8 here', 4000, paths);
  assert.equal(colored, 'token *** here');
  // ... and so by a control character or any other terminal sequence: a charset choice (what tput sgr0 sends), a link
  // (OSC 8, ended by BEL or by ST), a title, the 8-bit CSI.
  const split = {
    nul: '\x00', bell: '\x07', backspace: '\x08', escape: '\x1b', delete: '\x7f', c1: '\x80\x8f', tab: '\x0b', page: '\x0c', nextLine: '\x85',
    charset: '\x1b(B', keypad: '\x1b=', save: '\x1b7', link: '\x1b]8;;https://example.com/x\x07', linkSt: '\x1b]8;;https://example.com/x\x1b\\',
    title: '\x1b]0;shop\x07', dcs: '\x1bPq#0\x1b\\', csi8: '\x9b1m', osc8bit: '\x9d0;t\x9c', private: '\x1b[?25l', twoBytes: '\x1b(0\x1b)B',
  };
  for (const [k, sep] of Object.entries(split)) assert.equal(cleanText(`token ghp_A1b2C3d4E5f6${sep}G7h8I9j0K1l2M3n4O5p6Q7r8 here`, 400), 'token *** here', k);
  assert.equal(cleanText('a\x0bb\x0cc d\u2028e\u2029f\x85g\th\ni', 400), 'abc d e fg\th\ni', 'a tab and a line break stay, the line and paragraph separators are a space');
  // A control character or an escape right after the home folder or this computer's name is the edge of a word there:
  // the path and the name are still taken out, though what comes after is joined to what stands for them.
  asHost('box2', () => {
    const home = [['/home/alex/', '~/'], ['/home/alex', '~']];
    const glued = {
      'cd /home/alex\x07foo done': 'cd ~foo done',
      'at /home/alex\x1b(Bfoo': 'at ~foo',
      'at /home/alex\x1b[0mfoo and /home/alex\x00/x': 'at ~foo and ~/x',
      [`ssh alex@box2\x07more and box\x072 too`]: `ssh alex@${HOST_WORD}more and ${HOST_WORD} too`,
      'from /home/al\x07ex/notes': 'from ~/notes',
    };
    for (const [said, out] of Object.entries(glued)) assert.equal(cleanText(said, 400, home), out, JSON.stringify(said));
    assert.equal(cleanText('the edge \uFDD0 never stays', 400), 'the edge  never stays');
  });
  // An answer of millions of letters in one key-like run: cut before it is masked, so masking never overflows.
  // (The first cut falls inside that one word, so the whole of it goes.)
  assert.equal(cleanText(`sk-${'a'.repeat(10_000_000)}`, 4000, paths), '');
  assert.ok(cleanText(`eyJ${'a'.repeat(10_000_000)}`, 4000, paths).length <= 4000);
  // A key that this first cut splits leaves nothing of itself, also when masking what stood before it made the text
  // short enough to keep its end.
  const keys = `sk-ant-api03-${'A'.repeat(100)} `.repeat(13);
  const cut = [
    [`${keys}${'x'.repeat(1600 - keys.length - 16)}`, 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', /A1b2|ghp_/],
    [`${keys}${'x '.repeat((1600 - keys.length - 16) / 2)}`, 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', /A1b2|ghp_/],
    [`${keys}`.padEnd(1600 - 3 - 'password='.length, ' ') + 'password=', 'hunter2hunter2', /hun/],
  ];
  for (const [lead, key, never] of cut) {
    assert.equal(lead.length + key.length > 1600 && lead.length < 1600, true);
    const out = cleanText(`${lead}${key} and on`, 400);
    assert.ok(out.length < 400 && !never.test(out), out.slice(-60));
  }
  assert.equal(cleanText(`${'word '.repeat(320)}after`, 400).length, 400, 'a cut between words takes nothing more');
  // ... also when the word at the cut is longer than a key and the key stands near its start, and when the cut falls
  // on a control character inside the key (a vertical tab, a form feed, a next line: they go without a trace).
  const twelve = `sk-ant-api03-${'A'.repeat(100)} `.repeat(12);
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const long = `${twelve}${'/'.repeat(1385 - twelve.length)}${token}${'/'.repeat(400)} and on`;
  assert.ok(long.indexOf(token) < 1600 - 200 && long.indexOf(token) + token.length > 1600 - 200);
  for (const sep of ['\x0b', '\x0c', '\x85', '\x00', '\x0b\x0c']) {
    const atCut = `${twelve}${'x '.repeat((1584 - twelve.length) / 2)}${token.slice(0, 16)}${sep}${token.slice(16)} and on`;
    assert.equal(atCut.indexOf(sep), 1600);
    for (const s of [long, atCut]) {
      const out = cleanText(s, 400);
      assert.ok(out.length <= 400 && !/ghp_|A1b2/.test(out), JSON.stringify(out.slice(-40)));
    }
  }
});

/** cleanText on a computer named `name` (os.hostname is read at each call). */
function asHost(name, fn) {
  const was = os.hostname;
  os.hostname = () => name;
  try {
    return fn();
  } finally {
    os.hostname = was;
  }
}

test('this computer\'s name is taken out where it stands as a word, and a name that is an ordinary word only where it is a host', () => {
  // A name that is no ordinary word (a digit, a dash, a dot in it): wherever it stands as a word of its own.
  asHost('alexs-box2.lan', () => {
    assert.equal(cleanText('pushed from alex@alexs-box2.lan:/srv/x, then ALEXS-BOX2 rebooted', 400), `pushed from alex@${HOST_WORD}:/srv/x, then ${HOST_WORD} rebooted`);
    assert.equal(cleanText('myalexs-box2x and alexs-box2-2 stay', 400), 'myalexs-box2x and alexs-box2-2 stay', 'only the name as a word of its own');
  });
  // A name of one plain word that is no ordinary one (the owner's own): wherever it stands as a word, as uname -a, the
  // macOS prompt, ssh and ping say it.
  asHost('alexsmac', () => {
    const said = 'Linux alexsmac 7.0.0-43-generic #43 SMP x86_64; alexsmac:shop alex$ npm test; Connection to alexsmac closed. ping alexsmac.lan, alex@alexsmac.lan; Running on AlexsMac now';
    assert.equal(cleanText(said, 400), said.replace(/alexsmac/gi, HOST_WORD));
    assert.equal(cleanText('the alexsmacs and myalexsmac stay', 400), 'the alexsmacs and myalexsmac stay', 'only the name as a word of its own');
  });
  // A name that is an ordinary word (the default of many computers): only after "@" and before ":" with a path.
  asHost('ubuntu', () => {
    const said = 'Installed it on Ubuntu 24.04; see ubuntu.com, the ubuntu-latest runner and ubuntu: the release';
    assert.equal(cleanText(said, 400), said);
    assert.equal(cleanText('alex@ubuntu:~/shop$ ls, then ubuntu:/srv/x and ssh alex@ubuntu.local; mail x@ubuntu.com', 400),
      `alex@${HOST_WORD}:~/shop$ ls, then ${HOST_WORD}:/srv/x and ssh alex@${HOST_WORD}.local; mail x@ubuntu.com`);
  });
  asHost('dev', () => {
    assert.equal(cleanText('Ran npm run dev, then the dev server; [alex@dev shop]$ exit', 400), `Ran npm run dev, then the dev server; [alex@${HOST_WORD} shop]$ exit`);
    // A package's tag or a ref after "@" is no host: only a prompt or an ssh target makes it one.
    const tags = 'Run npm install hoprig@dev, then pnpm add react@dev. Pin @scope/ui@dev; see org/repo@dev and x@dev.lan';
    assert.equal(cleanText(tags, 400), tags);
    assert.equal(cleanText('alex@dev:~$ ls\n(alex@dev:~/shop) and ssh alex@dev\nthen ssh root@dev.local.', 400),
      `alex@${HOST_WORD}:~$ ls\n(alex@${HOST_WORD}:~/shop) and ssh alex@${HOST_WORD}\nthen ssh root@${HOST_WORD}.local.`);
  });
  asHost('main', () => {
    const said = 'uses: actions/checkout@main and uses: org/shop/.github/workflows/ci.yml@main';
    assert.equal(cleanText(said, 400), said);
    assert.equal(cleanText('[alex@main shop]$ git push', 400), `[alex@${HOST_WORD} shop]$ git push`);
  });
  // The last cut never leaves the start of a word that reads as the name or a key once the ellipsis ends it: what is
  // kept stays as it is when it is cleaned again, as Save asks of a run file.
  asHost('alexs-box2', () => {
    const tails = { name: ' alexs-box2-2 rest of it', host: ' ssh a@alexs-box2x rest', key: ' AKIA' + 'ABCDEFGHIJKLMNOPQRS more' };
    for (const [what, tail] of Object.entries(tails)) {
      for (let n = 340; n < 400; n++) {
        const out = cleanText(`${'x'.repeat(n)}${tail}${' and so on'.repeat(10)}`, 400);
        assert.ok(out.length <= 400 && out.endsWith('…'), `${what} ${n}`);
        assert.equal(cleanText(out, 400), out, `${what} ${n}: ${out.slice(-24)}`);
      }
    }
    assert.equal(cleanText(`${'x'.repeat(1500)}`, 400).length, 400, 'a cut that leaves nothing of the kind takes nothing more');
  });
  // A package's scope or a mention is no host: only a user's name before "@" makes it one.
  asHost('app', () => {
    assert.equal(cleanText('Moved it to @app/core, as @app asked; import from "@app/ui"', 400), 'Moved it to @app/core, as @app asked; import from "@app/ui"');
    assert.equal(cleanText('alex@app:~/shop$ npm test', 400), `alex@${HOST_WORD}:~/shop$ npm test`);
  });
});

test('run files: written atomically in runs/, read newest first, a broken, misnamed or linked file passed over', () => {
  const a = writeRun(place, { ...base(), id: '20261117-100000-aaaaaaaa' });
  writeRun(place, { ...base(), id: '20261118-090000-bbbbbbbb', item: 'other-task' });
  const dir = path.join(place.folder, 'runs');
  write(dir, { '20261119-000000-cccccccc.json': '{ broken', 'notes.json': '{}', '20261119-000000-dddddddd.json': JSON.stringify({ ...base(), id: '20261119-000000-eeeeeeee' }) });
  write(t.root, { 'outside/run.json': JSON.stringify({ ...base(), id: '20261120-000000-ffffffff' }) });
  fs.symlinkSync(path.join(t.root, 'outside/run.json'), path.join(dir, '20261120-000000-ffffffff.json'));
  assert.deepEqual(listRuns(place).map((r) => r.id), ['20261118-090000-bbbbbbbb', '20261117-100000-aaaaaaaa']);
  assert.deepEqual(listRuns(place, { item: 'renew-the-domain' }).map((r) => r.id), [a.id]);
  assert.equal(readRun(place, a.id).item, 'renew-the-domain');
  assert.equal(readRun(place, '../outside/run'), null, 'an id is checked against its pattern');
  assert.equal(readRun(place, '20261120-000000-ffffffff'), null, 'a link is not followed');
  assert.throws(() => writeRun(place, { ...base(), state: 'nope' }), /a run record/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temporary file left');
  // A runs folder that is a link leads nowhere Work writes.
  const other = { folder: path.join(t.root, 'workdata2'), label: 'x' };
  fs.mkdirSync(other.folder);
  fs.symlinkSync(path.join(t.root, 'outside'), path.join(other.folder, 'runs'));
  assert.throws(() => writeRun(other, base()), /not a plain folder/);
  assert.deepEqual(listRuns(other), []);
});

test('the folders of a project: its own and its code repositories; a link out, a private or a dot folder is no choice', async () => {
  const shop = path.join(t.projects, 'shop');
  t.repo(shop);
  t.repo(path.join(shop, 'code', 'web'));
  fs.mkdirSync(path.join(shop, 'code', 'notes'), { recursive: true }); // not a repository
  t.repo(path.join(t.root, 'elsewhere'));
  fs.symlinkSync(path.join(t.root, 'elsewhere'), path.join(shop, 'code', 'away'));
  fs.mkdirSync(path.join(shop, 'code', 'no-ai', '.git'), { recursive: true });
  assert.deepEqual(folders.folderChoices(shop).map((f) => f.value), ['.', 'code/web']);
  assert.equal(folders.folderOf(shop, 'code/web'), fs.realpathSync(path.join(shop, 'code', 'web')));
  for (const f of ['code/away', 'code/notes', '../shop', '/etc', 'code/no-ai']) assert.throws(() => folders.folderOf(shop, f), /choose the project/, f);
  assert.deepEqual(folders.reposOf(shop, '.').map((r) => r.repo), ['.', 'code/web']);
  assert.deepEqual(folders.reposOf(shop, 'code/web').map((r) => r.repo), ['code/web']);

  fs.rmSync(path.join(shop, 'code', 'away'));
  // What a session left: the commits since the start, the files changed and not committed (Work's own folder and the
  // code repositories inside the project's folder left out of the project's own list).
  const repos = folders.reposOf(shop, '.');
  const start = await folders.headsOf(repos);
  assert.equal(start.length, 2);
  assert.ok(start.every((s) => /^[0-9a-f]{40}$/.test(s.head)));
  write(shop, { 'a.txt': 'a\n' });
  t.git(shop, 'add', 'a.txt');
  t.git(shop, 'commit', '-q', '-m', 'Add a');
  write(path.join(shop, 'code', 'web'), { 'index.html': '<p>\n' });
  t.git(path.join(shop, 'code', 'web'), 'add', 'index.html');
  t.git(path.join(shop, 'code', 'web'), 'commit', '-q', '-m', 'Add the page');
  write(shop, { 'README.md': '# changed\n', 'new.txt': 'n\n', 'plans/tasks.json': '{}\n' });
  const left = await folders.leftIn(repos, start, { skip: [path.join(shop, 'plans')] });
  assert.deepEqual(left.commits.map((c) => [c.repo, c.subject]), [['.', 'Add a'], ['code/web', 'Add the page']]);
  assert.ok(left.commits.every((c) => /^[0-9a-f]{7,}$/.test(c.short)));
  assert.deepEqual(left.changed.filter((c) => c.repo === '.').map((c) => [c.path, c.kind]).sort(), [['README.md', 'changed'], ['new.txt', 'new']]);
  assert.ok(!JSON.stringify(left).includes(t.root), 'no full path');

  // A file changed before the session started is not the session's: only when the session changed it again.
  const { before, beforeCut } = await folders.dirtyOf(repos, { skip: [path.join(shop, 'plans')] });
  assert.equal(beforeCut, false);
  assert.deepEqual(before.filter((b) => b.repo === '.').map((b) => b.path).sort(), ['README.md', 'new.txt']);
  assert.ok(before.every((b) => /^[0-9a-f]{16}$/.test(b.sig)));
  write(shop, { 'new.txt': 'changed by the session\n', 'made.txt': 'm\n' });
  const after = await folders.leftIn(repos, await folders.headsOf(repos), { skip: [path.join(shop, 'plans')], before });
  assert.deepEqual(after.changed.map((c) => c.path).sort(), ['made.txt', 'new.txt'], 'README.md was so before and is the same');
  assert.deepEqual(after.commits, []);
  assert.equal(after.more, 0);
  for (const f of ['README.md', 'new.txt', 'made.txt', 'a.txt']) fs.rmSync(path.join(shop, f), { force: true });
  t.git(shop, 'checkout', '-q', '--', '.');
});

test('a folder with many changed files before the session: what the session changed is still listed, the rest counted', async () => {
  const dir = path.join(t.root, 'many');
  t.repo(dir);
  const repos = [{ repo: '.', dir: fs.realpathSync(dir) }];
  const gen = {};
  for (let i = 0; i < 1000; i++) gen[`gen/f${i}.txt`] = `${i}\n`;
  write(dir, gen);
  const start = await folders.headsOf(repos);
  const { before } = await folders.dirtyOf(repos);
  assert.equal(before.length, 1000);
  write(dir, { 'src-app.js': 'made\n', 'gen/f999.txt': 'changed by the session\n' });
  const left = await folders.leftIn(repos, start, { before });
  assert.deepEqual(left.changed.map((c) => c.path).sort(), ['gen/f999.txt', 'src-app.js']);
  assert.equal(left.more, 0);
  // More than a run lists: the first 200, and how many more.
  const made = {};
  for (let i = 0; i < 250; i++) made[`out/m${i}.txt`] = 'm\n';
  write(dir, made);
  const lots = await folders.leftIn(repos, start, { before });
  assert.equal(lots.changed.length, 200);
  assert.equal(lots.more, 52);
  fs.rmSync(path.join(dir, 'out'), { recursive: true });
});

test('a file larger than a megabyte is told by its size and time, never read (the dashboard is not held up)', async () => {
  const dir = path.join(t.root, 'big');
  t.repo(dir);
  const repos = [{ repo: '.', dir: fs.realpathSync(dir) }];
  write(dir, { 'big.bin': Buffer.alloc(2 * 1024 * 1024, 1), 'small.txt': 's\n' });
  const { before } = await folders.dirtyOf(repos);
  const sig = Object.fromEntries(before.map((b) => [b.path, b.sig]));
  assert.match(sig['big.bin'], /^big:2097152:\d+$/);
  assert.match(sig['small.txt'], /^[0-9a-f]{16}$/);
  assert.deepEqual((await folders.leftIn(repos, await folders.headsOf(repos), { before })).changed, [], 'both as they were');
});

test('a file name a run does not hold (a control character, a folder named ~) is counted, never listed, never an error', async () => {
  const dir = path.join(t.root, 'odd');
  t.repo(dir);
  const repos = [{ repo: '.', dir: fs.realpathSync(dir) }];
  write(dir, { 'notes\tdraft.md': 'x\n', '~/inside.txt': 'y\n', 'plain.txt': 'p\n' });
  const { before } = await folders.dirtyOf(repos);
  assert.equal(before.length, 3, 'weighed like the rest (kept on this computer only)');
  write(dir, { 'odd\nname.txt': 'z\n', 'made.txt': 'm\n' });
  const left = await folders.leftIn(repos, await folders.headsOf(repos), { before });
  assert.deepEqual(left.changed.map((c) => c.path), ['made.txt']);
  assert.equal(left.more, 1, 'the one the session made; the two that were there before are not its');
  assert.doesNotThrow(() => checkRun({ ...base(), changed: left.changed, more: left.more }));
});

test('a run file is never larger than a reader takes: the lists are shortened to fit, and what was left out counted', () => {
  const long = (i) => `${'deep/'.repeat(80)}file-${i}.txt`;
  const big = { ...base(), id: '20261117-100000-0000000a', state: 'done', endedAt: '2026-11-17T10:30:00.000Z', answer: 'a'.repeat(4000),
    changed: Array.from({ length: 200 }, (_, i) => ({ repo: '.', path: long(i), kind: 'new' })), more: 7 };
  const w = writeRun(place, big);
  assert.ok(w.changed.length < 200 && w.changed.length > 50, String(w.changed.length));
  assert.equal(w.more, 7 + 200 - w.changed.length);
  assert.ok(fs.statSync(path.join(place.folder, 'runs', `${big.id}.json`)).size <= runsMod.RUN_FILE_MAX);
  assert.equal(readRun(place, big.id).changed.length, w.changed.length, 'and it reads back');
  fs.rmSync(path.join(place.folder, 'runs', `${big.id}.json`));
});
