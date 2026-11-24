// `hoprig drop`: what the owner reads. --check says everything it found, as --json does; the dry run goes in the order
// of the drop; every command given resolves what it names; no terminal is a refusal in --json too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropOn, dropWorld, reset } from './dropfix.mjs';

const w = await dropWorld('words');
test.after(() => w.cleanup());
const [A] = w.computers;
const api = () => path.join(A.shop, 'code', 'shop-api');
const web = () => path.join(A.shop, 'code', 'shop-web');
const API = 'projects/shop/code/shop-api';
/** The command line the refusal gives under its words (the indented line after the one that matches `re`). */
const commandAfter = (text, re) => {
  const l = text.split('\n');
  const i = l.findIndex((x) => re.test(x));
  assert.ok(i >= 0, text);
  return l[i + 1].trim();
};
/** Run a command line drop gave, as the owner pastes it (a shell line of && parts). */
const runLine = async (line) => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('sh', ['-c', line], { stdio: 'ignore' });
};

test('--check with a refusal still says the work, the pushes and the default branch, as --json does; its last line is a warning', async () => {
  await reset(A);
  w.sh(web(), 'tag', 'v-here'); // the refusal
  fs.writeFileSync(path.join(api(), 'README.md'), 'changed\n'); // work
  w.commit(web(), 'release.txt', 'ship\n'); // the default branch
  w.sh(web(), 'branch', 'idea'); // a push
  const t = await dropOn(A, ['shop', '--check']);
  const j = (await dropOn(A, ['shop', '--check', '--json'])).json.projects[0];
  assert.equal(t.code, 1);
  assert.match(t.text, /tag v-here is only on this computer/);
  assert.ok(j.asks.some((a) => a.ask === 'work') && j.asks.some((a) => a.ask === 'default branch') && j.pushes.some((p) => p.branch === 'idea'), JSON.stringify(j));
  assert.match(t.text, new RegExp(`it asks: commit the work not committed in ${API} \\(1 file\\)`));
  assert.match(t.text, /it asks: push main of projects\/shop\/code\/shop-web \(1 commit\)/);
  assert.match(t.text, /drop would push idea of projects\/shop\/code\/shop-web/);
  assert.match(t.text, /! something of it exists only here \(above\)\n$/, 'a warning, not a check mark');
});

test('the dry run asks first, then acts in the order the drop does, and ends with what happens to this computer\'s file', async () => {
  await reset(A);
  fs.writeFileSync(path.join(A.shop, 'ai_brain', 'claude-memory', 'note.md'), 'learned\n');
  w.sh(A.shop, 'switch', '-q', '-c', 'notes');
  fs.writeFileSync(path.join(api(), 'README.md'), 'changed\n');
  w.sh(web(), 'branch', 'idea');
  w.sh(web(), 'switch', '-q', 'idea');
  w.commit(web(), 'i.txt', 'i\n');
  w.sh(web(), 'switch', '-q', 'main');
  w.commit(web(), 'release.txt', 'ship\n');
  const t = (await dropOn(A, ['shop', '--dry-run'])).text;
  const at = (re) => {
    const i = t.search(re);
    assert.ok(i >= 0, `${re} in\n${t}`);
    return i;
  };
  const order = [/would ask: commit the work/, /would ask: push main of projects\/shop\/code\/shop-web/, /would commit the memory folder of projects\/shop/, /on your yes, would commit the work/, /would push idea of/, /as you answer, would push main of projects\/shop\/code\/shop-web/, /would check everything again/, /\(dry run\) would (not )?commit this computer's file/];
  const places = order.map(at);
  assert.deepEqual(places, [...places].sort((a, b) => a - b), t);
});

test('a cut-off drop is said once, relative to the workspace, and --check does not call itself a dry run', async () => {
  await reset(A);
  const away = path.join(A.projects, '.blog.dropping-20260101-000000');
  fs.mkdirSync(away);
  for (const mode of ['--check', '--dry-run']) {
    const t = (await dropOn(A, ['blog', mode])).text;
    assert.equal(t.split('.blog.dropping-20260101-000000').length - 1, 1, `${mode}: once\n${t}`);
    assert.match(t, mode === '--check' ? /a drop would finish projects\/\.blog\.dropping-20260101-000000/ : /\(dry run\) would finish projects\/\.blog\.dropping-20260101-000000/);
    if (mode === '--check') assert.doesNotMatch(t, /dry run/);
    for (const l of t.split('\n').filter((x) => x.includes('dropping'))) assert.ok(!l.includes(A.projects), `no absolute path: ${l}`);
  }
  fs.rmSync(away, { recursive: true });
});

test('--json without a terminal: a refused drop names why in refusals; the text gives each answer on its own line', async () => {
  await reset(A);
  fs.writeFileSync(path.join(api(), 'README.md'), 'changed\n');
  w.commit(web(), 'release.txt', 'ship\n');
  const j = (await dropOn(A, ['shop', '--json'])).json.projects[0];
  assert.equal(j.result, 'refused');
  assert.deepEqual(j.refusals, [{ repo: 'shop', what: 'it needs your answers, and there is no terminal to ask in', command: 'hoprig drop shop' }]);
  const t = (await dropOn(A, ['shop'])).text;
  assert.match(t, /✗ it needs your answers, and there is no terminal to ask in: run {2}hoprig drop shop {2}in a terminal\. It asks:\n {6}- commit the work[^\n]*\n {6}- push main of/);
});

test('a wrong name at the typed list stops "at the question about the list of what is deleted with it"', async () => {
  await reset(A);
  fs.writeFileSync(path.join(A.shop, '.env'), 'X=1\n');
  const r = await dropOn(A, ['shop'], { answers: ['nope'] });
  assert.equal(r.code, 1);
  assert.match(r.text, /stopped at the question about the list of what is deleted with it: the project stays here/);
  fs.rmSync(path.join(A.shop, '.env'));
});

test('a diverged branch: the command drop gives brings it together with no pull setting, also without an upstream; then the drop goes through', async () => {
  for (const upstream of [true, false]) {
    const b = upstream ? 'feat' : 'feat-plain';
    // Files named by the branch: git names a commit by its content and its time, so the second round's commits would
    // otherwise BE the first round's (already on the git server) whenever both fall in the same second.
    const f = (n) => `${b}-${n}`;
    await reset(A);
    w.sh(api(), 'switch', '-q', '-c', b);
    w.commit(api(), f('f.txt'), 'one\n');
    w.sh(api(), 'push', '-q', ...(upstream ? ['-u'] : []), 'origin', b);
    const other = path.join(w.root, `other-${upstream}`);
    fs.rmSync(other, { recursive: true, force: true });
    w.clone(w.u.api, other);
    w.sh(other, 'switch', '-q', b);
    w.commit(other, f('theirs.txt'), 'theirs\n');
    w.sh(other, 'push', '-q');
    w.commit(api(), f('mine.txt'), 'mine\n');
    w.sh(api(), 'switch', '-q', 'main');
    const r = await dropOn(A, ['shop']);
    assert.equal(r.code, 1, r.text);
    const line = commandAfter(r.text, new RegExp(`${b} and its branch on the git server have both moved`));
    assert.match(line, new RegExp(`pull --no-rebase origin ${b}$`));
    await runLine(line);
    w.sh(api(), 'switch', '-q', 'main');
    const again = await dropOn(A, ['shop']);
    assert.equal(again.code, 0, `upstream ${upstream}: ${again.text}`);
  }
});

test('a tag that differs from the server\'s: the command takes the server\'s tag, never a forced push; then the drop goes through', async () => {
  await reset(A);
  w.sh(api(), 'tag', 'v2');
  w.sh(api(), 'push', '-q', 'origin', 'refs/tags/v2');
  w.commit(api(), 'x.txt', 'x\n');
  w.sh(api(), 'push', '-q');
  w.sh(api(), 'tag', '-f', 'v2');
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /tag v2 here is not the same as the git server's tag v2: take the server's with the command below, or first keep this one under a new name/);
  const line = commandAfter(r.text, /tag v2 here is not the same/);
  assert.match(line, /fetch origin --force refs\/tags\/v2:refs\/tags\/v2$/);
  assert.doesNotMatch(line, /push/);
  await runLine(line);
  const again = await dropOn(A, ['shop']);
  assert.equal(again.code, 0, again.text);
});

test('a detached HEAD with one commit: "1 commit that is"', async () => {
  await reset(A);
  w.sh(api(), 'switch', '-q', '--detach');
  w.commit(api(), 'lost.txt', 'x\n');
  const r = await dropOn(A, ['shop', '--check']);
  assert.match(r.text, /has 1 commit that is on no branch/);
  w.sh(api(), 'switch', '-q', 'main');
});

test('a real memory folder of a code repository: the command moves its files into the project\'s memory folder; the next drop commits and pushes them', async () => {
  await reset(A);
  const d = path.join(A.claude, 'projects', web().replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'web-notes.md'), 'learned in web\n');
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 1, r.text);
  const line = commandAfter(r.text, /shop-web: Claude Code's memory for it is a real folder/);
  assert.match(line, /^mv -n \S+\/memory\/\* \S+\/projects\/shop\/ai_brain\/claude-memory\/ && rmdir \S+\/memory$/);
  await runLine(line);
  assert.equal(fs.existsSync(d), false, 'the folder is gone');
  const again = await dropOn(A, ['shop'], { answers: (q) => (q.trim() === '>' ? '2' : null) });
  assert.equal(again.code, 0, again.text);
  const bare = path.join(w.server, 'team', 'shop-workspace.git');
  const has = w.sh(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').some((ref) => {
    try {
      return w.sh(bare, 'show', `${ref}:ai_brain/claude-memory/web-notes.md`) === 'learned in web';
    } catch {
      return false;
    }
  });
  assert.ok(has, 'the memory is on the git server');
});
