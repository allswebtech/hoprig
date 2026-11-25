// `hoprig workspace credentials` (credrepo.mjs): off by default; the cost said and the repository's name typed (no
// flag, no piped answer without a terminal, no wrong word gets through); a GitHub address only when gh says it is
// private (public, not signed in, an unexpected answer: refused); another server only with the typed confirmation;
// --github creates a private repository only; another remote and a server with commits the folder lacks are refused
// with nothing changed; the folder stays 700; the map gets the address. Every refusal and every --dry-run is checked
// against a whole-home snapshot (dryrun-fixture.mjs), and no output names a file of the folder or a value in it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, runCli } from '../pcsetup/dryrun-fixture.mjs';

const ws = await import('../../src/workspace/cli.mjs');
const { readMap } = await import('../../src/workspace/map.mjs');
const VALUE = 'marker-value-7f3a';
const NAME = 'marker-name-91c2';
const typed = (word) => ({ interactive: true, answers: () => word });
const creds = (args, uiOpts) => runCli((a, o) => ws.main(a, o), ['credentials', ...args], uiOpts);

/** A world with a version-2 map and a credentials folder (700) holding a marked file. */
async function world(tc, name) {
  const w = await dryWorld(tc, name);
  const up = await runCli((a, o) => ws.main(a, o), ['map', '--upgrade', '--yes']);
  assert.equal(up.code, 0, up.text);
  const c = path.join(w.ws, 'credentials');
  fs.mkdirSync(path.join(c, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(c, 'shop', `${NAME}.env`), `API_KEY=${VALUE}\n`);
  fs.chmodSync(c, 0o700);
  // Another server ("git.example.test") for addresses that are not GitHub's.
  fs.mkdirSync(path.join(w.server, 'other'), { recursive: true });
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, `[url "${String(path.join(w.server, 'other')).replaceAll('\\', '/')}/"]\n\tinsteadOf = https://git.example.test/\n`);
  w.bareRepo = (rel) => {
    const d = path.join(w.server, rel);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', d]);
    return d;
  };
  w.creds = c;
  w.clean = (text) => {
    assert.equal(text.includes(VALUE), false, 'a value in the output');
    assert.equal(text.includes(NAME), false, 'a file name of the folder in the output');
  };
  await new Promise((r) => setTimeout(r, 20));
  return w;
}
const mode = (d) => fs.statSync(d).mode & 0o777;

test('off by default: the folder is a local folder and the map names no repository', async (tc) => {
  const w = await world(tc, 'cr-off');
  const r = await w.unchanged('workspace credentials', () => creds([]));
  assert.match(r.text, /credentials: a local folder, never in git/);
  assert.match(r.text, /the map names no credentials repository/);
  const j = await w.unchanged('workspace credentials --json', () => creds(['--json']));
  assert.deepEqual(JSON.parse(j.text.slice(j.text.indexOf('{'))), { folder: 'folder', ownerOnly: true });
  assert.equal(readMap(w.ws).map.credentials, undefined);
});

test('--repo to a private GitHub repository: dry run changes nothing; typed name pushes it and writes the map', async (tc) => {
  const w = await world(tc, 'cr-repo');
  w.bareRepo('alex/credentials.git');
  const d = await w.unchanged('credentials --repo --dry-run', () => creds(['--repo', gh('credentials'), '--dry-run']));
  assert.equal(d.code, 0, d.text);
  assert.match(d.text, /\(dry run\) would make the credentials folder a git repository/);
  assert.match(d.text, /\(dry run\) would commit 1 file in it as "Credentials"/);
  w.clean(d.text);
  await w.unchanged('credentials --repo --dry-run --json', () => creds(['--repo', gh('credentials'), '--dry-run', '--json']));
  const r = await creds(['--repo', gh('credentials')], typed('credentials'));
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Whoever can read that repository reads every key in it/);
  w.clean(r.text);
  assert.equal(readMap(w.ws).map.credentials.url, gh('credentials'));
  assert.equal(mode(w.creds), 0o700);
  assert.equal(w.sh(path.join(w.server, 'alex', 'credentials.git'), 'log', '--format=%s', 'main'), 'Credentials');
  // Run again: the folder is a repository with this remote and nothing to commit: only recorded.
  const again = await w.unchanged('credentials --repo again (dry run)', () => creds(['--repo', gh('credentials'), '--dry-run']));
  assert.doesNotMatch(again.text, /would push/);
});

test('the typed confirmation cannot be skipped: a wrong word, no terminal, a flag, piped --json', async (tc) => {
  const w = await world(tc, 'cr-typed');
  w.bareRepo('alex/credentials.git');
  const wrong = await w.unchanged('a wrong word', () => creds(['--repo', gh('credentials')], typed('yes')));
  assert.equal(wrong.code, 1);
  assert.match(wrong.text, /nothing was done: what was typed is not the repository's name/);
  const none = await w.unchanged('no terminal', () => creds(['--repo', gh('credentials')], { interactive: false, answers: () => 'credentials' }));
  assert.equal(none.code, 1);
  assert.match(none.text, /needs you at a terminal/);
  for (const flag of ['--yes', '--force', '--confirm=credentials']) {
    const f = await w.unchanged(`flag ${flag}`, () => creds(['--repo', gh('credentials'), flag], typed('credentials')));
    assert.equal(f.code, 2, `${flag} is no option of it`);
  }
  const j = await w.unchanged('--json without --dry-run', () => creds(['--repo', gh('credentials'), '--json'], typed('credentials')));
  assert.equal(j.code, 2);
  const yes = await w.unchanged('ui.yes (a --yes given to the whole command)', () => creds(['--repo', gh('credentials')], { yes: true, interactive: false }));
  assert.equal(yes.code, 1);
});

test('a public GitHub repository, gh not signed in, and an unexpected answer are refused with nothing changed', async (tc) => {
  const w = await world(tc, 'cr-public');
  w.bareRepo('alex/credentials.git');
  fs.writeFileSync(path.join(w.server, 'alex', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
  const p = await w.unchanged('public', () => creds(['--repo', gh('credentials')], typed('credentials')));
  assert.equal(p.code, 1);
  assert.match(p.text, /is refused: it is public on GitHub/);
  // Another spelling of the same address: SSH and upper case.
  const ssh = await w.unchanged('public, ssh form', () => creds(['--repo', 'git@github.com:Alex/Credentials.git'], typed('Credentials')));
  assert.match(ssh.text, /is refused: it is public on GitHub/);
  fs.rmSync(path.join(w.server, 'alex', 'visibility.json'));
  // (unchanged() sets the world's environment first: the stand-in's switches are set inside what it measures.)
  const out = await w.unchanged('not signed in', () => ((process.env.FAKE_GH_USER = ''), creds(['--repo', gh('credentials')], typed('credentials'))));
  assert.equal(out.code, 1);
  assert.match(out.text, /its visibility could not be asked: gh is not signed in/);
  try {
    const g = await w.unchanged('garbage', () => ((process.env.FAKE_GH_VIEW = 'garbage'), creds(['--repo', gh('credentials')], typed('credentials'))));
    assert.equal(g.code, 1);
    assert.match(g.text, /gh answered something unexpected/);
  } finally {
    delete process.env.FAKE_GH_VIEW;
    w.use();
  }
  // gh missing altogether: a PATH that holds git only (never the computer's own gh, which a plain PATH could reach).
  const onlyGit = path.join(w.tmp, '..', 'only-git');
  fs.mkdirSync(onlyGit, { recursive: true });
  const gitBin = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  fs.symlinkSync(path.join(gitBin, 'git'), path.join(onlyGit, 'git'));
  await new Promise((r) => setTimeout(r, 20));
  const noGh = await w.unchanged('gh missing', () => ((process.env.PATH = onlyGit), creds(['--repo', gh('credentials')], typed('credentials'))));
  w.use();
  assert.equal(noGh.code, 1);
  assert.match(noGh.text, /its visibility could not be asked: gh is not on this computer/);
});

test('a GitHub repository made public between the plan and the push is not pushed to, and the folder is as before', async (tc) => {
  const w = await world(tc, 'cr-flip');
  w.bareRepo('alex/credentials.git');
  // The answer that types the name also makes the repository public (as someone could on GitHub at that moment).
  const flip = { interactive: true, answers: () => (fs.writeFileSync(path.join(w.server, 'alex', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' })), 'credentials') };
  const r = await creds(['--repo', gh('credentials')], flip);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /is refused: it is public on GitHub: what this run did in the folder was undone/);
  assert.equal(fs.existsSync(path.join(w.creds, '.git')), false);
  assert.equal(w.sh(path.join(w.server, 'alex', 'credentials.git'), 'for-each-ref'), '', 'nothing pushed');
  assert.equal(readMap(w.ws).map.credentials, undefined);
  assert.equal(mode(w.creds), 0o700);
});

test('another server: the owner confirms it is private by typing; then it is pushed', async (tc) => {
  const w = await world(tc, 'cr-other');
  w.bareRepo('other/team/creds-box.git');
  const url = 'https://git.example.test/team/creds-box.git';
  const wrong = await w.unchanged('other server, wrong word', () => creds(['--repo', url], typed('creds')));
  assert.match(wrong.text, /Hoprig cannot ask whether it is private: you confirm that it is/);
  assert.equal(wrong.code, 1);
  const r = await creds(['--repo', url], typed('creds-box'));
  assert.equal(r.code, 0, r.text);
  assert.equal(readMap(w.ws).map.credentials.url, url);
});

test('--github creates a private repository only (dry run first: nothing changes)', async (tc) => {
  const w = await world(tc, 'cr-github');
  const d = await w.unchanged('credentials --github --dry-run', () => creds(['--github', '--dry-run']));
  assert.match(d.text, /would create the private repository alex\/credentials on GitHub \(gh repo create --private\)/);
  await w.unchanged('credentials --github keys --dry-run', () => creds(['--github', 'keys', '--dry-run']));
  const r = await creds(['--github'], typed('credentials'));
  assert.equal(r.code, 0, r.text);
  w.clean(r.text);
  assert.equal(fs.readFileSync(path.join(w.server, 'created.log'), 'utf8'), 'alex/credentials --private\n');
  assert.equal(readMap(w.ws).map.credentials.url, 'https://github.com/alex/credentials.git');
  assert.equal(mode(w.creds), 0o700);
});

test('a folder with another remote, and a server with commits the folder lacks: refused, nothing changed', async (tc) => {
  const w = await world(tc, 'cr-foreign');
  w.bareRepo('alex/credentials.git');
  const seed = path.join(w.root, 'seed', 'foreign');
  fs.mkdirSync(seed, { recursive: true });
  w.sh(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'x'), 'x\n');
  w.sh(seed, 'add', '-A');
  w.sh(seed, 'commit', '-q', '-m', 'theirs');
  w.sh(seed, 'push', '-q', path.join(w.server, 'alex', 'credentials.git'), 'main');
  await new Promise((r) => setTimeout(r, 20));
  const f = await w.unchanged('server with foreign commits', () => creds(['--repo', gh('credentials')], typed('credentials')));
  assert.match(f.text, /has commits this folder does not have: nothing was done/);
  w.sh(w.creds, 'init', '-q', '-b', 'main');
  w.sh(w.creds, 'remote', 'add', 'origin', gh('elsewhere'));
  await new Promise((r) => setTimeout(r, 20));
  const o = await w.unchanged('another remote', () => creds(['--repo', gh('credentials')], typed('credentials')));
  assert.match(o.text, /a repository with another remote: nothing was done/);
});

test('a map of version 1 is refused with the hint', async (tc) => {
  const w = await dryWorld(tc, 'cr-v1');
  fs.mkdirSync(path.join(w.ws, 'credentials'), { mode: 0o700 });
  const r = await w.unchanged('version 1', () => creds(['--repo', gh('credentials')], typed('credentials')));
  assert.equal(r.code, 1);
  assert.match(r.text, /hoprig workspace map --upgrade/);
});

test('a run killed after the remote was set and before the push: the next run pushes, never only records', async (tc) => {
  const w = await world(tc, 'cr-killed');
  w.bareRepo('alex/credentials.git');
  // What such a run leaves: a repository with the commit and the remote, and nothing on the server.
  w.sh(w.creds, 'init', '-q', '-b', 'main');
  w.sh(w.creds, 'add', '-A');
  w.sh(w.creds, 'commit', '-q', '-m', 'Credentials');
  w.sh(w.creds, 'remote', 'add', 'origin', gh('credentials'));
  const d = await creds(['--repo', gh('credentials'), '--dry-run']);
  assert.match(d.text, /would push it to/);
  const r = await creds(['--repo', gh('credentials')], typed('credentials'));
  assert.equal(r.code, 0, r.text);
  assert.equal(w.sh(path.join(w.server, 'alex', 'credentials.git'), 'log', '--format=%s', 'main'), 'Credentials');
  assert.equal(readMap(w.ws).map.credentials.url, gh('credentials'));
});
