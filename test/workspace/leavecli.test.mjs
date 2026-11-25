// `hoprig pc leave …` (src/workspace/leavecli.mjs): a help word reads nothing; --json is the check's Report as it is;
// the exit code is 0 when nothing is only here, 1 when something is, 2 for words not understood; the printed report has
// a heading per group, each line with where, what, the size and what to do, the "not checked, by your word" lines, and
// ends in exactly one of two lines. The mark flags hand their folder to the marks module and print its answer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitWorld } from './gitfix.mjs';
import { sealed } from '../seal.mjs';

const { LEAVE_USAGE, NOTHING_LINE, leaveMain, somethingLine } = await import('../../src/workspace/leavecli.mjs');
const { leaveCheck } = await import('../../src/workspace/leave.mjs');
const { probeEnv } = await import('../../tools/build-skill.mjs');

const BIN = fileURLToPath(new URL('../../bin/hoprig.mjs', import.meta.url));
const homeLook = async () => ({ items: [], asks: [], outside: [], notChecked: [] });
const NOW = () => Date.UTC(2026, 10, 20, 8, 0, 0);

let w;
let c;

/** `hoprig pc leave <args>` through leaveMain, on the test's computer: { code, out }. */
async function leave(args, opts = {}) {
  let out = '';
  const code = await leaveMain(args, { write: (s) => (out += s), ctx: { dir: c.ws, projects: c.projects }, home: c.home, look: { homeLook, now: NOW }, ...opts });
  return { code, out };
}
const lastLine = (out) => out.trimEnd().split('\n').pop();

before(() => {
  w = gitWorld('leave-cli');
  c = w.computer('alpha');
  c.use();
  w.clone(w.bare('shop'), path.join(c.projects, 'shop'));
});
after(() => w && w.cleanup());

test('help, --help and -h print the usage and read nothing: no look, no mark, nothing written in the home', async () => {
  const touched = [];
  const check = async () => touched.push('check');
  const marks = { setMark: () => touched.push('setMark'), unmark: () => touched.push('unmark') };
  for (const args of [['help'], ['--help'], ['-h'], ['--check', '--help'], ['--outside', '~/x', '-h']]) {
    const r = await leave(args, { check, marks });
    assert.equal(r.code, 0, args.join(' '));
    assert.equal(r.out, `${LEAVE_USAGE}\n`);
  }
  assert.deepEqual(touched, []);
  // Through the program itself, in a throw-away home of its own: the same text, and the home stays empty.
  for (const word of ['help', '--help', '-h']) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leave-help-')));
    try {
      const r = spawnSync(process.execPath, [BIN, 'pc', 'leave', word], { env: sealed({ ...probeEnv(home), PORT: '0' }), cwd: home, encoding: 'utf8', timeout: 20_000 });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${LEAVE_USAGE}\n`, word);
      assert.deepEqual(fs.readdirSync(home, { recursive: true }), [], `pc leave ${word} wrote nothing`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('words that are not understood print the usage with exit 2, and nothing is looked at', async () => {
  const touched = [];
  const check = async () => touched.push('check');
  for (const args of [[], ['--json'], ['--also', '/tmp'], ['--check', '--also'], ['--check', 'extra'], ['--check', '--fast'], ['--outside'], ['--check', '--outside', '~/old'], ['--keep', '~/.toolx', '--json']]) {
    const r = await leave(args, { check });
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out, `${LEAVE_USAGE}\n`, args.join(' '));
  }
  assert.deepEqual(touched, []);
});

test('--json is the Report of the check as it is; exit 0 when nothing is only here, then 1 when something is', async () => {
  const clean = await leave(['--check', '--json']);
  assert.equal(clean.code, 0, clean.out);
  const want = await leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, homeLook, now: NOW });
  assert.deepEqual(JSON.parse(clean.out), want);
  assert.equal(want.nothingOnlyHere, true);
  const text = await leave(['--check']);
  assert.equal(text.code, 0);
  assert.equal(lastLine(text.out), NOTHING_LINE);
  assert.equal(text.out.split('\n').filter((l) => l === NOTHING_LINE).length, 1);

  w.commit(path.join(c.projects, 'shop'), 'plan.md', 'plan\n');
  fs.mkdirSync(path.join(c.home, 'old', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(c.home, 'old', 'notes', 'a.txt'), 'a'.repeat(2048));
  const some = await leave(['--check', '--json', '--also', '~/old']);
  assert.equal(some.code, 1, some.out);
  const got = JSON.parse(some.out);
  assert.deepEqual(got, await leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, also: [path.join(c.home, 'old')], homeLook, now: NOW }));
  assert.deepEqual(got.items.map((i) => `${i.kind} ${i.where}`).sort(), ['branch ~/Workspace/projects/shop', 'folder ~/old/notes']);
  const printed = await leave(['--check', '--also', '~/old']);
  assert.equal(printed.code, 1);
  assert.equal(lastLine(printed.out), somethingLine(2));
  assert.ok(!printed.out.includes(NOTHING_LINE));
  w.sh(path.join(c.projects, 'shop'), 'push', '-q', 'origin', 'main');
  fs.rmSync(path.join(c.home, 'old'), { recursive: true, force: true });
});

test('the printed report: a heading per group, where, what, the size and what to do on each line, the lines left out by your word, one last line', async () => {
  const report = {
    at: new Date(NOW()).toISOString(),
    cheap: false,
    items: [
      { id: 'branch:~/Workspace/projects/shop:feature/x', kind: 'branch', where: '~/Workspace/projects/shop', what: '2 commits on feature/x are on no git server', size: null, todo: 'push it', command: 'git -C /w/shop push origin feature/x', pushable: true },
      { id: 'folder:~/Workspace/projects/old-notes', kind: 'folder', where: '~/Workspace/projects/old-notes', what: 'a folder in no git: 3 files', size: 3 * 1024 * 1024, todo: 'make it a repository with a git server and push it, or mark it as yours to keep', command: 'hoprig pc leave --outside ~/Workspace/projects/old-notes', pushable: false },
      { id: 'key:~/.ssh/id_ed25519', kind: 'key', where: '~/.ssh/id_ed25519', what: 'a private key with no copy in the credentials folder', size: 411, todo: 'copy it into the credentials folder', command: '', pushable: false },
    ],
    asks: [{ id: 'dotfolder:~/.toolx', kind: 'dotfolder', where: '~/.toolx', size: 40 * 1024 * 1024, question: 'it holds a program\'s own data: keep (you back it up) or ignore?' }],
    outside: [{ where: '~/Desktop/old', why: 'not checked, by your word' }],
    notChecked: [{ where: '~/big', why: 'at least 1.0 GB, not measured further' }],
    nothingOnlyHere: false,
  };
  const r = await leave(['--check'], { check: async () => report });
  assert.equal(r.code, 1);
  const lines = r.out.trimEnd().split('\n');
  for (const heading of ['Git repositories', 'Folders in no git', 'Outside the workspace', 'Asked once: keep it (you back it up) or ignore it', 'Not looked at, so not counted as safe']) assert.equal(lines.filter((l) => l === heading).length, 1, `${heading}:\n${r.out}`);
  assert.ok(lines.includes('  ~/Workspace/projects/shop: 2 commits on feature/x are on no git server'), r.out);
  assert.ok(lines.includes('    push it:  git -C /w/shop push origin feature/x'), r.out);
  assert.ok(lines.includes('  ~/Workspace/projects/old-notes: a folder in no git: 3 files (3.0 MB)'), r.out);
  assert.ok(lines.includes('  ~/.ssh/id_ed25519: a private key with no copy in the credentials folder (411 B)'), r.out);
  assert.ok(lines.includes('  ~/.toolx (40.0 MB): it holds a program\'s own data: keep (you back it up) or ignore?'), r.out);
  assert.ok(lines.includes('    hoprig pc leave --keep ~/.toolx   or   hoprig pc leave --ignore ~/.toolx'), r.out);
  assert.ok(lines.includes('  ~/big: at least 1.0 GB, not measured further'), r.out);
  assert.ok(lines.includes('not checked, by your word: ~/Desktop/old'), r.out);
  assert.equal(lines.at(-1), somethingLine(5));
  assert.equal(lines.filter((l) => l === NOTHING_LINE || /things? exists? only on this computer/.test(l)).length, 1);
  assert.equal(somethingLine(1), '1 thing exists only on this computer (above).');
  assert.equal(somethingLine(5), '5 things exist only on this computer (above).');
});

test('the mark flags hand each folder (as a full path) or engine to the marks module and print its answer; a refusal is exit 1', async () => {
  const calls = [];
  const marks = {
    setMark: (o) => (calls.push(['set', o.kind, o.what, o.dir, o.home]), o.kind === 'ignore' ? { ok: false, why: 'a folder outside the home is not marked' } : { ok: true, marks: {} }),
    unmark: (o) => (calls.push(['unmark', o.what]), { ok: true, marks: {} }),
  };
  const ok = await leave(['--outside', '~/Desktop/old', '~/Desktop/older', '--keep', '~/.toolx', '--test-data', 'postgresql', '--unmark', '~/.other', 'mysql'], { marks });
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(calls, [
    ['set', 'outside', path.join(c.home, 'Desktop', 'old'), c.ws, c.home],
    ['set', 'outside', path.join(c.home, 'Desktop', 'older'), c.ws, c.home],
    ['set', 'keep', path.join(c.home, '.toolx'), c.ws, c.home],
    ['set', 'testData', 'postgresql', c.ws, c.home],
    ['unmark', path.join(c.home, '.other')],
    ['unmark', 'mysql'],
  ]);
  assert.match(ok.out, /^~\/Desktop\/old: marked outside\.$/m);
  assert.match(ok.out, /^postgresql: marked as test data only\.$/m);
  assert.match(ok.out, /^mysql: no longer marked\.$/m);
  const no = await leave(['--ignore', '/srv/x'], { marks });
  assert.equal(no.code, 1);
  assert.equal(no.out, '/srv/x: not marked: a folder outside the home is not marked\n');
  // The marks module of this build: its answer is printed as it is.
  const stub = await leave(['--outside', '~/Desktop/old']);
  assert.equal(stub.code, 1);
  assert.match(stub.out, /^~\/Desktop\/old: not marked: /);
});
