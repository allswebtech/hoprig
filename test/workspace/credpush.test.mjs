// Where the credentials repository is pushed (credrepo.mjs): a GitHub repository is known as GitHub's however its
// address is written (an SSH host alias of a second account, ssh.github.com on port 443, www.github.com), so a public
// one is never pushed to, by the command or by the upkeep. Each case on a temporary home with a stand-in GitHub.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, runCli } from '../pcsetup/dryrun-fixture.mjs';

const ws = await import('../../src/workspace/cli.mjs');
const { githubOf, readAddress, upkeepCredentials } = await import('../../src/workspace/credrepo.mjs');
const { readMap, writeMap } = await import('../../src/workspace/map.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const VALUE = 'push-value-4c8e';
const NAME = 'push-name-0b7d';
const typed = (word) => ({ interactive: true, answers: () => word });
const creds = (args, o) => runCli((a, x) => ws.main(a, x), ['credentials', ...args], o);

/** A world with a version-2 map, a credentials folder (700) holding a marked file, and a stand-in ssh. */
async function world(tc, name) {
  const w = await dryWorld(tc, name);
  assert.equal((await runCli((a, o) => ws.main(a, o), ['map', '--upgrade', '--yes'])).code, 0);
  const c = path.join(w.ws, 'credentials');
  fs.mkdirSync(path.join(c, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(c, 'shop', `${NAME}.env`), `API_KEY=${VALUE}\n`);
  fs.chmodSync(c, 0o700);
  // ssh -G as an SSH settings file with "Host github-work / HostName github.com" answers (never this computer's own).
  fs.writeFileSync(path.join(w.root, 'bin', 'ssh'), '#!/bin/sh\n[ "$1" = "-G" ] || exit 255\ncase "$2" in github-work) echo "hostname github.com";; *) echo "hostname $2";; esac\necho "port 22"\n', { mode: 0o755 });
  // git reaches the stand-in GitHub under each spelling, as it reaches github.com itself.
  for (const s of ['git@github-work:', 'ssh://git@ssh.github.com:443/', 'https://www.github.com/']) fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, `[url "${String(w.server).replaceAll('\\', '/')}/"]\n\tinsteadOf = ${s}\n`);
  w.creds = c;
  w.bare = (rel) => {
    const d = path.join(w.server, rel);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', d]);
    return d;
  };
  w.log = (d) => w.sh(d, 'for-each-ref', '--format=%(subject)');
  w.clean = (text) => {
    assert.equal(text.includes(VALUE), false, 'a value in the output');
    assert.equal(text.includes(NAME), false, 'a file name of the folder in the output');
  };
  return w;
}

const SPELLINGS = ['git@github-work:alex/credentials.git', 'ssh://git@ssh.github.com:443/alex/credentials.git', 'https://www.github.com/alex/credentials.git'];

test('a public GitHub repository under another spelling (host alias, ssh.github.com, www) is refused by the command', async (tc) => {
  const w = await world(tc, 'cp-spell');
  const bare = w.bare('alex/credentials.git');
  fs.writeFileSync(path.join(w.server, 'alex', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
  for (const url of SPELLINGS) {
    const r = await w.unchanged(`credentials --repo ${url}`, () => creds(['--repo', url], typed('credentials')));
    assert.equal(r.code, 1, `${url}: ${r.text}`);
    assert.match(r.text, /is refused: it is public on GitHub/, url);
    assert.doesNotMatch(r.text, /This is not a GitHub address/, url);
    w.clean(r.text);
  }
  assert.equal(w.log(bare), '', 'nothing pushed');
  assert.equal(readMap(w.ws).map.credentials, undefined);
  // Private under the alias: asked, and pushed.
  fs.rmSync(path.join(w.server, 'alex', 'visibility.json'));
  const ok = await creds(['--repo', SPELLINGS[0]], typed('credentials'));
  assert.equal(ok.code, 0, ok.text);
  assert.doesNotMatch(ok.text, /This is not a GitHub address/);
  assert.equal(w.log(bare), 'Credentials');
});

test('the upkeep never pushes to a repository that is public on GitHub under a host alias', async (tc) => {
  const w = await world(tc, 'cp-upkeep');
  const bare = w.bare('alex/credentials.git');
  assert.equal((await creds(['--repo', gh('credentials')], typed('credentials'))).code, 0);
  // The map and the folder name the same repository by the alias; then it is made public.
  for (const url of SPELLINGS) {
    writeMap({ ...readMap(w.ws).map, credentials: { url } }, w.ws);
    w.sh(w.creds, 'remote', 'set-url', 'origin', url);
    fs.writeFileSync(path.join(w.server, 'alex', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
    fs.writeFileSync(path.join(w.creds, 'shop', `${NAME}.env`), `API_KEY=${VALUE}-${Date.now()}\n`);
    const u = await upkeepCredentials({ dir: w.ws });
    assert.match(u.needs.join(' '), /not pushed: .*is refused: it is public on GitHub/, url);
    assert.equal(w.sh(bare, 'log', '--format=%s', 'main'), 'Credentials', `${url}: nothing pushed`);
    w.clean(JSON.stringify(u));
  }
});

// git pushes to every remote.origin.pushurl, a plain `git push` follows branch.<b>.pushRemote, and a pushInsteadOf rule
// rewrites the address for a push only: none of them may take the credentials to another repository.
async function pushedWorld(tc, name) {
  const w = await world(tc, name);
  w.mine = w.bare('alex/credentials.git');
  w.other = w.bare('mallory/open.git');
  assert.equal((await creds(['--repo', gh('credentials')], typed('credentials'))).code, 0);
  w.change = () => fs.writeFileSync(path.join(w.creds, 'shop', `${NAME}.env`), `API_KEY=${VALUE}-${Date.now()}\n`);
  return w;
}
test('two push addresses, the other one first: the upkeep pushes to neither', async (tc) => {
  const w = await pushedWorld(tc, 'cp-two');
  w.sh(w.creds, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/mallory/open.git');
  w.sh(w.creds, 'config', '--add', 'remote.origin.pushurl', gh('credentials'));
  w.change();
  const u = await upkeepCredentials({ dir: w.ws });
  assert.match(u.needs.join(' '), /not pushed: its remote origin is not the address the map names/);
  assert.equal(w.log(w.other), '', 'nothing reached the other repository');
  assert.equal(w.sh(w.mine, 'log', '--format=%s', 'main'), 'Credentials');
  const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
  assert.match(s.repos.find((x) => x.label === 'credentials').todo.map((t) => t.why).join(' '), /not pushed, its remote origin is not the address/);
  assert.equal(w.log(w.other), '');
});

test('a branch push remote: sync pushes the credentials to the map\'s address only', async (tc) => {
  const w = await pushedWorld(tc, 'cp-pushremote');
  w.sh(w.creds, 'remote', 'add', 'side', w.other);
  w.sh(w.creds, 'config', 'branch.main.pushRemote', 'side');
  w.sh(w.creds, 'config', 'remote.pushDefault', 'side');
  w.change();
  w.sh(w.creds, 'commit', '-qam', 'by hand');
  const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
  const cr = s.repos.find((x) => x.label === 'credentials');
  assert.deepEqual(cr.did, ['pushed 1'], JSON.stringify(cr));
  assert.equal(w.log(w.other), '', 'nothing reached the push remote');
  assert.deepEqual(w.sh(w.mine, 'log', '--format=%s', 'main').split('\n'), ['by hand', 'Credentials']);
  // The upkeep's own push too.
  w.change();
  const u = await upkeepCredentials({ dir: w.ws });
  assert.match(u.lines.join(' '), /pushed to the address the map names/, JSON.stringify(u));
  assert.equal(w.log(w.other), '');
});

test('a pushInsteadOf rule that sends the map\'s address elsewhere: not pushed', async (tc) => {
  const w = await pushedWorld(tc, 'cp-pushinstead');
  // https://github.com/alex/credentials.git is pushed to <server>/mallory/open.git; it is still fetched from alex's.
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, `[url "${String(path.join(w.server, 'mallory', 'open')).replaceAll('\\', '/')}"]\n\tpushInsteadOf = https://github.com/alex/credentials\n`);
  assert.equal(w.sh(w.creds, 'remote', 'get-url', '--push', 'origin'), w.other, 'the rule really sends a push there');
  w.change();
  const u = await upkeepCredentials({ dir: w.ws });
  assert.match(u.needs.join(' '), /not pushed: .*a push from it would go to another address/);
  const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
  assert.match(s.repos.find((x) => x.label === 'credentials').todo.map((t) => t.why).join(' '), /not pushed, .*another address/);
  assert.equal(w.log(w.other), '', 'nothing reached the other repository');
  assert.equal(w.sh(w.mine, 'log', '--format=%s', 'main'), 'Credentials');
});

// The owner's own hooks (a global core.hooksPath, such as a secret scanner) never run on the credentials folder, and
// git's own text about it (a hook's, the server's) never reaches the output, an activity line or a notification.
test('a global hook that prints a staged name and value: it does not run, and nothing of the folder is said', async (tc) => {
  const w = await world(tc, 'cp-hooks');
  w.bare('alex/credentials.git');
  const hooks = path.join(w.root, 'hooks');
  const ran = path.join(w.root, 'hook-ran');
  fs.mkdirSync(hooks);
  for (const h of ['pre-commit', 'commit-msg', 'pre-push', 'reference-transaction', 'post-merge']) {
    // Only the credentials folder is watched: the stand-in server (a bare repository here, which reads the same global
    // settings) and the brain are other repositories, where the owner's hooks run as git runs them.
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\n[ "$(pwd)" = "${w.creds}" ] || exit 0\necho ${h} >> "${ran}"\necho "leak found in $(git diff --cached --name-only | head -1): $(git diff --cached | grep API_KEY | head -1)" >&2\nexit 1\n`, { mode: 0o755 });
  }
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${hooks}\n`);
  const r = await creds(['--repo', gh('credentials')], typed('credentials'));
  assert.equal(r.code, 0, r.text);
  w.clean(r.text);
  fs.writeFileSync(path.join(w.creds, 'shop', `${NAME}.env`), `API_KEY=${VALUE}-2\n`);
  const u = await upkeepCredentials({ dir: w.ws });
  assert.deepEqual(u.needs, [], JSON.stringify(u));
  w.clean(JSON.stringify(u));
  const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
  w.clean(JSON.stringify(s.repos.find((x) => x.label === 'credentials')));
  assert.equal(fs.existsSync(ran), false, `a hook ran: ${fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : ''}`);
});

test('git\'s own text of a failed push or fetch is never passed on: plain words only', async (tc) => {
  const w = await world(tc, 'cp-words');
  w.bare('alex/credentials.git');
  assert.equal((await creds(['--repo', gh('credentials')], typed('credentials'))).code, 0);
  const leak = `remote: leak found in shop/${NAME}.env: +API_KEY=${VALUE}`;
  const { capture } = await import('../../src/setup/system.mjs');
  // A server (or a hook) whose last words name a file and a value.
  const failing = (what) => (argv, o) => (argv[0] === 'git' && argv.includes(what) ? Promise.resolve({ ok: false, code: 1, stdout: '', stderr: `${leak}\n` }) : capture(argv, o));
  fs.writeFileSync(path.join(w.creds, 'shop', `${NAME}.env`), `API_KEY=${VALUE}-2\n`);
  const u = await upkeepCredentials({ dir: w.ws, run: failing('push') });
  assert.match(u.needs.join(' '), /the credentials could not be pushed: git failed \(exit 1\)/);
  w.clean(JSON.stringify(u));
  // (Without --push: the commit the failed push left stays to be pushed for the next round.)
  const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: false, run: failing('fetch') });
  const cr = s.repos.find((x) => x.label === 'credentials');
  assert.match(cr.todo.map((t) => t.why).join(' '), /fetch failed: git failed/);
  w.clean(JSON.stringify(cr));
  const p = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true, run: failing('push') });
  const cp = p.repos.find((x) => x.label === 'credentials');
  assert.match(cp.todo.map((t) => t.why).join(' '), /to push: the push failed \(git failed \(exit 1\)\)/, JSON.stringify(cp));
  w.clean(JSON.stringify(cp));
});

// An insteadOf rule that sends the map's GitHub address to another owner's repository: visibility is asked of one
// repository, so the address git really reaches must be that one. alex/credentials is private, mallory/credentials
// public; the rule sends https://github.com/alex/ to mallory's.
const toMallory = (w) => `[url "${String(w.server).replaceAll('\\', '/')}/mallory/"]\n\tinsteadOf = https://github.com/alex/\n`;

test('an insteadOf rule that sends the address to a public repository of another owner: the command refuses it', async (tc) => {
  const w = await world(tc, 'cp-io-cmd');
  const mine = w.bare('alex/credentials.git');
  const pub = w.bare('mallory/credentials.git');
  fs.writeFileSync(path.join(w.server, 'mallory', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, toMallory(w));
  const r = await w.unchanged('credentials --repo', () => creds(['--repo', gh('credentials')], typed('credentials')));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /is refused: git really reaches another repository with it, through a url\.<base>\.insteadOf rule/);
  w.clean(r.text);
  // --github: refused before anything is created on GitHub.
  const g = await w.unchanged('credentials --github', () => creds(['--github'], typed('credentials')));
  assert.equal(g.code, 1, g.text);
  assert.match(g.text, /is refused: git really reaches another repository/);
  assert.equal(fs.existsSync(path.join(w.server, 'created.log')), false, 'nothing created');
  assert.equal(w.log(pub), '', 'nothing reached the public repository');
  assert.equal(w.log(mine), '');
  assert.equal(readMap(w.ws).map.credentials, undefined);
});

test('an insteadOf rule to another owner, in git\'s global settings or the folder\'s own: the upkeep and sync push to neither', async (tc) => {
  const w = await world(tc, 'cp-io-upkeep');
  const mine = w.bare('alex/credentials.git');
  const pub = w.bare('mallory/credentials.git');
  fs.writeFileSync(path.join(w.server, 'mallory', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
  assert.equal((await creds(['--repo', gh('credentials')], typed('credentials'))).code, 0);
  const global = fs.readFileSync(w.env.GIT_CONFIG_GLOBAL, 'utf8');
  const rules = [
    ['global', () => fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, toMallory(w)), () => fs.writeFileSync(w.env.GIT_CONFIG_GLOBAL, global)],
    ['the folder\'s own', () => w.sh(w.creds, 'config', `url.${w.server}/mallory/.insteadOf`, 'https://github.com/alex/'), () => w.sh(w.creds, 'config', '--unset', `url.${w.server}/mallory/.insteadOf`)],
  ];
  for (const [where, add, remove] of rules) {
    add();
    assert.equal(w.sh(w.creds, 'remote', 'get-url', '--push', 'origin'), path.join(w.server, 'mallory', 'credentials.git'), `${where}: the rule really sends a push there`);
    fs.writeFileSync(path.join(w.creds, 'shop', `${NAME}.env`), `API_KEY=${VALUE}-${where}\n`);
    const u = await upkeepCredentials({ dir: w.ws });
    assert.match(u.needs.join(' '), /not pushed: .*is refused: git really reaches another repository/, `${where}: ${JSON.stringify(u)}`);
    w.clean(JSON.stringify(u));
    // sync fetches through the same rule (an empty repository there: its branch is gone, nothing counts as ahead) and
    // pushes nothing either.
    const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
    assert.deepEqual(s.repos.find((x) => x.label === 'credentials').did.filter((d) => /pushed/.test(d)), [], where);
    assert.equal(w.log(pub), '', `${where}: nothing reached the public repository`);
    assert.equal(w.sh(mine, 'log', '--format=%s', 'main'), 'Credentials', where);
    remove();
    // The fetch through the rule left origin/main gone; each case starts from alex's repository as it is.
    w.sh(w.creds, 'fetch', '-q', 'origin');
  }
  // Without a rule the same folder is pushed to alex's own repository, and nothing to mallory's.
  const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
  assert.deepEqual(s.repos.find((x) => x.label === 'credentials').did.filter((d) => /pushed/.test(d)), ['pushed 2'], JSON.stringify(s.repos.find((x) => x.label === 'credentials')));
  assert.deepEqual(w.sh(mine, 'log', '--format=%s', 'main').split('\n'), ['Update credentials', 'Update credentials', 'Credentials']);
  assert.equal(w.log(pub), '');
});

test('a rule that keeps the address on github.com but changes the owner: githubOf names the other repository and refuses', async (tc) => {
  const w = await world(tc, 'cp-io-gh');
  w.use();
  // A mirror on this computer that keeps <owner>/<name> (the stand-in GitHub itself) is the same repository.
  assert.deepEqual(await githubOf(gh('credentials')), { full: 'alex/credentials' });
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, '[url "https://github.com/mallory/"]\n\tinsteadOf = https://github.com/alex/\n');
  const g = await githubOf(gh('credentials'));
  assert.match(g.why || '', /git really reaches another GitHub repository with it \(mallory\/credentials\)/, JSON.stringify(g));
});

// ---- where a push really goes: asked of git in the push's own environment, read by an allow-list of shapes ----
// A stand-in for the two questions githubOf asks: ssh's settings give every host its own name, git is not asked.
const noAlias = async (argv) => (argv[0] === 'ssh' ? { ok: true, stdout: `hostname ${argv[2]}\n` } : { ok: false, stdout: '' });

test('an address is read by an allow-list of shapes: a server, a folder on this computer, or unknown; never a guess', () => {
  const remote = (a, host, p, ssh) => assert.deepEqual(readAddress(a), { kind: 'remote', host, path: p, ssh }, a);
  remote('https://github.com/alex/credentials.git', 'github.com', 'alex/credentials.git', false);
  remote('HTTPS://GitHub.com./alex/credentials', 'github.com', 'alex/credentials', false);
  remote('https://someone:word@github.com:443/alex/credentials.git', 'github.com', 'alex/credentials.git', false);
  remote('git://git.example.com/alex/credentials.git', 'git.example.com', 'alex/credentials.git', false);
  remote('ssh://git@ssh.github.com:443/alex/credentials.git', 'ssh.github.com', 'alex/credentials.git', true);
  remote('git+ssh://git@git.example.com/alex/credentials.git', 'git.example.com', 'alex/credentials.git', true);
  remote('ssh+git://git@git.example.com/alex/credentials.git', 'git.example.com', 'alex/credentials.git', true);
  remote('ssh://git@[2001:db8::1]:2222/x/alex/credentials.git', '[2001:db8::1]', 'x/alex/credentials.git', true);
  remote('git@github-work:alex/credentials.git', 'github-work', 'alex/credentials.git', true);
  remote('git@git.example.com:/srv/git/credentials.git', 'git.example.com', 'srv/git/credentials.git', true);
  // The host is what follows the last "@", and a name that only begins like another is another host.
  remote('https://github.com@other.example/alex/credentials.git', 'other.example', 'alex/credentials.git', false);
  remote('ssh://github.com@other.example/alex/credentials.git', 'other.example', 'alex/credentials.git', true);
  remote('https://github.com.other.example/alex/credentials.git', 'github.com.other.example', 'alex/credentials.git', false);
  for (const a of ['/srv/mirror/alex/credentials.git', 'file:///srv/mirror/alex/credentials.git']) assert.equal(readAddress(a).kind, 'local', a);
  const unknown = ['', 'e:x/alex/credentials.git', '../alex/credentials.git', 'alex/credentials.git', '//server/share/alex/credentials.git', 'file://server/share/credentials.git', 'ext::ssh other.example %S alex/credentials', 'fd::7', 'ftp://git.example.com/alex/credentials.git',
    'https://git%2eexample.com/alex/credentials.git', 'https://gıthub.com/alex/credentials.git', 'https:///alex/credentials.git', 'ssh://git@/alex/credentials.git', 'git@github.com:', 'https://github.com/', 'https://git hub.com/alex/credentials.git',
    'https://github.com\t/alex/credentials.git', 'ssh://git@[2001:db8::1/alex/credentials.git', 'https://github.com:99999999/alex/credentials.git',
    // "#", "?" or "\\" before the path: git's own reader ends the host there, so what follows an "@" after it is not the host
    'https://other.example#@github.com/alex/credentials.git', 'https://other.example?x@github.com/alex/credentials.git', 'https://other.example\\@github.com/alex/credentials.git', 'ssh://other.example#@github.com/alex/credentials.git',
    // found by asking git itself which host it contacts (1,814 addresses): git:// takes "user@host" as the host's name; a number that is no
    // port stays part of the name; and git takes the bracketed address after an "@[" as the host wherever it stands
    'git://git@github.com/alex/credentials.git', 'ssh://git@github.com:99999/alex/credentials.git', 'ssh://git@github.com:0/alex/credentials.git', 'https://a@b@github.com/alex/credentials.git',
    'github.com:x@[2001:db8::1]:alex/credentials.git', 'github.com:x@[2001:db8::1]:/srv/alex/credentials.git'];
  // …while the same shapes without the trick are read.
  remote('git@[2001:db8::1]:alex/credentials.git', '[2001:db8::1]', 'alex/credentials.git', true);
  for (const a of unknown) assert.deepEqual(readAddress(a), { kind: 'unknown' }, JSON.stringify(a));
});

test('a push address in a shape the reader does not know, or on another server, is refused for a GitHub repository: never taken for a mirror on this computer', async () => {
  const url = 'https://github.com/alex/credentials.git';
  const odd = ['e:x/alex/credentials.git', 'ssh://git@[2001:db8::1]/x/alex/credentials.git', 'git+ssh://git@other.example/alex/credentials.git', 'ssh+git://git@other.example/alex/credentials.git', '../alex/credentials.git',
    'ext::ssh other.example %S alex/credentials', '//server/share/alex/credentials.git', 'file://server/share/alex/credentials.git', 'https://github.com.other.example/alex/credentials.git'];
  for (const a of odd) {
    const g = await githubOf(url, noAlias, { reached: [a] });
    assert.match(g.why || '', /could not be told|another server/, `${a}: ${JSON.stringify(g)}`);
  }
  // A folder on this computer that keeps <owner>/<name> is the same repository (a mirror); one that does not is another.
  assert.deepEqual(await githubOf(url, noAlias, { reached: ['/srv/mirror/alex/credentials.git'] }), { full: 'alex/credentials' });
  assert.deepEqual(await githubOf(url, noAlias, { reached: ['file:///srv/mirror/alex/credentials.git'] }), { full: 'alex/credentials' });
  assert.match((await githubOf(url, noAlias, { reached: ['/srv/mirror/mallory/credentials.git'] })).why || '', /another repository/);
  // The address itself in an unknown shape is refused too.
  assert.match((await githubOf('e:x/alex/credentials.git', noAlias, { reached: ['e:x/alex/credentials.git'] })).why || '', /could not be told/);
});

test('an address on another server: a rule that sends it to a third place is refused; the owner\'s short form of GitHub is judged as GitHub', async () => {
  const url = 'https://git.example.com/alex/credentials.git';
  assert.deepEqual(await githubOf(url, noAlias, { reached: [url] }), { full: null });
  for (const a of ['https://other.example/alex/credentials.git', 'https://git.example.com/mallory/credentials.git', 'git@other.example:alex/credentials.git', '/srv/mirror/alex/other.git']) {
    assert.match((await githubOf(url, noAlias, { reached: [a] })).why || '', /git really reaches another address with it/, a);
  }
  assert.match((await githubOf(url, noAlias, { reached: ['e:x/alex/credentials.git'] })).why || '', /could not be told/);
  // The same server and path over ssh instead of https (the usual rule of that kind) is the same repository.
  assert.deepEqual(await githubOf(url, noAlias, { reached: ['git@git.example.com:alex/credentials.git'] }), { full: null });
  // A folder on this computer that keeps the last two parts of the address is its mirror.
  assert.deepEqual(await githubOf(url, noAlias, { reached: ['/srv/mirror/alex/credentials.git'] }), { full: null });
  // "gh:" as a short form of the owner's for GitHub: git reaches GitHub, so the repository is judged as GitHub's.
  assert.deepEqual(await githubOf('gh:alex/credentials', noAlias, { reached: ['https://github.com/alex/credentials'] }), { full: 'alex/credentials' });
});

test('a rewrite rule given in the environment (GIT_CONFIG_COUNT) is seen by the check as by the push: the upkeep and sync push to neither', async (tc) => {
  const w = await world(tc, 'cp-io-env');
  const mine = w.bare('alex/credentials.git');
  const pub = w.bare('mallory/credentials.git');
  fs.writeFileSync(path.join(w.server, 'mallory', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
  assert.equal((await creds(['--repo', gh('credentials')], typed('credentials'))).code, 0);
  const rule = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${w.server}/mallory/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/alex/' };
  const off = () => { for (const k of Object.keys(rule)) delete process.env[k]; };
  tc.after(off);
  Object.assign(process.env, rule);
  assert.equal(execFileSync('git', ['-C', w.creds, 'remote', 'get-url', '--push', 'origin'], { encoding: 'utf8' }).trim(), path.join(w.server, 'mallory', 'credentials.git'), 'the rule really sends a push there');
  fs.writeFileSync(path.join(w.creds, 'shop', `${NAME}.env`), `API_KEY=${VALUE}-env\n`);
  const u = await upkeepCredentials({ dir: w.ws });
  assert.match(u.needs.join(' '), /not pushed: .*is refused: git really reaches another repository/, JSON.stringify(u));
  w.clean(JSON.stringify(u));
  const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
  assert.deepEqual(s.repos.find((x) => x.label === 'credentials').did.filter((d) => /pushed/.test(d)), []);
  assert.equal(w.log(pub), '', 'nothing reached the public repository');
  off();
  assert.equal(w.sh(mine, 'log', '--format=%s', 'main'), 'Credentials');
});

test('a remote that is pushed by a transport helper (remote.origin.vcs) is never pushed to', async (tc) => {
  const w = await world(tc, 'cp-vcs');
  const mine = w.bare('alex/credentials.git');
  assert.equal((await creds(['--repo', gh('credentials')], typed('credentials'))).code, 0);
  w.sh(w.creds, 'config', 'remote.origin.vcs', 'ext');
  fs.writeFileSync(path.join(w.creds, 'shop', `${NAME}.env`), `API_KEY=${VALUE}-vcs\n`);
  const u = await upkeepCredentials({ dir: w.ws });
  assert.match(u.needs.join(' '), /not pushed: its remote origin is not the address the map names: it is pushed by a transport helper/, JSON.stringify(u));
  w.clean(JSON.stringify(u));
  assert.equal(w.sh(mine, 'log', '--format=%s', 'main'), 'Credentials');
});

