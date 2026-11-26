// The optional kits of a computer's set-up: PHP + database and fvm (their plans per package manager, none and Windows;
// their detection on odd systems), Java that is only looked for, the suggestions from the projects here (never a
// tick), and Docker staying off. Plan-only: nothing here installs or runs anything; the system is an object.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectKits, preselect, sysFacts } from '../../src/pcsetup/detect.mjs';
import { findJava, javaHomeText, javaVersion } from '../../src/pcsetup/java.mjs';
import { KITS, buildPlan, kitById, mariadbStart } from '../../src/pcsetup/kits.mjs';
import { aptCandidate, diskReader, extraSteps, optionalExtras, phpNotes, phpOffers } from '../../src/pcsetup/optional.mjs';
import { leftOutText, projectsLeftOut, suggestKits } from '../../src/pcsetup/suggest.mjs';
import { extraChecks } from '../../src/pcsetup/status.mjs';
import { formatKits } from '../../src/pcsetup/setup.mjs';
import { recipeKits } from '../../src/pcsetup/cli.mjs';

const linux = (pm, over = {}) => ({ platform: 'linux', pm, root: false, user: 'dev', arch: 'x64', tmp: '/tmp', dnf5: false, has: () => false, ...over });
const missing = (ids) => Object.fromEntries(ids.map((id) => [id, kitById(id).items.map((i) => ({ id: i.id, state: 'missing' }))]));
const argvs = (plan) => plan.steps.map((s) => s.argv);

/** A made-up computer: `bins` on PATH (name → where), `out` maps "argv joined" → answer, `files`, `dirs` (dir → names). */
function fake({ platform = 'linux', pm = 'apt', bins = {}, out = {}, files = [], dirs = {}, env = {}, home = '/home/dev', links = {} } = {}) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.join(' '));
    const r = out[argv.join(' ')];
    return r ? { ok: (r.code ?? 0) === 0, code: r.code ?? 0, stdout: r.stdout || '', stderr: r.stderr || '' } : { ok: false, code: 127, stdout: '', stderr: 'not found' };
  };
  return { calls, sys: sysFacts({ platform, pm, env: { PATH: '/usr/bin', ...env }, has: (b) => b in bins, which: (b) => bins[b] || null, run, exists: (f) => files.includes(f), list: (d) => dirs[d] || [], realpath: (f) => links[f] || null, home, root: false, user: 'dev', clt: true, dnf5: false }) };  // seal: sysFacts input; has/which/run are stubbed, no program is started
}

test('PHP + database: one install per package manager, the names of each distribution; optional and off by default', () => {
  const want = {
    apt: [['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update'], ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'php-cli', 'composer', 'mariadb-server']],
    dnf: [['sudo', 'dnf', 'install', '-y', 'php-cli', 'composer', 'mariadb-server']],
    yum: [['sudo', 'yum', 'install', '-y', 'php-cli', 'composer', 'mariadb-server']],
    pacman: [['sudo', 'pacman', '-S', '--needed', '--noconfirm', 'php', 'composer', 'mariadb']],
    zypper: [['sudo', 'zypper', '--non-interactive', 'install', 'php8', 'php-composer2', 'mariadb']],
    apk: [['sudo', 'apk', 'add', 'php85', 'composer', 'mariadb', 'mariadb-client']],
  };
  for (const [pm, steps] of Object.entries(want)) {
    const plan = buildPlan(['php'], missing(['php']), linux(pm));
    assert.deepEqual(argvs(plan), steps, pm);
    assert.deepEqual(plan.cannot, [], pm);
  }
  const mac = buildPlan(['php'], missing(['php']), { platform: 'darwin', pm: 'brew', has: () => true });
  assert.deepEqual(argvs(mac), [['brew', 'install', 'php', 'composer', 'mariadb']]);
  const php = kitById('php');
  assert.equal(php.defaultOn, false);
  assert.deepEqual(php.items.map((i) => i.id), ['php', 'composer', 'mariadb'], 'no Redis, no nginx');
  // Nothing in any plan adds a package source, changes the php command or removes a package.
  for (const pm of ['apt', 'dnf', 'yum', 'pacman', 'zypper', 'apk']) {
    const text = JSON.stringify(argvs(buildPlan(['php', 'fvm'], missing(['php', 'fvm']), linux(pm, { has: (b) => b === 'dart' }))));
    assert.doesNotMatch(text, /add-apt-repository|ppa:|addrepo|config-manager|update-alternatives|remove|purge|tap|sources\.list/, pm);
  }
});

test('MariaDB\'s service: started by Debian\'s package itself; elsewhere the start commands are SHOWN, never in the plan', () => {
  assert.deepEqual(mariadbStart(linux('apt')), []);
  assert.deepEqual(mariadbStart(linux('dnf')), [['sudo', 'systemctl', 'enable', '--now', 'mariadb']]);
  assert.deepEqual(mariadbStart(linux('pacman')), [['sudo', 'mariadb-install-db', '--user=mysql', '--basedir=/usr', '--datadir=/var/lib/mysql'], ['sudo', 'systemctl', 'enable', '--now', 'mariadb']]);
  assert.deepEqual(mariadbStart(linux('zypper', { root: true })), [['systemctl', 'enable', '--now', 'mariadb']]);
  assert.deepEqual(mariadbStart({ platform: 'darwin', pm: 'brew' }), [['brew', 'services', 'start', 'mariadb']]);
  for (const pm of ['dnf', 'pacman', 'zypper', 'apk']) assert.ok(!JSON.stringify(argvs(buildPlan(['php'], missing(['php']), linux(pm)))).includes('systemctl') && !JSON.stringify(argvs(buildPlan(['php'], missing(['php']), linux(pm)))).includes('rc-service'), pm);
  assert.match(kitById('php').after(linux('apt')), /MariaDB is a service: it starts now and with the computer/);
  // Every place that says it (pc setup's list, its summary, the sheet) prints the commands right after it.
  assert.equal(kitById('php').after(linux('pacman')), 'MariaDB is a database that runs in the background. Hoprig does not start it; to start it now and with the computer, run:');
});

test('fvm: dart pub global activate fvm for the user; without dart, Flutter first and nothing installed; no tap', () => {
  const withDart = buildPlan(['fvm'], missing(['fvm']), linux('apt', { has: (b) => b === 'dart' }));
  assert.deepEqual(withDart.steps.map((s) => [s.argv, s.admin]), [[['dart', 'pub', 'global', 'activate', 'fvm'], false]]);
  const noDart = buildPlan(['fvm'], missing(['fvm']), linux('apt'));
  assert.deepEqual(noDart.steps, []);
  assert.equal(noDart.cannot[0].why, 'Install Flutter first; fvm comes with Flutter\'s dart command.');
  const mac = buildPlan(['fvm'], missing(['fvm']), { platform: 'darwin', pm: 'brew', has: () => false });
  assert.deepEqual(mac.steps, [], 'no Homebrew tap: a tap is a package source');
  assert.equal(kitById('fvm').defaultOn, false);
  assert.match(kitById('fvm').summary, /^Only for work on several Flutter versions at once/);
  assert.match(kitById('fvm').after, /~\/\.pub-cache\/bin/);
});

test('no package manager: PHP\'s items are "cannot"; Windows: the new kits are not covered and plan nothing', async () => {
  const none = buildPlan(['php'], missing(['php']), linux(null));
  assert.deepEqual(none.steps, []);
  assert.deepEqual(none.cannot.map((c) => c.item), ['php', 'composer', 'mariadb']);
  const win = { platform: 'win32', pm: 'winget', has: () => true };
  assert.deepEqual(buildPlan(['php', 'fvm'], missing(['php', 'fvm']), win), { steps: [], cannot: [], admin: false });
  const { sys, calls } = fake({ platform: 'win32', pm: 'winget', bins: { php: 'C:\\php\\php.exe', dart: 'x' } });
  const found = await detectKits(await sys, ['php', 'fvm']);
  assert.ok([...found.php, ...found.fvm].every((i) => i.state === 'na' && i.detail === 'not covered on Windows'));
  assert.deepEqual(calls, [], 'nothing is looked for on Windows');
  assert.match((await findJava(await sys)).text, /not looked for on Windows/);
});

test('PHP detection: php -v with extras, two PHPs (php counts, the others named), a php that does not run', async () => {
  const two = await fake({
    bins: { php: '/usr/bin/php', 'php8.3': '/usr/bin/php8.3', composer: '/usr/bin/composer' },
    dirs: { '/usr/bin': ['php', 'php8.3', 'php8.5', 'phpize', 'php-config'] },
    out: { 'php -v': { stdout: 'PHP 8.5.4-0ubuntu1.5 (cli) (built: Oct 1 2026)' }, 'php8.3 -v': { stdout: 'PHP 8.3.6 (cli)' }, 'php8.5 -v': { stdout: 'PHP 8.5.4 (cli)' }, 'composer --version --no-interaction': { stdout: 'Composer version 2.9.5 2026-01-01' } },
  }).sys;
  const f = (await detectKits(two, ['php'])).php;
  const php = f.find((i) => i.id === 'php');
  assert.equal(php.state, 'ok');
  assert.equal(php.version, '8.5.4');
  assert.equal(php.detail, 'also here: php8.5 (8.5.4), php8.3 (8.3.6)', 'newest first');
  assert.equal(f.find((i) => i.id === 'composer').version, '2.9.5');
  // A startup warning on stdout before the version line names a file with a version of its own: the PHP line counts.
  const warn = "PHP Warning:  Failed loading Zend extension 'ioncube_loader_lin_8.1.so' (tried: /usr/lib/php/20230831/ioncube_loader_lin_8.1.so) in Unknown on line 0\n";
  const warned = await fake({ bins: { php: '/usr/bin/php' }, dirs: { '/usr/bin': ['php', 'php8.2'] }, out: { 'php -v': { stdout: `${warn}PHP 8.3.6 (cli) (built: Oct 1 2026)` }, 'php8.2 -v': { stdout: `${warn}PHP 8.2.29 (cli)` } } }).sys;
  const w = (await detectKits(warned, ['php'])).php.find((i) => i.id === 'php');
  assert.equal(w.version, '8.3.6');
  assert.deepEqual(w.others, [{ name: 'php8.2', version: '8.2.29' }]);
  const broken = await fake({ bins: { php: '/usr/bin/php' }, out: { 'php -v': { code: 1, stderr: 'error while loading shared libraries: libxml2.so.2' } } }).sys;
  const b = (await detectKits(broken, ['php'])).php.find((i) => i.id === 'php');
  assert.equal(b.state, 'missing');
  assert.match(b.detail, /^php is there but did not run: error while loading shared libraries/);
});

test('many PHP series (an extra archive has 13): sorted by version, newest first, none cut that fits; nothing offered twice', async () => {
  const ser = ['5.6', '7.0', '7.1', '7.2', '7.3', '7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5', '8.6', '10.0'];
  const out = { 'php -v': { stdout: 'PHP 8.6.0 (cli)' }, 'apt-cache policy php-cli': { stdout: '  Candidate: 8.6.0-1\n' }, 'apt-cache pkgnames php': { stdout: ser.map((v) => `php${v}-cli`).join('\n') } };
  for (const v of ser) Object.assign(out, { [`php${v} -v`]: { stdout: `PHP ${v}.1 (cli)` }, [`apt-cache policy php${v}-cli`]: { stdout: `  Candidate: ${v}.1-1\n` } });
  const sys = await fake({ bins: { php: '/usr/bin/php', 'apt-cache': '/usr/bin/apt-cache' }, dirs: { '/usr/bin': ['php', ...ser.map((v) => `php${v}`)] }, out }).sys;
  const php = (await detectKits(sys, ['php'])).php.find((i) => i.id === 'php');
  assert.deepEqual(php.others.map((o) => o.name), ['php10.0', 'php8.6', 'php8.5', 'php8.4', 'php8.3', 'php8.2', 'php8.1', 'php8.0', 'php7.4', 'php7.3', 'php7.2', 'php7.1', 'php7.0', 'php5.6']);
  assert.deepEqual((await phpOffers(sys)).series.map((x) => x.series), ['10.0', '8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4', '7.3', '7.2', '7.1', '7.0', '5.6']);
  const r = treeReader({ 'shop/composer.json': '{"require":{"php":"~8.4.0"}}' });
  const [note] = await phpNotes(sys, '/p', { reader: r, php });
  assert.equal(note.use, 'php8.4', 'the php8.4 that is here and fits is named');
  assert.equal(note.offer, null, 'nothing is offered to install that is here already');
});

test('the database: MySQL already there (its server only in /usr/sbin) counts, so MariaDB is never put beside it; a client alone does not', async () => {
  const mysql = await fake({ files: ['/usr/sbin/mysqld'] }).sys;
  const db = (await detectKits(mysql, ['php'])).php.find((i) => i.id === 'mariadb');
  assert.equal(db.state, 'ok');
  assert.equal(db.version, null, 'a server found by its full path is not started, so its version is not asked');
  assert.match(db.detail, /a MySQL server here \(\/usr\/sbin\/mysqld\): it counts as the database, so MariaDB is not installed beside it/);
  const plan = buildPlan(['php'], { php: [{ id: 'php', state: 'missing' }, { id: 'composer', state: 'missing' }, db] }, linux('apt'));
  assert.ok(!JSON.stringify(argvs(plan)).includes('mariadb-server'));
  const maria = await fake({ bins: { mariadbd: '/usr/bin/mariadbd' }, out: { 'mariadbd --version': { stdout: 'mariadbd  Ver 11.8.6-MariaDB-5ubuntu0.1 for debian-linux-gnu' } } }).sys;
  assert.deepEqual((await detectKits(maria, ['php'])).php.find((i) => i.id === 'mariadb').version, '11.8.6');
  // MySQL's client alone: apt would REMOVE it for MariaDB's (mariadb-client-core conflicts with it; -y does not ask), so
  // the server is not planned; it is said, with the command for the person to run where the package manager asks.
  for (const pm of ['apt', 'dnf', 'pacman', 'zypper']) {
    const client = await fake({ pm, bins: { mysql: '/usr/bin/mysql' }, out: { 'mysql --version': { stdout: 'mysql  Ver 8.4.13 for Linux on x86_64 (MySQL Community Server - GPL)' } } }).sys;
    const f = await detectKits(client, ['php']);
    const c = f.php.find((i) => i.id === 'mariadb');
    assert.equal(c.state, 'missing');
    assert.equal(c.detail, 'only a MySQL client (mysql 8.4.13) is here, no server');
    const p = buildPlan(['php'], f, linux(pm));
    assert.doesNotMatch(JSON.stringify(argvs(p)), /mariadb/, pm);
    assert.deepEqual(p.cannot.map((x) => x.item), ['mariadb'], pm);
    assert.match(p.cannot[0].why, /^left out: installing MariaDB's server would replace the MySQL client that is here \(mysql 8\.4\.13\)\. To install it anyway, run it yourself/);
    if (pm === 'apt') assert.match(p.cannot[0].why, /: sudo apt-get install mariadb-server$/);
    assert.doesNotMatch(p.cannot[0].why, / -y | --noconfirm | --non-interactive /, `${pm}: the command shown asks first`);
  }
  // Homebrew (mysql-client is keg-only) and Alpine (no MySQL package of its own) do not remove such a client, and
  // `brew install` and `apk add` do not ask: MariaDB is not held there, and no text promises a question.
  for (const [pm, platform, cmd] of [['brew', 'darwin', ['brew', 'install']], ['apk', 'linux', ['sudo', 'apk', 'add']]]) {
    const client = await fake({ pm, platform, bins: { mysql: '/usr/local/bin/mysql' }, out: { 'mysql --version': { stdout: 'mysql  Ver 9.1.0 for macos14 on arm64 (Homebrew)' } } }).sys;
    const f = await detectKits(client, ['php']);
    const c = f.php.find((i) => i.id === 'mariadb');
    assert.deepEqual([c.state, c.hold, c.detail], ['missing', undefined, 'only a MySQL client (mysql 9.1.0) is here, no server'], pm);
    const p = buildPlan(['php'], f, platform === 'darwin' ? { platform, pm, has: () => true } : linux(pm));
    assert.ok(argvs(p).some((a) => cmd.every((w, i) => a[i] === w) && a.includes('mariadb')), `${pm}: MariaDB is planned: ${JSON.stringify(argvs(p))}`);
    assert.deepEqual(p.cannot, [], pm);
  }
  // MariaDB's own client alone: its server goes beside it.
  const own = await fake({ bins: { mariadb: '/usr/bin/mariadb' }, out: { 'mariadb --version': { stdout: 'mariadb from 11.8.6-MariaDB, client 15.2 for debian-linux-gnu' } } }).sys;
  const of = await detectKits(own, ['php']);
  assert.equal(of.php.find((i) => i.id === 'mariadb').detail, "only MariaDB's client (mariadb) is here, no server");
  assert.match(JSON.stringify(argvs(buildPlan(['php'], of, linux('apt')))), /mariadb-server/);
  const silent = await fake({ files: ['/usr/sbin/mariadbd'] }).sys;
  assert.equal((await detectKits(silent, ['php'])).php.find((i) => i.id === 'mariadb').state, 'ok', 'a server that does not say its version is still there');
});

test('the database: a server found only by its full path is not started, and counts; one on PATH is asked by its name', async () => {
  // Ubuntu with MySQL's server in /usr/sbin (not on PATH): a status starts no program of the computer by a full path.
  const mysql = fake({ files: ['/usr/sbin/mysqld'], out: { '/usr/sbin/mysqld --version': { stdout: '/usr/sbin/mysqld  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)' } } });
  const db = (await detectKits(await mysql.sys, ['php'])).php.find((i) => i.id === 'mariadb');
  assert.deepEqual(mysql.calls.filter((c) => c.startsWith('/')), [], 'nothing is started by a full path');
  assert.deepEqual([db.state, db.version], ['ok', null]);
  assert.equal(db.detail, 'a MySQL server here (/usr/sbin/mysqld): it counts as the database, so MariaDB is not installed beside it');
  assert.ok(!JSON.stringify(argvs(buildPlan(['php'], { php: [{ id: 'php', state: 'missing' }, { id: 'composer', state: 'missing' }, db] }, linux('apt')))).includes('mariadb-server'));
  // MariaDB's server (Debian also puts a mysqld beside it, as a link to it): MariaDB's.
  for (const files of [['/usr/sbin/mariadbd'], ['/usr/sbin/mariadbd', '/usr/sbin/mysqld'], ['/usr/libexec/mariadbd']]) {
    const maria = fake({ pm: 'dnf', files });
    const m = (await detectKits(await maria.sys, ['php'])).php.find((i) => i.id === 'mariadb');
    assert.deepEqual(maria.calls.filter((c) => c.startsWith('/')), [], files.join(' '));
    assert.deepEqual([m.state, m.version, m.detail], ['ok', null, `MariaDB server here (${files[0]})`]);
  }
  // On PATH by its name: asked its version by that name.
  const named = fake({ bins: { mysqld: '/usr/bin/mysqld' }, files: ['/usr/sbin/mysqld'], out: { 'mysqld --version': { stdout: 'mysqld  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)' } } });
  const n = (await detectKits(await named.sys, ['php'])).php.find((i) => i.id === 'mariadb');
  assert.ok(named.calls.includes('mysqld --version'), JSON.stringify(named.calls));
  assert.deepEqual(named.calls.filter((c) => c.startsWith('/')), []);
  assert.deepEqual([n.state, n.version, n.detail], ['ok', '8.4.3', 'a MySQL server: it counts as the database, so MariaDB is not installed beside it']);
});

test('fvm detection: on PATH, in ~/.pub-cache/bin but not on PATH, missing without dart', async () => {
  const on = await fake({ bins: { fvm: '/x/fvm' }, out: { 'fvm --version': { stdout: '3.2.1' } } }).sys;
  assert.deepEqual((await detectKits(on, ['fvm'])).fvm.map((i) => [i.state, i.version, i.detail]), [['ok', '3.2.1', '']]);
  const cache = await fake({ files: ['/home/dev/.pub-cache/bin/fvm'], out: { '/home/dev/.pub-cache/bin/fvm --version': { stdout: '3.2.1' } } }).sys;
  assert.deepEqual((await detectKits(cache, ['fvm'])).fvm[0].detail, 'in ~/.pub-cache/bin, which is not on your PATH yet');
  const none = await fake({}).sys;
  assert.deepEqual((await detectKits(none, ['fvm'])).fvm[0].detail, 'needs Flutter first (its dart command installs fvm)');
});

const JAVA = (v) => ({ stderr: `openjdk version "${v}" 2026-07-15\nOpenJDK Runtime Environment (build ${v}+7)\n` });

test('Java, in order: JAVA_HOME, PATH, Android Studio\'s jbr in each place, a system JDK; the first that runs counts', async () => {  // seal: a test title, not a PATH value
  assert.equal(javaVersion('openjdk version "25.0.4" 2026-07-15'), '25.0.4');
  assert.equal(javaVersion('java version "1.8.0_402"'), '1.8.0_402');
  const jh = await fake({ env: { JAVA_HOME: '/opt/jdk-21' }, files: ['/opt/jdk-21/bin/java'], bins: { java: '/usr/bin/java' }, out: { '/opt/jdk-21/bin/java -version': JAVA('21.0.5'), '/usr/bin/java -version': JAVA('25.0.1') } }).sys;
  assert.deepEqual(await findJava(jh), { state: 'ok', version: '21.0.5', place: '/opt/jdk-21', from: 'JAVA_HOME', broken: [], javaHome: null, javaHomeHint: null, staleJavaHome: false, text: 'Java 21.0.5, found through JAVA_HOME (/opt/jdk-21)' });
  const onPath = await fake({ bins: { java: '/usr/bin/java' }, out: { '/usr/bin/java -version': JAVA('25.0.1') } }).sys;
  assert.equal((await findJava(onPath)).text, 'Java 25.0.1, found on your PATH (/usr/bin/java)');
  // Each Android Studio place on Linux, alone.
  const places = {
    '/home/dev/android-studio/jbr': '~/android-studio/jbr',
    '/opt/android-studio/jbr': '/opt/android-studio/jbr',
    '/snap/android-studio/current/jbr': '/snap/android-studio/current/jbr',
    '/home/dev/.local/share/JetBrains/Toolbox/apps/android-studio/jbr': '~/.local/share/JetBrains/Toolbox/apps/android-studio/jbr',
    '/data/tools/android-studio/jbr': '/data/tools/android-studio/jbr',
  };
  for (const [jbr, shown] of Object.entries(places)) {
    const sys = await fake({ env: { ANDROID_HOME: '/data/tools/Sdk' }, files: [`${jbr}/bin/java`], dirs: { '/home/dev/.local/share/JetBrains/Toolbox/apps': ['android-studio'] }, out: { [`${jbr}/bin/java -version`]: JAVA('25.0.4') } }).sys;
    const j = await findJava(sys);
    assert.equal(j.text, `Java 25.0.4, found in Android Studio (${shown})`, jbr);
    assert.equal(j.javaHome, `export JAVA_HOME="${jbr.replace(/^\/home\/dev\//, '$HOME/')}"`, 'the line to add is shown, never written; the home as $HOME');
    assert.equal(j.javaHomeHint, 'Only if a build says JAVA_HOME is not set: add this line to ~/.bashrc (or ~/.zshrc if you use zsh), then open a new terminal:');
  }
  // The older Toolbox layout: AndroidStudio/ch-<n>/<build>/jbr, the newest build first.
  const tb = '/home/dev/.local/share/JetBrains/Toolbox/apps';
  const older = await fake({ dirs: { [tb]: ['AndroidStudio'], [`${tb}/AndroidStudio`]: ['ch-0'], [`${tb}/AndroidStudio/ch-0`]: ['243.1', '251.10', '251.9', '251.9.plugins'] }, files: [`${tb}/AndroidStudio/ch-0/243.1/jbr/bin/java`, `${tb}/AndroidStudio/ch-0/251.10/jbr/bin/java`], out: { [`${tb}/AndroidStudio/ch-0/243.1/jbr/bin/java -version`]: JAVA('21.0.3'), [`${tb}/AndroidStudio/ch-0/251.10/jbr/bin/java -version`]: JAVA('21.0.6') } }).sys;
  assert.equal((await findJava(older)).text, 'Java 21.0.6, found in Android Studio (~/.local/share/JetBrains/Toolbox/apps/AndroidStudio/ch-0/251.10/jbr)');
  const jdk = await fake({ dirs: { '/usr/lib/jvm': ['default-java', 'java-21-openjdk-amd64', 'java-25-openjdk-amd64'] }, files: ['/usr/lib/jvm/java-25-openjdk-amd64/bin/java'], out: { '/usr/lib/jvm/java-25-openjdk-amd64/bin/java -version': JAVA('25.0.1') } }).sys;
  assert.equal((await findJava(jdk)).text, 'Java 25.0.1, found in a JDK of the system (/usr/lib/jvm/java-25-openjdk-amd64)');
});

test('Java that is found but does not run is named and the search goes on; none: "no Java found"; macOS paths', async () => {
  const sys = await fake({
    env: { JAVA_HOME: '/opt/gone' }, bins: { java: '/usr/bin/java' }, files: ['/home/dev/android-studio/jbr/bin/java', '/opt/android-studio/jbr/bin/java'],
    out: { '/usr/bin/java -version': { code: 1, stderr: 'broken link' }, '/home/dev/android-studio/jbr/bin/java -version': { stdout: '' }, '/opt/android-studio/jbr/bin/java -version': JAVA('21.0.6') },
  }).sys;
  const j = await findJava(sys);
  assert.equal(j.text, 'Java 21.0.6, found in Android Studio (/opt/android-studio/jbr)');
  assert.deepEqual(j.broken, [{ place: '/opt/gone', why: 'that folder is not there' }, { place: '/usr/bin/java', why: 'it did not run' }, { place: '~/android-studio/jbr', why: 'it did not say its version' }]);
  // JAVA_HOME names a folder that is not there; a working Java is found elsewhere: the line that replaces it is shown.
  assert.equal(j.javaHome, 'export JAVA_HOME="/opt/android-studio/jbr"');
  assert.equal(j.javaHomeHint, 'Your JAVA_HOME points at a Java that does not work: replace your JAVA_HOME line in ~/.bashrc (or ~/.zshrc if you use zsh) with this one, then open a new terminal:');
  // JAVA_HOME names a folder that is not there; the Java that works is on PATH: its link is followed to its home.
  const stale = { env: { JAVA_HOME: '/home/dev/old-jdk' }, bins: { java: '/usr/bin/java' }, out: { '/usr/bin/java -version': JAVA('21.0.6') } };
  const viaLink = await findJava(await fake({ ...stale, files: ['/usr/lib/jvm/java-21-openjdk-amd64/release'], links: { '/usr/bin/java': '/usr/lib/jvm/java-21-openjdk-amd64/bin/java' } }).sys);
  assert.equal(viaLink.text, 'Java 21.0.6, found on your PATH (/usr/bin/java)');
  assert.deepEqual(viaLink.broken, [{ place: '~/old-jdk', why: 'that folder is not there' }]);
  assert.equal(javaHomeText(viaLink), 'Your JAVA_HOME points at a Java that does not work: replace your JAVA_HOME line in ~/.bashrc (or ~/.zshrc if you use zsh) with this one, then open a new terminal: export JAVA_HOME="/usr/lib/jvm/java-21-openjdk-amd64"');
  // Its home cannot be told (no link; one that ends in /usr/bin; a wrapper in ~/bin, whose folder has no release file):
  // the line is to be removed, said once.
  for (const links of [{}, { '/usr/bin/java': '/usr/bin/java' }, { '/usr/bin/java': '/home/dev/bin/java' }]) {
    const j2 = await findJava(await fake({ ...stale, links }).sys);
    assert.equal(j2.javaHome, null);
    assert.equal(javaHomeText(j2), 'Your JAVA_HOME points at a Java that does not work: remove your JAVA_HOME line from ~/.bashrc (or ~/.zshrc if you use zsh), then open a new terminal (the Java on your PATH is then used).');
  }
  // No JAVA_HOME at all: a Java on PATH needs no line.
  assert.equal(javaHomeText(await findJava(await fake({ ...stale, env: {}, links: { '/usr/bin/java': '/usr/lib/jvm/java-21-openjdk-amd64/bin/java' } }).sys)), '');
  const noBin = await fake({ env: { JAVA_HOME: '/opt/jdk' }, files: ['/opt/jdk'] }).sys;
  const n = await findJava(noBin);
  assert.equal(n.state, 'missing');
  assert.equal(n.text, 'No working Java. Your JAVA_HOME (/opt/jdk) has no bin/java.');
  assert.deepEqual(n.broken, [{ place: '/opt/jdk', why: 'it has no bin/java' }]);
  assert.equal((await findJava(await fake({}).sys)).text, 'No Java found. Android Studio brings its own; Hoprig does not install Java.', 'nothing there at all');
  const macJbr = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  const mac = await fake({ platform: 'darwin', pm: 'brew', files: [`${macJbr}/bin/java`], out: { [`${macJbr}/bin/java -version`]: JAVA('21.0.6') }, home: '/Users/dev' }).sys;
  assert.equal((await findJava(mac)).text, `Java 21.0.6, found in Android Studio (${macJbr})`);
  const userApps = '/Users/dev/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  const mac2 = await fake({ platform: 'darwin', pm: 'brew', files: [`${userApps}/bin/java`], out: { [`${userApps}/bin/java -version`]: JAVA('21.0.6') }, home: '/Users/dev' }).sys;
  assert.equal((await findJava(mac2)).place, '~/Applications/Android Studio.app/Contents/jbr/Contents/Home');
  assert.equal((await findJava(mac2)).javaHomeHint, 'Only if a build says JAVA_HOME is not set: add this line to ~/.zshrc, then open a new terminal:');
  // Apple's /usr/bin/java stand-in on a Mac without a JDK: not run, not named as broken; with a JDK it is used.
  const stub = { '/usr/bin/java -version': { code: 1, stderr: 'The operation couldn’t be completed. Unable to locate a Java Runtime.' }, '/usr/libexec/java_home': { code: 1, stderr: 'Unable to locate a Java Runtime.' } };
  const bare = await fake({ platform: 'darwin', pm: 'brew', bins: { java: '/usr/bin/java' }, out: stub, home: '/Users/dev' });
  const bj = await findJava(await bare.sys);
  assert.deepEqual([bj.state, bj.broken], ['missing', []]);
  assert.ok(!bare.calls.includes('/usr/bin/java -version'), 'the stand-in is not run');
  const withJbr = await fake({ platform: 'darwin', pm: 'brew', bins: { java: '/usr/bin/java' }, files: [`${macJbr}/bin/java`], out: { ...stub, [`${macJbr}/bin/java -version`]: JAVA('21.0.6') }, home: '/Users/dev' }).sys;
  assert.deepEqual((await findJava(withJbr)).broken, [], 'no broken line beside the Java that was found');
  const jdkHere = await fake({ platform: 'darwin', pm: 'brew', bins: { java: '/usr/bin/java' }, out: { '/usr/libexec/java_home': { stdout: '/Library/Java/JavaVirtualMachines/temurin-25.jdk/Contents/Home\n' }, '/usr/bin/java -version': JAVA('25.0.1') }, home: '/Users/dev' }).sys;
  assert.equal((await findJava(jdkHere)).text, 'Java 25.0.1, found on your PATH (/usr/bin/java)');
  const macJdk = '/Library/Java/JavaVirtualMachines/temurin-25.jdk/Contents/Home';
  const mac3 = await fake({ platform: 'darwin', pm: 'brew', dirs: { '/Library/Java/JavaVirtualMachines': ['temurin-25.jdk'] }, files: [`${macJdk}/bin/java`], out: { [`${macJdk}/bin/java -version`]: JAVA('25.0.1') }, home: '/Users/dev' }).sys;
  assert.equal((await findJava(mac3)).from, 'a JDK of the system');
  assert.ok(!KITS.some((k) => k.id === 'java'), 'Java has no kit');
});

test('macOS, a stale JAVA_HOME: the line names the Java that was found (its link followed first); java_home only for Apple\'s stand-in', async () => {
  const brewHome = '/opt/homebrew/Cellar/openjdk/21.0.6/libexec/openjdk.jdk/Contents/Home';
  const temurin17 = '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home';
  const mac = (bins, links, files, out) => fake({ platform: 'darwin', pm: 'brew', home: '/Users/dev', env: { JAVA_HOME: '/Users/dev/old-jdk' }, bins, links, files, out });
  // Homebrew's Java 21 on PATH, while java_home would answer a Temurin 17: the line must not switch tools to 17.
  const brew = await mac({ java: '/opt/homebrew/bin/java' }, { '/opt/homebrew/bin/java': `${brewHome}/bin/java` }, [`${brewHome}/release`],
    { '/opt/homebrew/bin/java -version': JAVA('21.0.6'), '/usr/libexec/java_home': { stdout: `${temurin17}\n` } });
  const j = await findJava(await brew.sys);
  assert.equal(j.text, 'Java 21.0.6, found on your PATH (/opt/homebrew/bin/java)');
  assert.equal(j.javaHome, `export JAVA_HOME="${brewHome}"`);
  assert.ok(!brew.calls.includes('/usr/libexec/java_home'), 'java_home is not asked about a java that is a link to a JDK');
  // Apple's /usr/bin/java is no link: it runs the JDK java_home names, so java_home names its home.
  const temurin25 = '/Library/Java/JavaVirtualMachines/temurin-25.jdk/Contents/Home';
  const apple = await mac({ java: '/usr/bin/java' }, {}, [], { '/usr/bin/java -version': JAVA('25.0.1'), '/usr/libexec/java_home': { stdout: `${temurin25}\n` } });
  assert.equal((await findJava(await apple.sys)).javaHome, `export JAVA_HOME="${temurin25}"`);
  // A wrapper in ~/bin on a Mac: neither a Java home nor Apple's stand-in, so java_home is not asked and the line is to go.
  const wrap = await mac({ java: '/Users/dev/bin/java' }, {}, [], { '/Users/dev/bin/java -version': JAVA('21.0.6'), '/usr/libexec/java_home': { stdout: `${temurin17}\n` } });
  const w = await findJava(await wrap.sys);
  assert.equal(w.javaHome, null);
  assert.match(javaHomeText(w), /^Your JAVA_HOME points at a Java that does not work: remove your JAVA_HOME line from ~\/\.zshrc/);
});

/** A reader over a made-up tree: { 'shop/composer.json': text, … } under /p. */
function treeReader(files, links = {}) {
  const all = Object.keys(files).map((f) => `/p/${f}`);
  const dirs = new Set(['/p']);
  for (const f of all) for (let d = path.posix.dirname(f); d !== '/'; d = path.posix.dirname(d)) dirs.add(d);
  // The product joins '/p' with the system's own path: on Windows that gives \p\shop, the same place as /p/shop here.
  const slash = (p) => String(p).split(path.sep).join('/');
  return {
    list: (d) => { const dir = slash(d); return [...new Set([...all, ...dirs].filter((p) => path.posix.dirname(p) === dir && p !== dir).map((p) => path.posix.basename(p)))]; },
    kind: (q) => { const p = slash(q); return links[p] ? 'none' : all.includes(p) ? 'file' : dirs.has(p) ? 'dir' : 'none'; },
    read: (q) => { const p = slash(q); return all.includes(p) ? files[p.slice(3)] : null; },
  };
}

test('suggestions: each reason, a whole word in any case, a code repository; never a word inside another', () => {
  const r = treeReader({
    'shop/composer.json': '{}', 'blog/artisan': '', 'site/AGENTS.md': 'Runs on mariadb and nginx.', 'tool/project.json': '{"note":"MySQL 8"}',
    'app/.fvmrc': '{"flutter":"3.24.0"}', 'pinned/.fvm/fvm_config.json': '{}', 'mobile/pubspec.yaml': 'name: mobile\n',
    'box/Dockerfile': '', 'stack/compose.yaml': '', 'old/docker-compose.yml': '',
    'words/AGENTS.md': 'graphql and phpunit-free; mysqlish; PHPStorm', 'group/code/group-api/composer.json': '{}', 'group/AGENTS.md': '# group\n',
  });
  assert.deepEqual(suggestKits('/p', r), [
    { kit: 'php', project: 'blog', reason: 'blog has artisan' },
    { kit: 'docker', project: 'box', reason: 'box has Dockerfile' },
    { kit: 'php', project: 'group', reason: 'group (code/group-api) has composer.json' },
    { kit: 'docker', project: 'old', reason: 'old has docker-compose.yml' },
    { kit: 'fvm', project: 'app', reason: 'app has .fvmrc' }, // sorted by project name within the loop: app comes first
    { kit: 'fvm', project: 'pinned', reason: 'pinned has .fvm/fvm_config.json' },
    { kit: 'php', project: 'shop', reason: 'shop has composer.json' },
    { kit: 'php', project: 'site', reason: 'site\'s AGENTS.md names MariaDB' },
    { kit: 'docker', project: 'stack', reason: 'stack has compose.yaml' },
    { kit: 'php', project: 'tool', reason: 'tool\'s project.json names MySQL' },
  ].sort((a, b) => a.project.localeCompare(b.project) || Object.keys({ php: 0, fvm: 1, docker: 2 }).indexOf(a.kit) - Object.keys({ php: 0, fvm: 1, docker: 2 }).indexOf(b.kit)));
  assert.ok(!suggestKits('/p', r).some((s) => ['words', 'mobile'].includes(s.project)), 'PHPStorm, mysqlish and a Flutter project without a pin suggest nothing');
});

test('suggestions on the disk: a link out of the projects folder and a loop of links are not followed; 500 projects stay quick', (tc) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-')));
  tc.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(outside, 'evil'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'evil', 'composer.json'), '{}');
  fs.mkdirSync(path.join(projects, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'shop', 'composer.json'), '{"require":{"php":"^8.1 <8.4"}}');
  fs.symlinkSync(path.join(outside, 'evil'), path.join(projects, 'linked'));
  fs.mkdirSync(path.join(projects, 'loop'));
  fs.symlinkSync(path.join(projects, 'loop', 'b'), path.join(projects, 'loop', 'a'));
  fs.symlinkSync(path.join(projects, 'loop', 'a'), path.join(projects, 'loop', 'b'));
  fs.symlinkSync(path.join(outside, 'evil', 'composer.json'), path.join(projects, 'loop', 'composer.json'));
  assert.deepEqual(suggestKits(projects, diskReader(projects)), [{ kit: 'php', project: 'shop', reason: 'shop has composer.json' }]);
  for (let i = 0; i < 500; i++) fs.mkdirSync(path.join(projects, `p${String(i).padStart(3, '0')}`, 'code', 'web'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'p001', 'Dockerfile'), '');
  const t0 = Date.now();
  const many = suggestKits(projects, diskReader(projects));
  assert.ok(Date.now() - t0 < 5000, `500 projects took ${Date.now() - t0} ms`);
  assert.ok(many.some((s) => s.project === 'p001' && s.kit === 'docker'));
  assert.ok(!many.some((s) => s.project === 'p499'), 'past the cap of projects nothing is read');
  // ... and that is said: shop, loop and p000 … p499 are 502 projects (the link out is none), 202 past the cap.
  assert.equal(projectsLeftOut(projects, diskReader(projects)), 202);
  assert.equal(projectsLeftOut('/p', treeReader({ 'shop/composer.json': '{}' })), 0);
  const text = 'Only the first 300 projects (by name) were read for suggestions and PHP versions: 202 more were not.';
  assert.equal(leftOutText(202), text);
  assert.ok(extraChecks({ php: [], java: null, leftOut: 202 }, 'linux').some((c) => c.detail === text && c.note), 'pc status and the Setup tab');
  assert.match(formatKits({}, [], { suggested: [], php: [], java: null, leftOut: 202 }), new RegExp(text.replace(/[().]/g, '\\$&')), 'pc setup');
});

test('Java is looked for only when a project here needs it: a Gradle or Maven file at its top or in its android folder', async () => {
  const sys = linux('apt');
  const asked = [];
  const facts = { ...sys, env: {}, home: '/home/dev', exists: (f) => f === '/usr/lib/jvm/jdk-21/bin/java', list: (d) => (d === '/usr/lib/jvm' ? ['jdk-21'] : []), has: () => false,
    run: async (argv) => { asked.push(argv.join(' ')); return argv[0] === '/usr/lib/jvm/jdk-21/bin/java' ? { ok: true, stdout: '', stderr: 'openjdk version "21.0.6"' } : { ok: false, stdout: '', stderr: '' }; } };
  const none = await optionalExtras(facts, '/p', {}, { reader: treeReader({ 'shop/package.json': '{}', 'site/composer.json': '{}' }) });
  assert.equal(none.java, null, 'no project needs Java: nothing is said about it');
  assert.ok(!asked.some((a) => a.includes('java')), 'and no Java is started');
  for (const file of ['app/android/build.gradle', 'app/android/build.gradle.kts', 'lib/pom.xml', 'tool/gradlew', 'tool/settings.gradle.kts']) {
    const ex = await optionalExtras(facts, '/p', {}, { reader: treeReader({ 'shop/package.json': '{}', [file]: '' }) });
    assert.equal(ex.java && ex.java.state, 'ok', file);
    assert.equal(ex.java.text, 'Java 21.0.6, found in a JDK of the system (/usr/lib/jvm/jdk-21)', file);
  }
});

test('a suggestion never ticks a kit; a complete kit is not suggested; Docker stays off by default', async () => {
  const sys = linux('apt');
  const found = { ...missing(['php', 'fvm', 'docker']), basics: [{ id: 'git', state: 'ok' }] };
  assert.deepEqual(preselect(found), [], 'only default kits are taken without --kits');
  assert.equal(kitById('docker').defaultOn, false);
  const r = treeReader({ 'shop/composer.json': '{"require":{"php":">=8.1"}}', 'box/Dockerfile': '', 'app/.fvmrc': '{}' });
  const ex = await optionalExtras({ ...sys, run: async () => ({ ok: false }), env: {}, home: '/home/dev', exists: () => false }, '/p', found, { reader: r });
  assert.deepEqual(ex.suggested.map((s) => s.kit).sort(), ['docker', 'fvm', 'php']);
  const done = { ...found, docker: [{ id: 'docker', state: 'ok' }] };
  assert.ok(!(await optionalExtras({ ...sys, run: async () => ({ ok: false }), env: {}, home: '/home/dev', exists: () => false }, '/p', done, { reader: r })).suggested.some((s) => s.kit === 'docker'));
});

test('what apt offers is read without root or network; another series becomes a step BESIDE the other PHP, only with the PHP kit', async () => {
  assert.equal(aptCandidate('php-cli:\n  Installed: (none)\n  Candidate: 2:8.5+99ubuntu1\n'), '8.5');
  assert.equal(aptCandidate('php8.3-cli:\n  Installed: (none)\n  Candidate: (none)\n'), null);
  const { sys, calls } = await fake({
    bins: { 'apt-cache': '/usr/bin/apt-cache' },
    out: {
      'apt-cache policy php-cli': { stdout: '  Candidate: 2:8.5+99ubuntu1\n' }, 'apt-cache pkgnames php': { stdout: 'php8.5-cli\nphp8.3-cli\nphp-cli\nphp8.3-fpm\n' },
      'apt-cache policy php8.3-cli': { stdout: '  Candidate: 8.3.6-0ubuntu0.24.04.1\n' }, 'apt-cache policy php8.5-cli': { stdout: '  Candidate: 8.5.0-1\n' },
    },
  });
  const s = await sys;
  const offers = await phpOffers(s);
  assert.deepEqual(offers, { default: '8.5', series: [{ series: '8.3', version: '8.3.6', argv: ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'php8.3-cli'], run: 'php8.3', takesOverIfNewer: true }] });
  assert.ok(calls.every((c) => c.startsWith('apt-cache ')), 'only apt-cache is asked');
  const extra = extraSteps({ php: [{ project: 'shop', offer: offers.series[0] }, { project: 'blog', offer: offers.series[0] }] });
  assert.equal(extra.php.length, 1, 'one install for two projects that need the same series');
  const found = { php: [{ id: 'php', state: 'ok' }, { id: 'composer', state: 'ok' }, { id: 'mariadb', state: 'ok' }], basics: [{ id: 'git', state: 'missing' }] };
  assert.deepEqual(argvs(buildPlan(['php'], found, linux('apt'), { extra })).at(-1), ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'php8.3-cli']);
  assert.ok(!JSON.stringify(argvs(buildPlan(['basics'], found, linux('apt'), { extra }))).includes('php8.3'), 'not without the PHP kit');
  // Without apt or brew: not known before it is installed.
  assert.deepEqual(await phpOffers(linux('pacman')), { default: null, series: [] });
});

test('no PHP yet: apt\'s php-cli is followed to the package it brings and its full version is compared; a series alone is not guessed', async () => {
  const out = {
    'apt-cache policy php-cli': { stdout: '  Candidate: 2:8.5+99ubuntu1\n' }, 'apt-cache pkgnames php': { stdout: 'php-cli\nphp8.5-cli\n' },
    'apt-cache depends php-cli': { stdout: 'php-cli\n  Depends: php8.5-cli\n' }, 'apt-cache policy php8.5-cli': { stdout: '  Candidate: 8.5.4-0ubuntu1.5\n' },
  };
  const r = treeReader({ 'shop/composer.json': '{"require":{"php":"^8.5.1"}}', 'legacy/composer.json': '{"require":{"php":"<8.5.3"}}' });
  const verdicts = async (o) => Object.fromEntries((await phpNotes((await fake({ bins: { 'apt-cache': '/usr/bin/apt-cache' }, out: o }).sys), '/p', { reader: r, php: { state: 'missing' } })).map((n) => [n.project, n.verdict]));
  assert.deepEqual((await phpOffers((await fake({ bins: { 'apt-cache': '/usr/bin/apt-cache' }, out }).sys))).default, '8.5.4');
  assert.deepEqual(await verdicts(out), { legacy: 'newer', shop: 'fits' }, 'apt would install 8.5.4');
  // Where the package it brings cannot be read, only the series is known: 8.5.0 is not assumed.
  const seriesOnly = { ...out, 'apt-cache depends php-cli': { code: 1 } };
  assert.deepEqual(await verdicts(seriesOnly), { legacy: 'unknown', shop: 'unknown' });
  const [n] = await phpNotes((await fake({ bins: { 'apt-cache': '/usr/bin/apt-cache' }, out: seriesOnly }).sys), '/p', { reader: treeReader({ 'shop/composer.json': '{"require":{"php":"^8.5.1"}}' }), php: { state: 'missing' } });
  assert.match(n.text, /would install PHP 8\.5, and whether its patch release fits is not known before it is installed/);
  // A whole series on one side is still said: ^8.1 <8.4 against 8.5.
  assert.equal((await phpNotes((await fake({ bins: { 'apt-cache': '/usr/bin/apt-cache' }, out: seriesOnly }).sys), '/p', { reader: treeReader({ 'shop/composer.json': '{"require":{"php":"^8.1 <8.4"}}' }), php: { state: 'missing' } }))[0].verdict, 'newer');
});

test('a recipe names an optional kit only when it is complete here: a MySQL server alone does not put PHP on the next computer', () => {
  const ok = (ids) => ids.map((id) => ({ id, state: 'ok' }));
  const found = { basics: ok(['git']), php: [{ id: 'php', state: 'missing' }, { id: 'composer', state: 'missing' }, { id: 'mariadb', state: 'ok' }], fvm: [{ id: 'fvm', state: 'na' }], docker: [{ id: 'docker', state: 'missing' }] };
  assert.deepEqual(recipeKits(found), ['basics']);
  assert.deepEqual(recipeKits({ ...found, php: ok(['php', 'composer', 'mariadb']), fvm: ok(['fvm']) }), ['basics', 'php', 'fvm']);
});
