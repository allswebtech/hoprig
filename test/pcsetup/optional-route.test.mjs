// The Setup tab's routes with the optional kits: GET /api/pcsetup/kits carries each kit's suggestion, the PHP note,
// the MariaDB start commands and the Java line; POST /api/pcsetup/setup and fix take only kits that exist (java, an
// unknown id or a project's name is refused) and a fix only for a check that has one. The page's summary never counts a
// note as something to fix. Plan-only: the job's runner is a stand-in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-route-'));
Object.assign(process.env, { HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.Node ??= class {};

const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
const { extraChecks, kitChecks } = await import('../../src/pcsetup/status.mjs');
const { detectKits } = await import('../../src/pcsetup/detect.mjs');
const { showCommand } = await import('../../src/setup/system.mjs');
const { setupSummary } = await import('../../web/pcsetup.js');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

const projects = path.join(tmp, 'projects');
fs.mkdirSync(path.join(projects, 'legacy'), { recursive: true });
fs.writeFileSync(path.join(projects, 'legacy', 'composer.json'), JSON.stringify({ require: { php: '^8.1 <8.4' } }));
fs.mkdirSync(path.join(projects, 'mobile'), { recursive: true });
fs.writeFileSync(path.join(projects, 'mobile', '.fvmrc'), '{}');
// An Android app: the one project here that needs Java, so the Java line is looked for and shown.
fs.mkdirSync(path.join(projects, 'mobile', 'android'), { recursive: true });
fs.writeFileSync(path.join(projects, 'mobile', 'android', 'build.gradle'), '');

function harness(sysOver = {}) {
  const runs = [];
  const answers = { 'php -v': 'PHP 8.5.4 (cli)', 'apt-cache policy php-cli': '  Candidate: 2:8.5+99ubuntu1\n', 'apt-cache pkgnames php': 'php-cli\n' };
  const sys = {
    platform: 'linux', pm: 'pacman', root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: process.env.HOME, env: { PATH: '/usr/bin' }, clt: true,  // seal: simulated sys facts; which() is stubbed, no program is started
    has: (b) => ['php', 'dart', 'sudo'].includes(b), exists: () => false, list: () => [], which: () => null,
    run: async (argv) => (answers[argv.join(' ')] ? { ok: true, stdout: answers[argv.join(' ')], stderr: '' } : { ok: false, stdout: '', stderr: '' }),
    ...sysOver,
  };
  const runPcSetup = async (o) => {
    runs.push(o.kits);
    return { ok: true, missing: [], changed: false };
  };
  const checks = [{ group: 'kit:php', id: 'php.composer', label: 'Composer', status: 'info', detail: 'not installed (optional)', fix: '', fixKit: 'php' }, { group: 'kit:php', id: 'php.note-0', label: 'PHP for legacy', status: 'warn', detail: 'x', fix: '', note: true }];
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [] }, deck: { launcher: () => ['node', 'hoprig'], terminal: async () => {} } };
  const f = pcsetupFeature(sctx, { computer: () => 'box2', sys, status: async () => checks, projectsDir: () => projects, runPcSetup, sudoNeedsPassword: async () => false });
  const call = async (method, p, body) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) if (m === method && re.exec(u.pathname)) return fn(Object.assign(Readable.from([]), { body }), null, u.searchParams);
    throw new Error(`no route ${method} ${p}`);
  };
  return { call, runs };
}

test('GET /api/pcsetup/kits: the new kits unticked by default, with the suggestion, the PHP note, the start commands and Java', async () => {
  const { call } = harness();
  const d = await call('GET', '/api/pcsetup/kits');
  const php = d.kits.find((k) => k.id === 'php');
  const fvm = d.kits.find((k) => k.id === 'fvm');
  assert.equal(php.defaultOn, false);
  assert.equal(fvm.defaultOn, false);
  assert.equal(d.kits.find((k) => k.id === 'docker').defaultOn, false);
  assert.deepEqual(php.suggested, ['legacy has composer.json']);
  assert.deepEqual(fvm.suggested, ['mobile has .fvmrc']);
  assert.deepEqual(php.commands, ['sudo pacman -S --needed --noconfirm composer mariadb']);
  assert.deepEqual(php.start, ['sudo mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql', 'sudo systemctl enable --now mariadb']);
  assert.match(php.after, /Hoprig does not start it; to start it now and with the computer, run:$/);
  assert.equal(php.notes[0].verdict, 'newer');
  assert.match(php.notes[0].text, /^legacy needs PHP 8\.1 up to 8\.3, and PHP 8\.5\.4 here is too new\. What you can do: run legacy in Docker with the official php:8\.3 image/);
  assert.deepEqual(fvm.commands, ['dart pub global activate fvm']);
  assert.equal(d.java.state, 'missing');
  assert.match(d.java.text, /^No Java found/);
  assert.deepEqual(d.notCovered, []);
  // The page shows the same sentence and the same line as pc setup and pc status (java.mjs makes both).
  const jbr = path.join(process.env.HOME, 'android-studio', 'jbr', 'bin', 'java');
  const { call: call2 } = harness({ exists: (f) => f === jbr, run: async (argv) => (argv[0] === jbr ? { ok: true, stdout: '', stderr: 'openjdk version "21.0.6"' } : { ok: false, stdout: '', stderr: '' }) });
  const j = (await call2('GET', '/api/pcsetup/kits')).java;
  const { javaHomeText } = await import('../../src/pcsetup/java.mjs');
  assert.equal(`${j.javaHomeHint} ${j.javaHome}`, javaHomeText(j));
  assert.equal(j.javaHome, 'export JAVA_HOME="$HOME/android-studio/jbr"');
  assert.equal(extraChecks({ php: [], java: j }, 'linux').find((c) => c.id === 'java').fix, javaHomeText(j));
});

test('Windows: the new kits are not offered, and the page is told so in one line', async () => {
  const { call } = harness({ platform: 'win32', pm: 'winget' });
  const d = await call('GET', '/api/pcsetup/kits');
  assert.ok(!d.kits.some((k) => ['php', 'fvm', 'flutter', 'android'].includes(k.id)));
  assert.deepEqual(d.notCovered, ['PHP + database', 'Flutter versions (fvm)', 'Flutter', 'Android']);
  assert.match(d.java.text, /not looked for on Windows/);
});

test('POST setup and fix: only kits that exist; java, an unknown id or a project\'s name is refused before anything runs', async () => {
  const { call, runs } = harness();
  for (const kits of [['java'], ['php', 'java'], ['legacy'], ['php; rm -rf ~'], ['__proto__']]) await assert.rejects(call('POST', '/api/pcsetup/setup', { kits }), /kits must be/, JSON.stringify(kits));
  await assert.rejects(call('POST', '/api/pcsetup/fix', { id: 'php.note-0' }), /no fix/);
  await assert.rejects(call('POST', '/api/pcsetup/fix', { id: 'java' }), /no fix/);
  assert.deepEqual(runs, []);
  assert.deepEqual(await call('POST', '/api/pcsetup/setup', { kits: ['php'] }), { started: true });
  for (let i = 0; i < 50 && (await call('GET', '/api/pcsetup/job?from=0')).running; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(runs, [['php']]);
});

test('a fix runs exactly the commands its row shows; an optional kit\'s row runs nothing and sends the person to the sheet', async () => {
  // A made-up apt computer with nothing on it: the real checks, the real fix route and pc setup, a runner that records.
  const sys = { platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: process.env.HOME, env: { PATH: '/usr/bin' }, clt: true, dnf5: false,  // seal: simulated sys facts; which() is stubbed, no program is started
    has: (b) => ['sudo', 'apt-cache'].includes(b), exists: () => false, list: () => [], which: () => null, run: async () => ({ ok: false, code: 1, stdout: '', stderr: '' }) };
  const found = await detectKits(sys);
  const checks = kitChecks(found, sys, { suggested: [{ kit: 'php', reason: 'legacy has composer.json' }], php: [] });
  const ran = [];
  const stream = async (argv) => (ran.push(argv.filter((a, i) => !(argv[0] === 'sudo' && i <= 2 && ['-n', '--'].includes(a)))), { ok: true, code: 0, output: '' });
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [] }, deck: { launcher: () => ['node', 'hoprig'], terminal: async () => {} } };
  const f = pcsetupFeature(sctx, { computer: () => 'box2', sys, status: async () => checks, projectsDir: () => projects, sudoNeedsPassword: async () => false, stream, extras: { suggested: [], php: [], java: null } });
  const call = async (method, p, body) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) if (m === method && re.exec(u.pathname)) return fn(Object.assign(Readable.from([]), { body }), null, u.searchParams);
    throw new Error(`no route ${method} ${p}`);
  };
  const tmux = checks.find((c) => c.id === 'extras.tmux');
  assert.deepEqual(await call('POST', '/api/pcsetup/fix', { id: 'extras.tmux', confirm: 'box2' }), { started: true });
  for (let i = 0; i < 200 && (await call('GET', '/api/pcsetup/job?from=0')).running; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(ran.map(showCommand).join(' && '), tmux.fix);
  for (const id of ['php.php', 'php.composer', 'php.mariadb', 'docker.docker']) {
    const c = checks.find((x) => x.id === id);
    assert.deepEqual([c.fixKit, c.setupKit, c.fix], [undefined, id.split('.')[0], `hoprig pc setup --kits ${id.split('.')[0]}`], id);
    ran.length = 0;
    await assert.rejects(call('POST', '/api/pcsetup/fix', { id }), /is optional: choose it under "Set up this computer", where its commands are shown/, id);
    assert.deepEqual(ran, [], id);
  }
  assert.deepEqual(setupSummary(checks.filter((c) => c.setupKit)).fix, [], 'an optional kit is never "to fix"');
  // The suggestion is said once per kit (on its first row), not under each of PHP, Composer and MariaDB.
  assert.deepEqual(checks.filter((c) => c.group === 'kit:php').map((c) => /suggested: legacy has composer\.json/.test(c.detail)), [true, false, false]);
  // fvm without Flutter's dart: its plan installs nothing, so its row has no button, only what comes first.
  const fvm = checks.find((x) => x.id === 'fvm.fvm');
  assert.deepEqual([fvm.fixKit, fvm.setupKit, fvm.fix], [undefined, undefined, ''], 'no command line under it (seen in a browser: the sentence was set as code, beside the same reason)');
  assert.equal(fvm.detail, 'not installed (optional): Install Flutter first; fvm comes with Flutter\'s dart command.');
  await assert.rejects(call('POST', '/api/pcsetup/fix', { id: 'fvm.fvm' }), /no fix/);
  assert.equal(setupSummary([fvm]).optional.length, 1, 'it stays with the optional ones (as a note), not among what is fine');
});

test('no package manager: a default kit\'s missing git stays among the things to fix, with its reason and no button', async () => {
  const sys = { platform: 'linux', pm: null, root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: process.env.HOME, env: { PATH: '/usr/bin' }, clt: true, dnf5: false,  // seal: simulated sys facts; which() is stubbed, no program is started
    has: (b) => b === 'sudo', exists: () => false, list: () => [], which: () => null, run: async () => ({ ok: false, code: 127, stdout: '', stderr: '' }) };
  const checks = kitChecks(await detectKits(sys, ['basics', 'python', 'github', 'extras']), sys, null);
  const git = checks.find((c) => c.id === 'basics.git');
  assert.deepEqual([git.status, git.note, git.fixKit, git.setupKit, git.fix], ['fail', undefined, undefined, undefined, ''], 'nothing to run, so no button and no command line');
  assert.equal(git.detail, 'Hoprig has no way to install it on this computer.');
  const s = setupSummary(checks);
  for (const id of ['basics.git', 'basics.curl', 'python.python', 'github.gh', 'extras.tmux']) assert.ok(s.fix.some((c) => c.id === id), `${id} is to fix`);
  assert.deepEqual(s.optional.filter((c) => c.group !== 'kit:github' || c.note).map((c) => c.id), [], 'no default item is filed as an optional note');
  assert.notEqual(setupSummary(checks.filter((c) => c.group === 'kit:basics')).text, 'Everything needed is installed');
});

test('the page\'s summary: a PHP note or the Java line is never "to fix"; status lines say the same words', () => {
  const notes = extraChecks({ php: [{ project: 'legacy', where: '', verdict: 'newer', text: 'legacy asks for PHP ^8.1 <8.4 …', offer: null }], java: { state: 'missing', text: 'No Java found.', broken: [], javaHome: null } }, 'linux');
  assert.deepEqual(notes.map((c) => [c.group, c.label, c.status]), [['kit:php', 'PHP for legacy', 'warn'], ['java', 'Java', 'info']]);
  // No PHP yet, and the one the kit would install does not fit: '!' here as in pc setup, not '·'.
  const offered = extraChecks({ php: [{ project: 'shop', where: '', verdict: 'newer', text: 'shop asks for PHP ^8.1 <8.4 in its composer.json. There is no PHP here yet; the PHP kit would install PHP 8.5, which is newer than that.', offer: null }, { project: 'blog', where: '', verdict: 'unknown', text: 'x', offer: null }], java: null }, 'linux');
  assert.deepEqual(offered.map((c) => c.status), ['warn', 'info']);
  const s = setupSummary(notes);
  assert.equal(s.fix.length, 0);
  assert.equal(s.optional.length, 2);
  assert.equal(s.offers.length, 0, 'a note is shown with the optional ones but not counted as an extra to want');
  assert.equal(setupSummary([...notes, { group: 'kit:docker', id: 'docker.docker', label: 'Docker', status: 'info', detail: '', setupKit: 'docker' }]).offers.length, 1);
  assert.equal(s.text, 'Everything needed is installed');
  const win = extraChecks({ php: [], java: null }, 'win32');
  assert.deepEqual(win.map((c) => c.detail), ['PHP + database, Flutter versions (fvm), Flutter and Android: not covered on Windows (Hoprig does not set them up there)']);
});

test('the sheet keeps the Java line\'s height: in its flex column a .rows list would shrink to nothing (seen in a browser)', () => {
  const css = fs.readFileSync(new URL('../../web/page-setupjob.css', import.meta.url), 'utf8');
  assert.match(css, /\.sj-java\s*\{\s*flex:\s*none;\s*\}/);
  assert.match(fs.readFileSync(new URL('../../web/pcsetup.js', import.meta.url), 'utf8'), /h\('div\.rows\.sj-java'/);
});

test('MariaDB\'s sentence only when the plan installs MariaDB: held for a MySQL client or already here, the sheet and the end of pc setup say nothing of it', async () => {
  const answer = (map) => async (argv) => (map[argv.join(' ')] ? { ok: true, code: 0, stdout: map[argv.join(' ')], stderr: '' } : { ok: false, code: 127, stdout: '', stderr: '' });
  const mysql = { 'mysql --version': 'mysql  Ver 8.4.13 for Linux on x86_64 (MySQL Community Server - GPL)' };
  const cases = {
    'apt, MySQL client': { pm: 'apt', has: (b) => ['sudo', 'mysql'].includes(b), run: answer(mysql) },
    'dnf, MySQL client': { pm: 'dnf', has: (b) => ['sudo', 'mysql'].includes(b), run: answer(mysql) },
    'dnf, MariaDB here': { pm: 'dnf', has: (b) => b === 'sudo', exists: (f) => f === '/usr/sbin/mariadbd', run: answer({}) },
  };
  for (const [name, over] of Object.entries(cases)) {
    const { call } = harness(over);
    const php = (await call('GET', '/api/pcsetup/kits')).kits.find((k) => k.id === 'php');
    assert.ok(php.commands.length && !php.commands.join(' ').includes('mariadb'), `${name}: PHP and Composer are planned, MariaDB is not`);
    assert.deepEqual([php.after, php.start], [null, []], `${name}: nothing about MariaDB starting`);
    const sys = { platform: 'linux', root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: process.env.HOME, env: { PATH: '/usr/bin' }, clt: true, dnf5: false, exists: () => false, list: () => [], which: () => null, ...over };  // seal: simulated sys facts; which() is stubbed, no program is started
    const out = [];
    const ui = makeUi({ yes: true, interactive: false, write: (x) => out.push(x), askLine: async () => '' });
    await runPcSetup({ ui, kits: ['php'], sys, runner: async () => ({ ok: true, code: 0, output: '' }), extras: { suggested: [], php: [], java: null } });
    const text = out.join('');
    assert.match(text, /\nDone/, name);
    assert.doesNotMatch(text.slice(text.indexOf('\nDone')), /MariaDB is a|systemctl/, `${name}: the end of the run does not speak of starting MariaDB`);
  }
  // Planned: the sentence is there (apt starts it itself; dnf leads into the start command).
  const apt = (await harness({ pm: 'apt', has: (b) => b === 'sudo', run: answer({}) }).call('GET', '/api/pcsetup/kits')).kits.find((k) => k.id === 'php');
  assert.match(apt.after, /^MariaDB is a service: it starts now and with the computer/);
});

test('a Java that works beside a JAVA_HOME that does not: a warning note, so the Setup tab and pc status show its line', async () => {
  const { extraChecks: checksOf } = await import('../../src/pcsetup/status.mjs');
  const { formatResults } = await import('../../src/setup/doctor.mjs');
  const { findJava, javaHomeText: lineOf } = await import('../../src/pcsetup/java.mjs');
  const run = async (argv) => (argv[0] === '/home/dev/bin/java' ? { ok: true, stdout: '', stderr: 'openjdk version "21.0.6"' } : { ok: false, stdout: '', stderr: '' });
  const sys = { platform: 'linux', home: '/home/dev', env: { JAVA_HOME: '/home/dev/old-jdk' }, has: (b) => b === 'java', which: () => '/home/dev/bin/java', run, exists: () => false, list: () => [], realpath: () => null };
  const j = await findJava(sys);
  assert.equal(j.staleJavaHome, true);
  const c = checksOf({ php: [], java: j }, 'linux').find((x) => x.id === 'java');
  assert.deepEqual([c.status, c.note], ['warn', true], 'shown with the line, never counted as something to fix');
  // The sentence is in the row's words (the page draws a fix as a command to type); there is no line to put here.
  assert.equal(c.detail, 'Java 21.0.6, found on your PATH (~/bin/java) Found but not working: ~/old-jdk (that folder is not there). Your JAVA_HOME points at a Java that does not work: remove your JAVA_HOME line from ~/.bashrc (or ~/.zshrc if you use zsh), then open a new terminal (the Java on your PATH is then used).');
  assert.equal(c.fix, '');
  assert.match(formatResults([c]), /remove your JAVA_HOME line from ~\/\.bashrc/, 'pc status prints it');
  assert.equal(lineOf(j), j.javaHomeHint);
  // A replace line: the sentence in the words, the export line alone as the command.
  const rep = { ...j, javaHome: 'export JAVA_HOME="/usr/lib/jvm/java-21"', javaHomeHint: 'Your JAVA_HOME points at a Java that does not work: replace your JAVA_HOME line in ~/.bashrc (or ~/.zshrc if you use zsh) with this one, then open a new terminal:' };
  const cr = checksOf({ php: [], java: rep }, 'linux').find((x) => x.id === 'java');
  assert.equal(cr.fix, 'export JAVA_HOME="/usr/lib/jvm/java-21"');
  assert.match(cr.detail, /replace your JAVA_HOME line in ~\/\.bashrc .* with this one, then open a new terminal:$/);
  // Without JAVA_HOME the same Java is fine and needs no line.
  const fine = checksOf({ php: [], java: await findJava({ ...sys, env: {} }) }, 'linux').find((x) => x.id === 'java');
  assert.deepEqual([fine.status, fine.fix], ['ok', '']);
});

test('the kits route says, for Flutter: what it downloads and from which host, about how big, what it changes, what was found', async () => {
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const real = { ws, blockHas: () => false, has: (b) => ['tar', 'xz', 'sudo', 'curl', 'git', 'unzip', 'zip'].includes(b), exists: (f) => fs.existsSync(f) };
  const fresh = (await harness(real).call('GET', '/api/pcsetup/kits')).kits.find((k) => k.id === 'flutter');
  assert.equal(fresh.defaultOn, false);
  assert.deepEqual(fresh.downloads.map((d) => [d.host, d.checksum, d.text]), [['storage.googleapis.com', 'sha256', "Flutter's current stable release, from storage.googleapis.com over https (checked against its sha256)"]]);
  assert.equal(fresh.size.text, 'about 1.6 GB to download, about 3 GB on disk');
  assert.deepEqual(fresh.changes, [`a new folder ${ws}/development/flutter/flutter`, `these lines in the hoprig kits block of your shell start files: case ":$PATH:" in *":${ws}/development/flutter/flutter/bin:"*) ;; *) PATH="${ws}/development/flutter/flutter/bin:$PATH"; export PATH ;; esac  # flutter`]);
  assert.deepEqual(fresh.found, []);
  assert.deepEqual(fresh.yours.map((y) => y.command), [undefined], 'pacman: the packages are named, with no apt command');
  assert.match(fresh.yours[0].text, /libglu1-mesa/);
  // A Flutter in ~/flutter: found and shown with ~, used where it is; nothing is downloaded.
  const own = path.join(process.env.HOME, 'flutter');
  fs.mkdirSync(path.join(own, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(own, 'bin', 'flutter'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(own, 'version'), '3.41.2\n');
  try {
    const found = (await harness(real).call('GET', '/api/pcsetup/kits')).kits.find((k) => k.id === 'flutter');
    assert.deepEqual(found.found, [{ name: 'Flutter', where: '~/flutter', version: '3.41.2', text: 'found at ~/flutter: used where it is' }]);
    assert.deepEqual(found.downloads, []);
    assert.equal(found.size, null);
    assert.equal(found.changes[0], `${ws}/development/flutter/flutter becomes a link to ~/flutter (nothing of it is moved, copied or changed)`);
    assert.ok(!fs.existsSync(path.join(ws, 'development')), 'the route only looks: no link was made');
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
});
