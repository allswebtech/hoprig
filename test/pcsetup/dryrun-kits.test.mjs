// `pc setup` with the optional kits, on the rich world of dryrun-fixture.mjs with { kits: true }: a PHP project that
// asks for an older PHP than the one here, a Flutter project with a pinned version, a made-up Android Studio with its own
// Java, and stand-in programs that log their argv OUTSIDE the world. --dry-run changes nothing at all (a full snapshot
// of the home before and after) and runs nothing that installs; a run with --yes never takes an optional kit by itself;
// and a run with --kits runs exactly the commands it printed, in that order. Nothing here installs anything: the
// runner of the real runs is a recorder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dryWorld, quietUi, runCli } from './dryrun-fixture.mjs';

const { detectKits, sysFacts } = await import('../../src/pcsetup/detect.mjs');
const { pcSetup, runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { showCommand, which } = await import('../../src/setup/system.mjs');

// What this computer may have for real is hidden, so the world decides: no Java, database or Composer of the system.
const HIDE = new Set(['java', 'mariadbd', 'mysqld', 'mariadb', 'mysql', 'composer', 'fvm', 'brew', 'docker']);
const inWorld = (w, p) => p === w.root || p.startsWith(`${w.root}/`);
// Asking npm its version (the Node kit's detection) makes npm write its compile cache into TMPDIR the first time: npm's
// own, not Hoprig's. It is made once before the snapshot, so the snapshot still sees anything else.
const sysFor = async (w) => {
  const sys = await facts(w);
  await detectKits(sys, ['node']);
  return sys;
};
// apt and ~/android-studio/jbr are Linux's: the platform comes with them, whatever computer runs the tests.
const facts = (w) => sysFacts({
  platform: 'linux', arch: 'x64', pm: 'apt', root: false, user: 'dev', home: w.home,
  has: (b) => b === 'sudo' || (!HIDE.has(b) && Boolean(which(b, process.env))),
  exists: (f) => inWorld(w, f) && fs.existsSync(f),
  list: (d) => {
    try {
      return inWorld(w, d) ? fs.readdirSync(d) : [];
    } catch {
      return [];
    }
  },
});
const recorder = () => {
  const ran = [];
  return { ran, runner: async (argv) => (ran.push(argv), { ok: true, code: 0 }) };
};
/** The command lines `pc setup` printed under "Will run" (a step Hoprig runs itself reads "(Hoprig) …"; the shell lines
 * shown under it, indented further, are left out: `blockLines` gives them). */
const blockLines = (text) => text.split('\n').filter((l) => l.startsWith('        ') && /# [a-z][a-z-]*$/.test(l)).map((l) => l.trim());
const willRun = (text) => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Will run'));
  if (at < 0) return [];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('    ')) break;
    if (!l.startsWith('        ')) out.push(l.trim());
  }
  return out;
};

test('pc setup --dry-run with the optional kits: nothing changed, nothing installed; the suggestions, the PHP note and the Java line are said', async (tc) => {
  const w = await dryWorld(tc, 'kits', { kits: true });
  const sys = await sysFor(w);
  const setup = (args) => runCli((a, o) => pcSetup(a, { ...o, sys }), args);

  const plain = await w.unchanged('pc setup --dry-run', () => setup(['--dry-run']));
  assert.match(plain.text, /PHP \+ database \(optional\): missing Composer, MariaDB \(server\)/);
  assert.match(plain.text, /suggested: legacy has composer\.json \(not chosen: add --kits php\)/);
  assert.match(plain.text, /Flutter versions \(fvm\) \(optional\): missing fvm/);
  assert.match(plain.text, /Docker \(optional\): missing Docker[^\n]*\n\s+suggested: legacy has docker-compose\.yml \(not chosen: add --kits docker\)/);
  assert.match(plain.text, /suggested: mobile has \.fvmrc \(not chosen: add --kits fvm\)/);
  assert.match(plain.text, /! legacy needs PHP 8\.1 up to 8\.3, and PHP 8\.5\.4 here is too new\. What you can do: run legacy in Docker with the official php:8\.3 image \(the Docker kit\)\./);
  assert.match(plain.text, /Java \(no kit: Hoprig only looks for it\): Java 21\.0\.6, found in Android Studio \(~\/android-studio\/jbr\)/);
  assert.match(plain.text, /Only if a build says JAVA_HOME is not set: add this line to ~\/\.bashrc \(or ~\/\.zshrc if you use zsh\), then open a new terminal: export JAVA_HOME="\$HOME\/android-studio\/jbr"/);
  assert.doesNotMatch(willRun(plain.text).join('\n'), /composer|mariadb|fvm|php/, 'a suggestion is not taken without --kits');

  w.clearKitLog();
  const kits = await w.unchanged('pc setup --dry-run --kits php,fvm', () => setup(['--dry-run', '--kits', 'php,fvm']));
  assert.equal(kits.code, 0, kits.text);
  assert.deepEqual(willRun(kits.text), [
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get update',
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y composer mariadb-server',
    'dart pub global activate fvm',
    // A workspace is here: fvm keeps its Flutter versions in development/flutter/fvm, through the kits block.
    '(Hoprig) write FVM_CACHE_PATH=$HOME/Workspace/development/flutter/fvm into the hoprig kits block of your shell start files (once, replaced in place)',
  ]);
  assert.deepEqual(blockLines(kits.text), ['export FVM_CACHE_PATH="$HOME/Workspace/development/flutter/fvm"  # fvm']);
  assert.match(kits.text, /\(dry run\) would ask: Install these 4 steps now\? — nothing is changed/);
  assert.match(kits.text, /Dry run: nothing was changed/);
  assert.match(kits.text, /PHP \+ database: MariaDB is a service: it starts now and with the computer[^\n]*\n[\s\S]*would ask: Install these 4 steps now\?/, 'the service is said before the one question');
  // Only programs that answer a question ran: no install, no dart pub, no package source.
  for (const c of w.kitCalls()) assert.match(c, /^(php -v|apt-cache (policy|pkgnames|depends) \S+|java -version)$/, c);
  assert.ok(w.kitCalls().includes('php -v') && w.kitCalls().includes('java -version'));
});

test('pc setup --yes takes no optional kit; with --kits it runs exactly what it printed, in that order and no more', async (tc) => {
  const w = await dryWorld(tc, 'kitsrun', { kits: true });
  const sys = await sysFor(w);
  const a = recorder();
  const ui = await quietUi({ yes: true });
  await runPcSetup({ ui, yes: true, sys, runner: a.runner });
  assert.ok(!a.ran.some((argv) => /php|composer|mariadb|fvm|docker/.test(argv.join(' '))), `--yes took an optional kit: ${JSON.stringify(a.ran)}`);

  const b = recorder();
  const ui2 = await quietUi({ yes: true });
  await runPcSetup({ ui: ui2, yes: true, kits: ['php', 'fvm'], sys, runner: b.runner });
  // Every command it printed ran, in that order; the kits block is written by Hoprig itself, not by a command.
  assert.deepEqual(b.ran.map(showCommand), willRun(ui2.text()).filter((l) => !l.startsWith('(Hoprig) ')));
  assert.equal(b.ran.length, 3);
  assert.match(fs.readFileSync(`${w.home}/.profile`, 'utf8'), /# >>> hoprig kits[^\n]*\nexport FVM_CACHE_PATH="\$HOME\/Workspace\/development\/flutter\/fvm"  # fvm\n# <<< hoprig kits <<<\n/);
  assert.doesNotMatch(JSON.stringify(b.ran), /add-apt-repository|ppa:|update-alternatives|remove|purge|git clone|workspace\.json/);
  assert.match(ui2.text(), /MariaDB is a service: it starts now and with the computer/);
});

test('a jbr that does not run: named with its place and what to do, never "no Java found"; nothing offered to install', async (tc) => {
  const w = await dryWorld(tc, 'kitsjava', { kits: true });
  w.brokenJava();
  const sys = await sysFor(w);
  const r = await w.unchanged('pc setup --dry-run --kits fvm (broken jbr)', () => runCli((a, o) => pcSetup(a, { ...o, sys }), ['--dry-run', '--kits', 'fvm']));
  // Found but not working is said once, and never as "no Java found" beside it.
  assert.match(r.text, /· Java \(no kit: Hoprig only looks for it\): No working Java\. The Java in Android Studio \(~\/android-studio\/jbr\) did not run: open Android Studio once, or reinstall it\.\n/);
  assert.doesNotMatch(r.text, /No Java found|Found but not working/);
  assert.doesNotMatch(willRun(r.text).join('\n'), /java|jdk/i);
});

test('pc setup --kits flutter --dry-run on a home with a workspace: nothing changes, nothing is fetched; the plan names address, size, place and shell line', async (tc) => {
  const w = await dryWorld(tc, 'kitsflutter', { kits: true });
  const sys = await sysFor(w);
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    throw new Error('a dry run asked the network');
  };
  const r = await w.unchanged('pc setup --dry-run --kits flutter', () => runCli((a, o) => pcSetup(a, { ...o, sys, get }), ['--dry-run', '--kits', 'flutter']));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(asked, [], 'nothing was fetched');
  assert.deepEqual(willRun(r.text), [
    `(Hoprig) download Flutter's current stable release (the one https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json names) from storage.googleapis.com over https, about 1.6 GB (about 3 GB on disk), check its sha256, unpack it into ~/Workspace/development/flutter/flutter`,
    '(Hoprig) write $HOME/Workspace/development/flutter/flutter/bin on PATH into the hoprig kits block of your shell start files (once, replaced in place)',
  ]);
  assert.deepEqual(blockLines(r.text), ['case ":$PATH:" in *":$HOME/Workspace/development/flutter/flutter/bin:"*) ;; *) PATH="$HOME/Workspace/development/flutter/flutter/bin:$PATH"; export PATH ;; esac  # flutter']);
  assert.match(r.text, /\(dry run\) would ask: Install these 2 steps now\? — nothing is changed/);
  // The packages Flutter's own page names are the owner's to install: shown with the command, never planned.
  assert.match(r.text, /Flutter: yours to do: Flutter needs [^\n]*libglu1-mesa[^\n]*\n {4}sudo apt-get install [^\n]*libglu1-mesa/);
  assert.doesNotMatch(willRun(r.text).join('\n'), /sudo|apt-get/);
  for (const c of w.kitCalls()) assert.match(c, /^(php -v|apt-cache (policy|pkgnames|depends) \S+|java -version)$/, c);
});

test('pc setup --kits android --dry-run on a home with a workspace: nothing changes, nothing is fetched, no licence is answered', async (tc) => {
  const w = await dryWorld(tc, 'kitsandroid', { kits: true });
  const sys = await sysFor(w);
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    throw new Error('a dry run asked the network');
  };
  const r = await w.unchanged('pc setup --dry-run --kits android', () => runCli((a, o) => pcSetup(a, { ...o, sys, get }), ['--dry-run', '--kits', 'android']));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(asked, [], 'nothing was fetched');
  assert.deepEqual(willRun(r.text), [
    '(Hoprig) download the Android SDK command-line tools (the ones https://dl.google.com/android/repository/repository2-3.xml names) from dl.google.com over https, about 185 MB, check their sha1 (the only checksum Google\'s list gives), unpack them into ~/Workspace/development/sdk/android-sdk/cmdline-tools/latest',
    '(Hoprig) write ANDROID_HOME=$HOME/Workspace/development/sdk/android-sdk, $HOME/Workspace/development/sdk/android-sdk/cmdline-tools/latest/bin on PATH, $HOME/Workspace/development/sdk/android-sdk/platform-tools on PATH into the hoprig kits block of your shell start files (once, replaced in place)',
  ]);
  assert.equal(blockLines(r.text)[0], 'export ANDROID_HOME="$HOME/Workspace/development/sdk/android-sdk"  # android-home');
  assert.match(r.text, /\(dry run\) would ask: Install these 2 steps now\? — nothing is changed/);
  // Google's licence and the packages are the owner's: shown with the command to type, never planned, never run.
  assert.match(r.text, /Android: yours to do: Google's licence for the Android SDK is yours to read and accept: Hoprig never accepts it for you[^\n]*\n {4}"\$HOME\/Workspace\/development\/sdk\/android-sdk\/cmdline-tools\/latest\/bin\/sdkmanager" --sdk_root="\$HOME\/Workspace\/development\/sdk\/android-sdk" --licenses/);
  assert.match(r.text, /Android Studio \(Android\): Hoprig does not download Android Studio[^\n]*developer\.android\.com\/studio/);
  assert.doesNotMatch(willRun(r.text).join('\n'), /sdkmanager|--licenses|sudo|apt-get/);
  for (const c of w.kitCalls()) assert.match(c, /^(php -v|apt-cache (policy|pkgnames|depends) \S+|java -version)$/, c);
});
