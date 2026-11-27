// install.sh for real with a pack of this tree, in a sealed home, then doctor there. The pack is made by `npm pack` of a
// copy of the tree that carries its dependencies (bundled, copied from this tree's node_modules), so the install
// needs nothing from a registry: npm runs offline, with an empty cache inside the home and a registry address where
// nothing listens. The stand-in npm first on PATH turns the installer's global install into one with a prefix inside
// the home (npm's global layout: <prefix>/lib/node_modules, <prefix>/bin), and every real npm call goes through the
// runner's npm trap, which refuses anything global. The installed hoprig's set-up and doctor reach no network: fetch
// is refused in their processes except to this computer, and every program they would start is a stand-in or is
// not on their PATH.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeBin, fakeClaude, pathWith } from './helpers.mjs';
import { sealed } from '../seal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const linux = process.platform === 'linux';
const traps = process.env.HOPRIG_TEST_TRAPS;
const skip = !linux ? 'install.sh with real basic tools: Linux here' : !traps ? 'run through the test runner (its npm trap)' : false;

/** The npm that comes after the runner's traps on this process's PATH (what the npm trap passes an allowed call to). */
function npmAfterTraps() {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs.slice(dirs.indexOf(traps) + 1)) if (d && fs.existsSync(path.join(d, 'npm'))) return fs.realpathSync(path.join(d, 'npm'));
  return null;
}

/** Every package this one needs at run time, by name, from node_modules (the closure of dependencies). */
function closure(modules) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const seen = new Set();
  const queue = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n)) continue;
    const file = path.join(modules, n, 'package.json');
    if (!fs.existsSync(file)) continue; // an optional one not installed here
    seen.add(n);
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    queue.push(...Object.keys({ ...(p.dependencies || {}), ...(p.optionalDependencies || {}) }));
  }
  return [...seen];
}

test('install.sh with a pack of this tree in a sealed home: installed offline into the home, set-up runs, and doctor there agrees', { skip, timeout: 600_000 }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-installpack-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const realNpm = npmAfterTraps();
  assert.ok(realNpm, 'an npm after the traps');

  // 1. The pack: a copy of what the package ships, with its dependencies bundled.
  const copy = path.join(tmp, 'tree');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(copy);
  for (const f of fs.readdirSync(ROOT)) {
    if (['bin', 'src', 'web', 'templates', 'skills', 'docs', 'install.sh', 'install.ps1', 'README.md', 'LICENSE', 'NOTICE', 'TRADEMARKS.md'].includes(f)) fs.cpSync(path.join(ROOT, f), path.join(copy, f), { recursive: true });
  }
  const names = closure(path.join(ROOT, 'node_modules'));
  for (const n of names) fs.cpSync(path.join(ROOT, 'node_modules', n), path.join(copy, 'node_modules', n), { recursive: true, dereference: true });
  const direct = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})].filter((n) => names.includes(n));
  fs.writeFileSync(path.join(copy, 'package.json'), `${JSON.stringify({ ...pkg, bundleDependencies: direct }, null, 2)}\n`);
  const npmEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k))), npm_config_cache: path.join(tmp, 'pack-cache'), npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9/', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  const t0 = Date.now();
  const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', tmp, '--loglevel=error'], { cwd: copy, env: npmEnv, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 }).trim().split('\n').pop();
  const tgz = path.join(tmp, packed);
  assert.ok(fs.existsSync(tgz), packed);
  t.diagnostic(`pack: ${packed}, ${(fs.statSync(tgz).size / 1e6).toFixed(1)} MB, ${names.length} bundled packages, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  fs.rmSync(copy, { recursive: true, force: true });

  // 2. The sealed home and its computer: real basic tools by name, stand-ins for the rest.
  const home = path.join(tmp, 'home');
  const prefix = path.join(home, '.npm-global');
  const rec = path.join(tmp, 'record.log');
  fs.mkdirSync(path.join(home, '.config', 'hoprig'), { recursive: true });
  fs.mkdirSync(prefix, { recursive: true }); // npm's global folder, the user's own (as with nvm)
  // doctor and set-up ask the dashboard's port: a free one of this test's, never the default.
  const port = await (await import('../../src/machines/tunnels.mjs')).freePort();
  fs.writeFileSync(path.join(home, '.config', 'hoprig', 'config.json'), `${JSON.stringify({ server: { port } })}\n`);
  fs.writeFileSync(path.join(home, 'globalnpmrc'), '');
  const realNpmDir = path.join(tmp, 'real-npm');
  fs.mkdirSync(realNpmDir);
  fs.symlinkSync(realNpm, path.join(realNpmDir, 'npm'));
  const nodeDir = pathWith(tmp); // a folder holding only a link to this node
  const builtPty = path.join(fs.realpathSync(path.join(ROOT, 'node_modules', 'node-pty')), 'build');
  assert.ok(fs.existsSync(path.join(builtPty, 'Release', 'pty.node')), 'this tree has a built terminal module');
  const r = (name) => `printf '%s %s\\n' ${name} "$*" >> '${rec}'`;
  const bin = fakeBin(path.join(tmp, 'bin'), {
    uname: 'echo Linux',
    claude: fakeClaude(),
    sudo: `${r('sudo')}\nexit 1`,
    systemctl: `${r('systemctl')}\nexit 1`,
    loginctl: `${r('loginctl')}\ncase "$1" in show-user) echo Linger=yes ;; *) exit 1 ;; esac`,
    curl: `${r('curl')}\nexit 1`,
    make: 'echo "GNU Make 4.3"', 'c++': 'echo "c++ 13.2.0"', python3: 'echo "Python 3.12.3"',
    // The npm of this computer, for this test: a global install goes to a prefix inside the home, offline, through the
    // runner's trap (which passes only a call that is not global on to the real npm).
    npm: `${r('npm')}
P='${prefix}'
real() { PATH='${nodeDir}${path.delimiter}${traps}${path.delimiter}${realNpmDir}' "$HOPRIG_TEST_TRAPS/npm" "$@"; }
case "$1" in
  --version) real --version ;;
  prefix) if [ "$2" = -g ]; then echo "$P"; else echo "$PWD"; fi ;;
  install)
    shift
    want=
    for a do
      shift
      if [ "$want" = 1 ]; then P=$a; want=; continue; fi
      case $a in -g|--global) ;; --prefix) want=1 ;; --prefix=*) P=\${a#--prefix=} ;; *) set -- "$@" "$a" ;; esac
    done
    mkdir -p "$P/lib" "$P/bin"
    real install --prefix "$P/lib" --offline --ignore-scripts "$@" || exit $?
    for b in hoprig hop; do ln -sf ../lib/node_modules/hoprig/bin/hoprig.mjs "$P/bin/$b"; done ;;
  # set-up builds the terminal module in hoprig's folder: a real build would run node-gyp, which downloads Node's headers.
  # The stand-in puts this tree's already built module there instead (no compiler, no network).
  rebuild) [ "$2" = node-pty ] && [ -f "$PWD/node_modules/node-pty/package.json" ] || exit 98
    cp -R '${builtPty}' "$PWD/node_modules/node-pty/build" ;;
  *) echo "npm stand-in: not expected here: $*" >&2; exit 98 ;;
esac`,
  });
  const { which } = await import('../../src/setup/system.mjs');
  for (const tool of ['sh', 'id', 'sed', 'mktemp', 'tail', 'rm', 'env', 'cat', 'mkdir', 'chmod', 'grep', 'ln', 'dirname', 'cp']) {
    const real = which(tool, { PATH: '/usr/bin:/bin' }, process.platform); // seal: a value no program is started with
    if (real) fs.symlinkSync(real, path.join(bin, tool));
  }
  // In the installed hoprig's processes: no fetch beyond this computer (the newest Claude Code lookup says "unknown").
  const offline = path.join(tmp, 'offline.mjs');
  fs.writeFileSync(offline, "const was = globalThis.fetch;\nglobalThis.fetch = async (u, o) => { if (/^http:\\/\\/(127\\.0\\.0\\.1|localhost)[:/]/.test(String(u?.url ?? u))) return was(u, o); throw new TypeError('offline (test)'); };\n");
  const env = sealed({
    PATH: pathWith(tmp, bin), HOME: home, TMPDIR: tmp, LANG: 'C.UTF-8', SHELL: '/bin/sh', USER: 'alex',
    HOPRIG_SOURCE: tgz, NODE_OPTIONS: `--import=${pathToFileURL(offline).href}`,
    npm_config_cache: path.join(home, '.npm-cache'), npm_config_globalconfig: path.join(home, 'globalnpmrc'), npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
  });
  const run = (file, args) => new Promise((resolve) => {
    const child = spawn(file, args, { env, cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

  // 3. The installer, with set-up's base part (the computer, Git and workspace parts have their own whole-run tests).
  const t1 = Date.now();
  const inst = await run('sh', [path.join(ROOT, 'install.sh'), '--yes', '--only', 'base', '--no-service']);
  t.diagnostic(`install.sh: exit ${inst.code}, ${((Date.now() - t1) / 1000).toFixed(1)} s\n${inst.out}`);
  const calls = fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8') : '';
  t.diagnostic(`stand-ins asked:\n${calls}`);
  assert.match(inst.out, /^✓ Hoprig$/m, inst.out);
  assert.equal(inst.code, 0, inst.out);
  assert.ok(fs.existsSync(path.join(prefix, 'lib', 'node_modules', 'hoprig', 'package.json')), 'installed into the home');
  assert.ok(fs.existsSync(path.join(prefix, 'lib', 'node_modules', 'hoprig', 'node_modules', 'ws')), 'with its bundled dependencies');
  assert.doesNotMatch(calls, /^sudo |^curl /m, 'nothing asked of sudo or a download');
  assert.match(calls, /^npm rebuild node-pty$/m, 'set-up built the terminal module (the stand-in\'s copy)');
  assert.match(calls, new RegExp(`^npm install -g --no-audit --no-fund --no-update-notifier --loglevel=error ${tgz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(inst.out, /✓ Terminal: (tmux|built-in)/);
  assert.match(inst.out, /hoprig is ready\./);

  // 4. doctor in that home: the same hoprig, the same access, nothing that fails.
  const doc = await run(path.join(prefix, 'bin', 'hoprig'), ['doctor', '--offline', '--json']);
  let checks;
  try {
    checks = JSON.parse(doc.out.slice(doc.out.indexOf('{'))).groups.flatMap((g) => g.checks);
  } catch {
    assert.fail(`doctor's answer is not JSON:\n${doc.out}`);
  }
  t.diagnostic(`doctor: exit ${doc.code}\n${checks.map((c) => `${c.status} ${c.label}: ${c.detail}`).join('\n')}`);
  const by = (id) => checks.find((c) => c.id === id);
  assert.deepEqual(checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`), [], 'nothing fails');
  assert.equal(doc.code, 0);
  assert.match(by('app').detail, new RegExp(`^${pkg.version.replace(/\./g, '\\.')} \\(~/\\.npm-global/lib/node_modules/hoprig\\)$`));
  // Who may open it: doctor's words are set-up's.
  const opened = /✓ Open to: (.+)/.exec(inst.out)?.[1];
  assert.ok(opened, inst.out);
  assert.match(by('access').detail, opened.startsWith('only this computer') ? /^this computer only/ : /^local network/);
  assert.equal(by('command').status, 'ok', by('command').detail);
});
