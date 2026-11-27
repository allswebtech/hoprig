// The shipped gateway in Hoprig's own folder: installed on demand and pinned, started as Node plus the copy's entry file
// with its data folder named, read without starting a program, left alone when it belongs to another user, a global copy
// kept in use until Install is pressed, removed with its data kept. The npm, the gateway and systemd are stand-ins: the
// npm writes a made-up package into the prefix it is given, the gateway is a small program that answers /healthz.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { traps } from '../machines/traps.mjs';

const skip = process.platform === 'win32' && 'POSIX scripts';
const box = sandbox('gateway-owncopy');
const { saveConfig } = await import('../../src/config.mjs');
const { localGateway } = await import('../../src/addons/localgateway.mjs');
const { SHIPPED, GATEWAY_PIN } = await import('../../src/addons/gateways.mjs');
const { servicePlan, unitName } = await import('../../src/addons/gatewayservice.mjs');
const { toolsDir, stateDir } = await import('../../src/paths.mjs');
const { spawnReason } = await import('../../src/addons/owncopy.mjs');

const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const port = await freePort();
saveConfig({ addons: { trouteai: { port } } });
const DATA = path.join(box.root, 'gw-data');
process.env.DATA_DIR = DATA;
process.env.XDG_CONFIG_HOME = path.join(box.home, '.config');
const standins = path.join(box.root, 'standins');
fs.mkdirSync(standins);
const trap = traps(box.root);
const savePath = process.env.PATH;
const seen = path.join(box.root, 'seen.jsonl');
const mainPid = path.join(box.root, 'main.pid');
const ctl = path.join(box.root, 'systemctl.log');

// What the made-up package's entry file does: records how it was started and answers /healthz and /v1/models.
const ENTRY = `import fs from 'node:fs';
import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ exec: process.execPath, argv: process.argv.slice(1), pid: process.pid, HOST: process.env.HOST || null }) + '\\n');
http.createServer((q, s) => s.end(q.url === '/healthz' ? 'ok' : 'gw')).listen(port, '127.0.0.1');
`;
// The pid the stand-in systemd keeps (0: none runs; never signalled: kill(0) would end the whole group).
const killMain = () => {
  const pid = Number(fs.readFileSync(mainPid, 'utf8'));
  if (pid > 1) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
};
const starts = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A stand-in for npm's run(): writes the package where `--prefix` says, as npm would.
function fakeNpm() {
  const calls = [];
  const run = async (argv, { onLine = () => {} } = {}) => {
    calls.push(argv);
    const prefix = argv[argv.indexOf('--prefix') + 1];
    const spec = argv.at(-1);
    const asked = spec.slice(spec.lastIndexOf('@') + 1);
    const version = asked === 'latest' ? '1.0.12' : asked; // what the registry's newest is, for the stand-in
    const pkg = path.join(prefix, 'node_modules', 'trouteai');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'trouteai', version, bin: { trouteai: 'bin/trouteai.mjs' } }));
    fs.writeFileSync(path.join(pkg, 'bin', 'trouteai.mjs'), ENTRY);
    fs.mkdirSync(path.join(prefix, 'node_modules', '.bin'), { recursive: true });
    // npm's shim in .bin: a link on POSIX, a .cmd file on Windows (what the product looks for there)
    const shim = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'trouteai.cmd' : 'trouteai');
    fs.rmSync(shim, { force: true });
    if (process.platform === 'win32') fs.writeFileSync(shim, '@echo off\r\n');
    else fs.symlinkSync(path.join('..', 'trouteai', 'bin', 'trouteai.mjs'), shim);
    onLine(`added trouteai@${version}`);
    return { ok: true, code: 0 };
  };
  const checks = [];
  const check = async (argv) => {
    checks.push(argv);
    const dir = path.dirname(path.dirname(argv[1]));
    return { ok: true, stdout: `TRouteAI ${JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version}\n`, stderr: '' };
  };
  return { calls, run, check, checks };
}

const make = (extra = {}) => {
  fs.rmSync(path.join(toolsDir(), 'trouteai'), { recursive: true, force: true }); // each test starts with no own copy
  fs.rmSync(DATA, { recursive: true, force: true });
  const npm = fakeNpm();
  const g = localGateway(SHIPPED[0], { shipped: true, reason: () => null, tools: { run: npm.run, check: npm.check }, sameUser: async () => 'own', ...extra });
  return { g, npm };
};
const gone = async (g) => {
  await g.stop().catch(() => {});
};
test.after(async () => {
  process.env.PATH = savePath;
  for (const s of starts()) if (s.pid > 1) try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ }
  box.cleanup();
});

test('the shipped gateway names the version Install puts into Hoprig\'s own folder, and no defined one can', () => {
  assert.equal(SHIPPED[0].own.pin, GATEWAY_PIN);
  assert.equal(GATEWAY_PIN, '1.0.11');
});

test('Install: into the tools folder at the pinned version with the scripts its README allows; never a global install', async () => {
  const { g, npm } = make();
  assert.equal((await g.status()).installed, true, 'the sandbox has a global stand-in already');
  const r = await g.install({ onLine: () => {} });
  assert.equal(r.ok, true);
  const argv = npm.calls[0];
  assert.ok(!argv.includes('-g') && !argv.includes('--global'), argv.join(' '));
  assert.equal(argv[argv.indexOf('--prefix') + 1], path.join(toolsDir(), 'trouteai'));
  assert.equal(argv.at(-1), `trouteai@${GATEWAY_PIN}`);
  assert.ok(!argv.some((a) => a.startsWith('--allow-scripts')), 'npm refuses the flag in a folder of its own: the prefix\'s package.json names the scripts');
  assert.ok(argv.includes('--loglevel=error'));
  const pj = JSON.parse(fs.readFileSync(path.join(toolsDir(), 'trouteai', 'package.json'), 'utf8'));
  assert.deepEqual(pj.allowScripts, { 'tls-client-node': true, koffi: true });
  const s = await g.status();
  assert.deepEqual([s.installed, s.version, s.copy], [true, GATEWAY_PIN, 'own']);
});

test('Status reads the copy\'s package.json and starts no program', { skip }, async () => {
  const { g, npm } = make();
  await g.install({ onLine: () => {} });
  npm.checks.length = 0;
  const s = await g.status();
  assert.equal(s.version, GATEWAY_PIN);
  assert.equal(npm.checks.length, 0, 'no `--version` run');
  assert.equal(s.running, false);
});

test('Start: Node plus the copy\'s entry file, --port and --data-dir, one line for every start', { skip }, async () => {
  const { g } = make();
  await g.install({ onLine: () => {} });
  const entry = path.join(toolsDir(), 'trouteai', 'node_modules', 'trouteai', 'bin', 'trouteai.mjs');
  const [bin, ...rest] = g.command();
  assert.equal(bin, process.execPath);
  assert.deepEqual(rest.slice(0, 3), [entry, '--port', String(port)]);
  assert.deepEqual(rest.slice(-2), ['--data-dir', DATA]);
  try {
    const r = await g.start();
    assert.equal(r.ok, true, r.error);
    const s = starts().at(-1);
    assert.equal(s.exec, process.execPath);
    assert.equal(s.argv[0], entry);
    assert.deepEqual(s.argv.slice(-2), ['--data-dir', DATA]);
    const st = await g.status();
    assert.equal(st.running, true);
    assert.equal(await g.ready(), true, 'its health route answers');
    assert.equal('ready' in st, false, 'status() asks nothing of the health route');
    assert.equal((await g.start()).already, true);
  } finally {
    await gone(g);
  }
});

test('Start that cannot read the copy says why at once, and spawns nothing', { skip: skip || process.getuid?.() === 0 }, async () => {
  const { g } = make();
  await g.install({ onLine: () => {} });
  const before = starts().length;
  const dir = path.join(toolsDir(), 'trouteai');
  fs.chmodSync(path.join(dir, 'node_modules', 'trouteai'), 0o000);
  try {
    const t = Date.now();
    const r = await g.start();
    assert.equal(r.ok, false);
    assert.match(r.error, /EACCES/);
    assert.match(r.error, /hoprig addons install trouteai/);
    assert.ok(Date.now() - t < 2000, 'not after 30 seconds');
    assert.equal(starts().length, before);
  } finally {
    fs.chmodSync(path.join(dir, 'node_modules', 'trouteai'), 0o755);
  }
});

test('Start with a data folder this user cannot write says so, naming the folder', { skip: skip || process.getuid?.() === 0 }, async () => {
  const { g } = make();
  await g.install({ onLine: () => {} });
  fs.mkdirSync(DATA, { recursive: true });
  fs.chmodSync(DATA, 0o500);
  try {
    const r = await g.start();
    assert.equal(r.ok, false);
    assert.ok(r.error.includes(DATA), r.error);
  } finally {
    fs.chmodSync(DATA, 0o700);
  }
});

test('a spawn error reads in plain words with its code', () => {
  assert.match(spawnReason({ code: 'ENOENT' }, '/x/node'), /\/x\/node was not found \(ENOENT\)/);
  assert.match(spawnReason({ code: 'EACCES' }, '/x/node'), /not allowed to run \/x\/node \(EACCES\)/);
});

test('a program of another user on its port: status says so, start refuses, stop leaves it, no key goes to it', { skip }, async () => {
  const { g } = make({ sameUser: async () => 'foreign' });
  const other = net.createServer((c) => { c.on('error', () => {}); c.end('HTTP/1.1 200 OK\r\ncontent-length: 1\r\n\r\nx'); }).listen(port, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  try {
    const s = await g.status();
    assert.deepEqual([s.running, s.foreign], [false, true]);
    assert.match(s.note, /another user/);
    assert.equal(s.note.split('. ').length <= 2, true, 'one sentence');
    const st = await g.start();
    assert.equal(st.ok, false);
    assert.match(st.error, /another user/);
    assert.match(st.error, /another port/);
    const sp = await g.stop();
    assert.deepEqual([sp.ok, sp.already, sp.foreign], [true, true, true]);
    assert.ok(other.listening, 'it is still there');
    assert.deepEqual(await g.answering(), { up: true, mine: false, otherUser: true });
    assert.equal((await g.status()).running, false);
  } finally {
    other.close();
  }
});

test('a gateway of this same user started outside Hoprig reads as running and is used as it is', { skip }, async () => {
  const { g, npm } = make();
  await g.install({ onLine: () => {} });
  const script = path.join(box.root, 'outside.mjs');
  fs.writeFileSync(script, ENTRY);
  const child = spawn(process.execPath, [script, '--port', String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await g.answering()).up; i++) await new Promise((r) => setTimeout(r, 100));
  try {
    const before = starts().length;
    npm.calls.length = 0;
    const s = await g.status();
    assert.deepEqual([s.running, s.foreign], [true, undefined]);
    const r = await g.start();
    assert.deepEqual([r.ok, r.already], [true, true]);
    assert.equal(starts().length, before, 'nothing was started');
    assert.equal(npm.calls.length, 0, 'nothing was installed');
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
});

test('a global copy stays in use until Install is pressed; --data-dir only where its version takes it', { skip }, async () => {
  const { g } = make();
  const s0 = await g.status();
  assert.deepEqual([s0.installed, s0.copy], [true, 'global']);
  const [bin, ...args] = g.command();
  assert.notEqual(bin, process.execPath);
  assert.ok(!args.includes('--data-dir'), 'a copy that says no version is started as before');
  // A global copy of 1.0.11 or newer takes --data-dir, which is the folder its own rule picks anyway.
  const globalPkg = path.join(box.root, 'npm', 'lib', 'node_modules', 'trouteai');
  fs.writeFileSync(path.join(globalPkg, 'package.json'), JSON.stringify({ name: 'trouteai', version: '1.0.11' }));
  try {
    assert.deepEqual(g.command().slice(-2), ['--data-dir', DATA]);
    assert.equal((await g.status()).version, '1.0.11');
    fs.writeFileSync(path.join(globalPkg, 'package.json'), JSON.stringify({ name: 'trouteai', version: '1.0.8' }));
    assert.ok(!g.command().includes('--data-dir'));
    assert.equal((await g.status()).version, '1.0.8');
  } finally {
    fs.rmSync(path.join(globalPkg, 'package.json'));
  }
  await g.install({ onLine: () => {} });
  assert.equal(g.command()[0], process.execPath, 'after Install the own copy is used');
  assert.equal((await g.status()).copy, 'own');
});

test('Update: the newest from npm into the own folder; a running one is stopped, updated and started again', { skip }, async () => {
  const { g, npm } = make();
  await g.install({ onLine: () => {} });
  try {
    assert.equal((await g.start()).ok, true);
    const first = starts().at(-1).pid;
    const r = await g.update({ onLine: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(npm.calls.at(-1).at(-1), 'trouteai@latest', 'npm resolves the newest');
    assert.equal((await g.status()).version, '1.0.12');
    assert.equal((await g.status()).running, true);
    assert.notEqual(starts().at(-1).pid, first, 'it was started again');
  } finally {
    await gone(g);
  }
});

test('Update that fails its own check and cannot start: it says it is down and which version is on disk, never "started again as it was"', { skip }, async () => {
  const { g, npm } = make();
  await g.install({ onLine: () => {} });
  try {
    assert.equal((await g.start()).ok, true);
    const crash = async (argv, o) => {
      const r = await npm.run(argv, o);
      if (argv.at(-1) === 'trouteai@latest') fs.writeFileSync(path.join(toolsDir(), 'trouteai', 'node_modules', 'trouteai', 'bin', 'trouteai.mjs'), 'process.exit(1);\n');
      return r;
    };
    const down = localGateway(SHIPPED[0], { shipped: true, reason: () => null, tools: { run: crash, check: async () => ({ ok: false, stdout: '', stderr: 'boom' }) }, sameUser: async () => 'own' });
    const r = await down.update({ onLine: () => {} });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /started again as it was/);
    assert.match(r.error, /not running/);
    assert.match(r.error, /1\.0\.12/);
  } finally {
    await gone(g);
  }
});

test('While an install or update holds the own copy\'s lock, a start from any process spawns nothing and says busy', { skip }, async () => {
  const { g } = make();
  await g.install({ onLine: () => {} });
  const { takeLock } = await import('../../src/codetools/lock.mjs');
  const release = await takeLock(path.join(toolsDir(), '.trouteai.lock'));
  const before = starts().length;
  try {
    const r = await g.start();
    assert.equal(r.ok, false);
    assert.equal(r.busy, true);
    assert.match(r.error, /being installed or updated/);
    assert.equal(starts().length, before, 'nothing was spawned');
  } finally {
    release();
  }
  assert.equal((await g.start()).ok, true, 'free again');
  await gone(g);
});

test('Update with only the npm copy: it says a copy of its own goes into Hoprig\'s folder and runs instead; the npm copy is left as it was', { skip }, async () => {
  const { g } = make();
  assert.equal((await g.status()).copy, 'global');
  const lines = [];
  await g.update({ onLine: (l) => lines.push(l) });
  assert.match(lines.join('\n'), /no copy of TRouteAI in Hoprig's own folder yet: a copy of its own is put there and runs instead\. The copy installed with npm is left as it was/);
  await gone(g);
});

// systemd as far as the gateway needs it: start and enable start the entry in the background and write its pid; stop
// ends it (or refuses when the file `refuse` is there); show gives the pid; is-active tells.
function systemdStandin() {
  const sh = path.join(standins, 'systemctl');
  const entry = () => path.join(toolsDir(), 'trouteai', 'node_modules', 'trouteai', 'bin', 'trouteai.mjs');
  fs.writeFileSync(sh, `#!/bin/sh
echo "systemctl $*" >> '${ctl}'
case "$*" in
  *show*MainPID*) cat '${mainPid}' ;;
  *is-active*) if [ "$(cat '${mainPid}')" = 0 ]; then echo inactive; else echo active; fi ;;
  *" stop "*) [ -e '${path.join(box.root, 'refuse')}' ] && { echo "refused" >&2; exit 1; }; P=$(cat '${mainPid}'); if [ "$P" -gt 1 ]; then kill "$P" 2>/dev/null; while kill -0 "$P" 2>/dev/null; do sleep 0.1; done; fi; echo 0 > '${mainPid}' ;;
  *" start "*|*"enable --now"*) if [ "$(cat '${mainPid}')" = 0 ]; then '${process.execPath}' '${entry()}' --port ${port} --data-dir '${DATA}' >> '${path.join(box.root, 'svc.log')}' 2>&1 & echo $! > '${mainPid}'; fi ;;
esac
exit 0
`, { mode: 0o755 });
}

test('Update of a gateway that its service runs: stopped through the service, updated, started through it; a refused stop is not ignored', { skip: skip || process.platform !== 'linux' }, async () => {
  const { g, npm } = make();
  await g.install({ onLine: () => {} });
  systemdStandin();
  fs.writeFileSync(mainPid, '0\n');
  process.env.PATH = trap.path(standins, path.join(box.root, 'npm', 'bin'));
  const { makeService } = await import('../../src/addons/gatewayservice.mjs');
  try {
    const plan = servicePlan(g, { platform: 'linux', env: process.env, home: box.home });
    assert.equal(plan.kind, 'systemd');
    assert.equal((await makeService(plan)).ok, true);
    for (let i = 0; i < 50 && !(await g.answering()).up; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await g.status()).byService, true);
    // A stop the service refuses: nothing is installed, and it says so.
    fs.writeFileSync(path.join(box.root, 'refuse'), '');
    npm.calls.length = 0;
    const no = await g.update({ onLine: () => {} });
    assert.equal(no.ok, false);
    assert.match(no.error, /refused|did not work/);
    assert.equal(npm.calls.length, 0, 'the copy under a running gateway was not touched');
    fs.rmSync(path.join(box.root, 'refuse'));
    const r = await g.update({ onLine: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    const log = fs.readFileSync(ctl, 'utf8');
    assert.match(log, /--user stop hoprig-gateway-trouteai\.service/);
    assert.match(log, /(--user start hoprig-gateway-trouteai\.service|enable --now hoprig-gateway-trouteai\.service)/);
    assert.equal((await g.status()).version, '1.0.12');
    assert.equal((await g.status()).running, true);
  } finally {
    killMain();
    process.env.PATH = savePath;
  }
});

test('the service line: the own copy with --data-dir, its output into the one log file', { skip }, async () => {
  const { g } = make();
  await g.install({ onLine: () => {} });
  const plan = servicePlan(g, { platform: 'linux', env: { PATH: '/usr/bin' }, home: box.home }); // seal: servicePlan's input, written into the unit's text only; no program is started with it
  const entry = path.join(toolsDir(), 'trouteai', 'node_modules', 'trouteai', 'bin', 'trouteai.mjs');
  assert.match(plan.text, new RegExp(`ExecStart="${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "--port"`));
  assert.ok(plan.text.includes(`"--data-dir" "${DATA}"`));
  const log = path.join(stateDir(), 'addons', 'trouteai.log');
  assert.ok(plan.text.includes(`StandardOutput=append:${log}`), plan.text);
  assert.ok(plan.text.includes(`StandardError=append:${log}`));
  assert.ok(!plan.text.includes('StandardOutput=null'));
  const mac = servicePlan(g, { platform: 'darwin', env: { PATH: '/usr/bin' }, home: box.home, uid: 501 }); // seal: servicePlan's input, written into the plist's text only
  assert.ok(mac.text.includes(`<key>StandardOutPath</key>\n    <string>${log}</string>`), mac.text);
  assert.ok(mac.text.includes('<string>--data-dir</string>'));
  assert.equal(unitName('trouteai'), 'hoprig-gateway-trouteai.service');
});

test('Remove: stops it, removes its service and the own folder; the data folder and the profile are kept and said so; a global copy is named', { skip: skip || process.platform !== 'linux' }, async () => {
  const { g } = make();
  await g.install({ onLine: () => {} });
  systemdStandin();
  fs.writeFileSync(mainPid, '0\n');
  process.env.PATH = trap.path(standins, path.join(box.root, 'npm', 'bin'));
  const { makeService } = await import('../../src/addons/gatewayservice.mjs');
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(DATA, 'db.sqlite'), 'data');
  const profile = path.join(box.profiles, 'api.env');
  fs.writeFileSync(profile, 'LABEL="API via TRouteAI"\n');
  try {
    const plan = servicePlan(g, { platform: 'linux', env: process.env, home: box.home });
    assert.equal((await makeService(plan)).ok, true);
    for (let i = 0; i < 50 && !(await g.answering()).up; i++) await new Promise((r) => setTimeout(r, 100));
    const r = await g.remove({ onLine: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(toolsDir(), 'trouteai')), false);
    assert.equal(fs.existsSync(plan.file), false, 'its service file is gone');
    assert.match(fs.readFileSync(ctl, 'utf8'), /disable --now hoprig-gateway-trouteai\.service/);
    assert.equal((await g.answering()).up, false);
    assert.equal(fs.readFileSync(path.join(DATA, 'db.sqlite'), 'utf8'), 'data');
    assert.ok(fs.existsSync(profile));
    assert.ok(r.said.includes(DATA) && /profile/.test(r.said) && /kept/.test(r.said), r.said);
    assert.match(r.said, /global copy/, 'the copy npm -g made is left alone and named');
    assert.equal((await g.status()).copy, 'global');
    // A second Remove has nothing to do and says so.
    const again = await g.remove({ onLine: () => {} });
    assert.deepEqual([again.ok, again.nothing], [true, true]);
  } finally {
    killMain();
    process.env.PATH = savePath;
    trap.check();
  }
});

test('a gateway the owner defined has no own copy and no Remove here', () => {
  const g = localGateway({ id: 'mine', title: 'Mine', npm: 'minepkg', bin: 'mine', port: 29001, args: ['--port', 'PORT'] }, { shipped: false });
  assert.equal(g.remove, undefined);
});

test('a gateway started before its copy was updated says so: restart it to run the version on disk', { skip: skip || process.platform !== 'linux' }, async () => {
  const { g } = make();
  const globalPkg = path.join(box.root, 'npm', 'lib', 'node_modules', 'trouteai', 'package.json');
  fs.writeFileSync(globalPkg, JSON.stringify({ name: 'trouteai', version: '1.0.11' }));
  const script = path.join(box.root, 'older.mjs');
  fs.writeFileSync(script, ENTRY);
  const child = spawn(process.execPath, [script, '--port', String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await g.answering()).up; i++) await new Promise((r) => setTimeout(r, 100));
  try {
    const hours = (n) => new Date(Date.now() + n * 3_600_000);
    fs.utimesSync(globalPkg, hours(1), hours(1)); // the files were replaced after the process started
    const s = await g.status();
    assert.deepEqual([s.running, s.version], [true, '1.0.11']);
    assert.equal(s.restart, 'The copy on this computer was updated after TRouteAI was started: restart it to run 1.0.11');
    fs.utimesSync(globalPkg, hours(-1), hours(-1)); // the files are older than the process: nothing to say
    assert.equal((await g.status()).restart, undefined);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(globalPkg, { force: true });
  }
});
