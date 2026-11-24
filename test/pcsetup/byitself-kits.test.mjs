// What the optional kits (PHP + database, fvm), the PHP version note, the suggestions and the Java search do BY
// THEMSELVES in the real dashboard (createServer), in a home of the shape most owners have after an update (default
// settings, the automations on as by default) with a PHP project, a Flutter project that pins its version and an
// Android Studio with its own Java: the start and three ticks read no project file of theirs, start no program of
// theirs and write nothing. They run only when someone asks: the Setup tab (GET /api/pcsetup/status and /kits, when the
// page or its sheet is opened), Tia's get_computer_status setup tool (when the owner asks her), `pc status` and
// `pc setup`. The end of the test asks once, so the watch is shown to see them.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeTools } from '../setup/helpers.mjs';
import { tempWork } from '../work/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'automation', 'fixtures', 'fake-claude.mjs');
const posix = process.platform !== 'win32';
// The modules of this part: a call that comes from one of them is theirs.
const OURS = /src[\\/]pcsetup[\\/](optional|suggest|java|phpver)\.mjs/;
// What their reading looks at, and the programs they start, by name.
const FILES = /(^|[\\/])(composer\.json|artisan|\.fvmrc|fvm_config\.json|build\.gradle)$|[\\/]jbr([\\/]|$)/;
const PROGRAMS = /^(php[0-9.]*|composer|java|apt-cache|dart|fvm|brew|mariadbd?|mysqld?)$/;

/** Every file under `root` → a hash of its content (a link: where it points). */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

/** Programs started and file calls made meanwhile: those whose stack holds one of our modules, and those that look at
 * what our reading looks for (by anyone). */
function watch() {
  const seen = { programs: [], ours: [], files: [] };
  let on = true;
  const origCp = {};
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    origCp[k] = childProcess[k];
    childProcess[k] = function (file, args, ...rest) {
      if (on) {
        const argv = [String(file), ...(Array.isArray(args) ? args.map(String) : [])];
        if (PROGRAMS.test(path.basename(argv[0])) || OURS.test(new Error().stack)) seen.programs.push(argv.join(' '));
      }
      return origCp[k].call(this, file, args, ...rest);
    };
  }
  const origFs = {};
  for (const k of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync', 'openSync', 'accessSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'symlinkSync']) {
    origFs[k] = fs[k];
    const wrapped = function (p, ...rest) {
      if (on) {
        const s = typeof p === 'string' ? p : p instanceof URL ? fileURLToPath(p) : '';
        if (OURS.test(new Error().stack)) seen.ours.push(`${k} ${s}`);
        else if (FILES.test(s)) seen.files.push(`${k} ${s}`);
      }
      return origFs[k].call(this, p, ...rest);
    };
    Object.assign(wrapped, origFs[k]); // realpathSync.native
    fs[k] = wrapped;
  }
  syncBuiltinESMExports();
  seen.pause = () => { on = false; };
  seen.resume = () => { on = true; };
  seen.clear = () => { seen.programs.length = 0; seen.ours.length = 0; seen.files.length = 0; };
  seen.stop = () => {
    Object.assign(childProcess, origCp);
    Object.assign(fs, origFs);
    syncBuiltinESMExports();
  };
  return seen;
}

async function home() {
  const w = tempWork('kits-byitself');
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root)); // a workspace of its own: never the real one
  // A PHP project asking an older PHP, a Flutter project with a pinned version, an Android Studio with its own Java.
  fs.mkdirSync(path.join(w.projects, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(w.projects, 'shop', 'composer.json'), '{ "require": { "php": "^8.1 <8.4" } }\n');
  fs.writeFileSync(path.join(w.projects, 'shop', 'artisan'), '<?php\n');
  fs.mkdirSync(path.join(w.projects, 'mobile'), { recursive: true });
  fs.writeFileSync(path.join(w.projects, 'mobile', '.fvmrc'), '{ "flutter": "3.24.5" }\n');
  fs.writeFileSync(path.join(w.projects, 'mobile', 'pubspec.yaml'), 'name: mobile\n');
  // Its Android half: the project here that needs Java, so the Java search has something to be asked for.
  fs.mkdirSync(path.join(w.projects, 'mobile', 'android'), { recursive: true });
  fs.writeFileSync(path.join(w.projects, 'mobile', 'android', 'build.gradle'), '');
  const jbr = path.join(w.home, 'android-studio', 'jbr', 'bin');
  fs.mkdirSync(jbr, { recursive: true });
  fs.writeFileSync(path.join(jbr, 'java'), '#!/bin/sh\necho \'openjdk version "21.0.6" 2025-01-21\' >&2\n', { mode: 0o755 });
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const claudeBin = path.join(w.root, 'fake-claude.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`, { mode: 0o755 });
  // Default settings: nothing of the kits is in them (there is no switch for them), the automations as by default.
  saveConfig({ claudeBin, usage: false, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') } });
  return w;
}

test('after an update, with the Setup tab never opened: the start and three ticks read no project, start no program and write nothing of the optional kits; one request does', { timeout: 90_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const w = await home();
  // Stand-ins (gh, docker, tailscale) first on PATH: the Setup route and the status checks run them, so the owner's
  // real GitHub, container daemon and private network are never reached. They are not the optional kits' programs
  // (PROGRAMS above), so the watch still proves the kits start nothing.
  process.env.PATH = `${fakeTools(path.join(w.root, 'tools'))}${path.delimiter}${process.env.PATH}`;
  // The facts of this computer but for the kits': it has no Java of its own (none on PATH, no JDK of the system), and
  // no PHP, Composer or database (a computer that has them would see the PHP kit complete, and so not suggested). The
  // world's Java is Android Studio's, and a Java, PHP or database this computer may have for real is never started.
  const { sysFacts } = await import('../../src/pcsetup/detect.mjs');
  // The world's Java is where a Linux Android Studio keeps it: the platform is handed with it (on a Mac the PHP lookup
  // would ask Homebrew, which is not part of this world).
  const real = await sysFacts({ platform: 'linux' });
  const NOT_HERE = /^(java|php[0-9.]*|composer|mariadbd?|mysqld?)$/;
  const ours = (p) => path.resolve(p).startsWith(`${path.resolve(w.root)}${path.sep}`); // the world's own files stay
  const sys = {
    ...real,
    has: (b) => !NOT_HERE.test(b) && real.has(b),
    which: (b) => (NOT_HERE.test(b) ? null : real.which(b)),
    exists: (f) => (ours(f) || !NOT_HERE.test(path.basename(f))) && real.exists(f),
    list: (d) => (d === '/usr/lib/jvm' ? [] : ours(d) ? real.list(d) : real.list(d).filter((n) => !NOT_HERE.test(n))),
  };
  const before = snapshot(w.root);
  const seen = watch();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `kits-byitself-${process.pid}`, pcsetup: { sys } });
  const { port } = await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500)); // what the start does by itself is done
  const auto = app.features.find((f) => f.name === 'automation').automation;
  for (let i = 0; i < 3; i++) await auto.tick();
  await new Promise((r) => setTimeout(r, 500));
  seen.pause();
  const after = snapshot(w.root);
  const quiet = { programs: [...seen.programs], ours: [...seen.ours], files: [...seen.files] };

  assert.deepEqual(quiet.ours, [], 'no file call from the kits\' modules');
  assert.deepEqual(quiet.programs, [], 'no php, composer, java, apt-cache, dart, fvm, brew or database program started');
  assert.deepEqual(quiet.files, [], 'no composer.json, artisan, .fvmrc, build.gradle or jbr looked at by anyone');
  const changed = changes(before, after);
  assert.deepEqual(changed.filter((f) => f.startsWith('home/')), [], 'nothing in the person\'s home changed (projects, Android Studio, shell files)');
  if (process.env.KITS_BYITSELF_CHANGES) fs.writeFileSync(process.env.KITS_BYITSELF_CHANGES, `${JSON.stringify({ changed }, null, 1)}\n`);

  // Who asks: the Setup tab's sheet, once. Now the watch must see the reading and the Java search: it would have seen
  // them above. And even when asked, nothing is written in the home.
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-for-tests' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const asked = snapshot(w.root);
  seen.clear();
  seen.resume();
  const r = await fetch(`${base}/api/pcsetup/kits`, { headers: { Origin: base, Cookie: cookie } });
  seen.pause();
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.kits.some((k) => k.id === 'php' && (k.suggested || []).length), 'the PHP kit is suggested for shop');
  assert.ok(!d.kits.find((k) => k.id === 'php').defaultOn, 'and stays unticked');
  assert.match(d.java.text, /^Java 21\.0\.6, found in Android Studio/);
  assert.ok(seen.ours.some((c) => /composer\.json$/.test(c)), `the watch sees the reading when asked: ${seen.ours.slice(0, 5).join(' | ')}`);
  assert.ok(seen.programs.some((p) => /jbr[\\/]bin[\\/]java -version$/.test(p)), `the watch sees the Java search when asked: ${seen.programs.join(' | ')}`);
  assert.deepEqual(seen.programs.filter((p) => !/ -version$| -v$|^apt-cache (policy|depends|show|pkgnames)\b|^brew (info|formulae)\b/.test(p)), [], 'when asked, only programs that print their version or what a package manager offers');
  const writes = seen.ours.filter((c) => /^(writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|symlinkSync|openSync) /.test(c));
  assert.deepEqual(writes, [], 'nothing written by the kits\' modules when asked');
  // The route runs `gh` to look at the GitHub kit (as it did before the optional kits); here that is the stand-in, so
  // it writes nothing. A real gh would write its own device id, which is still tolerated (not the optional kits).
  const GH_OWN = 'home/.local/state/gh/device-id';
  assert.deepEqual(changes(asked, snapshot(w.root)).filter((f) => f.startsWith('home/') && f !== GH_OWN), [], 'nothing in the home changed when asked');
});
