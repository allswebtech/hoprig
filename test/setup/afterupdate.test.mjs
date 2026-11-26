// What the server set-up work does BY ITSELF after an update, where the dashboard already runs as a service: the real
// dashboard (createServer, as `serve` starts it, with its login check) starts in a home shaped as the last version left
// it (its service unit written by that version, carrying a language the computer lacks; a saved server reason; on the
// server the settings still open to the network), then its watcher and automation tick three times. Nothing outside
// the dashboard's own state folder changes, no program of the computer's own is started, the unit file and the
// settings stay as they are (only `hoprig setup` or `hoprig service install` rewrites them), and inside the state
// folder only the dashboard file (with its key for the local facts route) comes and goes. The start's environment is
// the service's own: its language is NOT dropped by the start itself, only by the next unit file set-up writes.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fakeBin, fakeClaude, pathWith } from './helpers.mjs';
import { sealedPath } from '../seal.mjs';
import { tempWork } from '../work/helpers.mjs';

const posix = process.platform !== 'win32';
const MISSING = 'xx_YY.UTF-8'; // a language no computer has
const THIS_COMPUTER = new Set(['c', 'c.utf8', 'posix']); // the locales of a fresh cloud server

/** Every file and link under `root` → its hash and mode (a link: where it points). */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = `${(fs.statSync(p).mode & 0o777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort().map((k) => `${k in a ? (k in b ? 'changed' : 'removed') : 'added'} ${k}`);

const WRITES = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'symlinkSync', 'cpSync', 'chmodSync'];
const PWRITES = ['writeFile', 'appendFile', 'rename', 'mkdir', 'rm', 'unlink', 'copyFile', 'symlink', 'cp', 'chmod'];

/** Every program started and every write outside `root` meanwhile (also through fs/promises). */
function watch(root) {
  const seen = { programs: [], outside: [], sockets: [] };
  const orig = { cp: {}, fs: {}, fsp: {}, net: {} };
  for (const k of ['connect', 'createConnection']) {
    orig.net[k] = net[k];
    net[k] = function (...a) {
      const o = a[0] && typeof a[0] === 'object' ? a[0] : { port: a[0], host: a[1] };
      seen.sockets.push(o.path ? `unix ${o.path}` : `${o.host || 'localhost'}:${o.port}`);
      return orig.net[k].apply(this, a);
    };
  }
  const pathOf = (p) => (typeof p === 'string' ? p : p instanceof URL ? p.pathname : '');
  const note = (k, p) => {
    const s = pathOf(p);
    if (s && path.isAbsolute(s) && !(s === root || s.startsWith(root + path.sep))) seen.outside.push(`${k} ${s}`);
  };
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    orig.cp[k] = childProcess[k];
    childProcess[k] = function (file, args, ...rest) {
      seen.programs.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(' '));
      return orig.cp[k].call(this, file, args, ...rest);
    };
  }
  for (const k of WRITES) {
    orig.fs[k] = fs[k];
    fs[k] = function (p, ...rest) {
      note(k, p);
      return orig.fs[k].call(this, p, ...rest);
    };
  }
  for (const k of PWRITES) {
    orig.fsp[k] = fsp[k];
    fsp[k] = function (p, ...rest) {
      note(`promises.${k}`, p);
      return orig.fsp[k].call(this, p, ...rest);
    };
  }
  syncBuiltinESMExports();
  seen.stop = () => {
    Object.assign(childProcess, orig.cp);
    Object.assign(fs, orig.fs);
    Object.assign(fsp, orig.fsp);
    Object.assign(net, orig.net);
    syncBuiltinESMExports();
  };
  return seen;
}

/** A home as the last version left it. `server`: the settings still open to the network (an earlier set-up). */
async function lastVersionHome(name, { server }) {
  const w = tempWork(name);
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root)); // never the real workspace
  const bin = fakeBin(path.join(w.root, 'bin'), { claude: fakeClaude() });
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  // The shipped gateway's port: a free one of this test's, never its default, where a contributor's own gateway may
  // listen (a tick knocks on it to see whether it runs).
  const { freePort } = await import('../../src/machines/tunnels.mjs');
  const { SHIPPED } = await import('../../src/addons/gateways.mjs');
  const addons = Object.fromEntries(await Promise.all(SHIPPED.map(async (d) => [d.id, { port: await freePort() }])));
  saveConfig({ claudeBin: path.join(bin, 'claude'), usage: false, addons, router: { port: await freePort() }, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests'), ...(server ? { host: '0.0.0.0' } : {}) } });
  // The reason an earlier set-up over ssh saved: on the desktop too (a desktop seen never deletes it, server.mjs).
  fs.mkdirSync(process.env.HOPRIG_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'server.json'), '{"kind":"ssh"}\n');
  // The unit file the last version wrote: it carried the language the ssh client sent (locales not judged: null).
  const { unitText, unitDir, UNIT } = await import('../../src/server/service/systemd.mjs');
  const unitEnv = { PATH: '/usr/bin:/bin', LANG: MISSING, HOPRIG_CONFIG_DIR: process.env.HOPRIG_CONFIG_DIR, HOPRIG_STATE_DIR: process.env.HOPRIG_STATE_DIR }; // seal: written into a unit file as text, nothing is started with it
  const unit = path.join(unitDir({}), UNIT); // HOME is the temporary one: ~/.config/systemd/user
  assert.ok(unit.startsWith(w.home + path.sep), unit);
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, unitText({ node: '/usr/bin/node', bin: '/opt/hoprig/bin/hoprig.mjs', env: unitEnv, locales: null }));
  for (const f of ['.bashrc', '.profile']) fs.writeFileSync(path.join(w.home, f), '# the person\'s own\n');
  return { w, unit, unitEnv };
}

for (const kind of ['server', 'desktop']) {
  test(`after an update on a ${kind}: the start and three ticks change nothing outside the state folder, start no program of the computer, and keep the unit file and settings`, { timeout: 90_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
    const { w, unit, unitEnv } = await lastVersionHome(`afterupdate-${kind}`, { server: kind === 'server' });
    const state = process.env.HOPRIG_STATE_DIR;
    // The dashboard's other parts look at the computer on a tick (the add-ons' status asks a gateway program its
    // version; the operator's checks read the disks, processes and ports): here they find only the test's own
    // stand-ins and node, never a program of the computer that runs the tests.
    const pathBefore = process.env.PATH;
    process.env.PATH = sealedPath(pathWith(w.root, path.join(w.root, 'bin')));
    const rel = (p) => path.relative(w.root, p).split(path.sep).join('/');
    const stateRel = rel(state);
    // The service's environment, as the last version's unit gives it: the missing language included.
    const was = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    process.env.LANG = MISSING;
    delete process.env.LC_ALL;
    const before = snapshot(w.root);
    const unitBefore = fs.readFileSync(unit, 'utf8');
    const seen = watch(w.root);
    let app = null;
    t.after(async () => {
      seen.stop();
      if (app) await app.close().catch(() => {});
      for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      process.env.PATH = pathBefore;
      w.cleanup();
    });
    const { createServer } = await import('../../src/server/server.mjs');
    // What decides "server" (server.mjs), as the facts of this computer: no public address and no cloud hardware;
    // the server has no desktop session of this user, the desktop has one. The saved reason above does the rest.
    // Linux: only Linux is taken for a server (server.mjs), whatever computer runs the tests.
    const facts = { platform: 'linux', publicIps: [], dmi: {}, localDisplay: kind === 'desktop' };
    app = createServer({ loginCheck: true, serverFacts: facts, tmuxSocket: `afterupdate-${process.pid}` });
    // Never the settings' 0.0.0.0 in a test: it would open a port of this computer to its network.
    const { port } = await app.listen(0, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 6000)); // the start's own work, the first login check (5 s) included
    const auto = app.features.find((f) => f.name === 'automation').automation;
    for (let i = 0; i < 3; i++) {
      await app.watcher.tick();
      await auto.tick();
    }
    await new Promise((r) => setTimeout(r, 500));
    const running = snapshot(w.root);
    const byItself = { programs: [...seen.programs], outside: [...seen.outside], sockets: [...seen.sockets] };
    t.diagnostic(`${kind}: connections: ${JSON.stringify(byItself.sockets)}`);
    // Every connection goes to a port this test chose (its dashboard, the gateway's and the router's in its settings)
    // or to a socket inside its home: never to a port of the computer's own dashboard or gateway.
    const own = new Set([port, ...Object.values(JSON.parse(fs.readFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8')).addons).map((a) => a.port), JSON.parse(fs.readFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8')).router.port].map(String));
    assert.deepEqual(byItself.sockets.filter((s) => (s.startsWith('unix ') ? !s.slice(5).startsWith(w.root) && !s.slice(5).startsWith(os.tmpdir()) : !own.has(s.split(':').pop()))), [], byItself.sockets.join(' | '));

    const changed = changes(before, running);
    t.diagnostic(`${kind}: changed while running: ${JSON.stringify(changed)}`);
    t.diagnostic(`${kind}: programs started: ${JSON.stringify(byItself.programs)}`);
    assert.deepEqual(changed.filter((c) => !c.split(' ')[1].startsWith(`${stateRel}/`)), [], 'nothing outside the dashboard\'s state folder changed');
    // Inside it: the dashboard file (this work gave it the key of the local facts route), and what the dashboard's other
    // parts keep there at every start, as before this work (their tokens, the automation's records, the login check's
    // answer, the public link's switch). A file not on this list fails the test: a new one is seen and named.
    const KNOWN = ['dashboard.json', 'addons/link.json', 'assistant-token', 'automation/restore.json', 'automation/workspace.json', 'bypass-first-look.json', 'claude-login.json', 'cleaned-vscode', 'project-command-token', 'work-command-token'];
    assert.deepEqual(changed.filter((c) => !KNOWN.some((k) => c === `added ${stateRel}/${k}`)), [], 'inside it, only the files the dashboard keeps there came');
    assert.ok(changed.includes(`added ${stateRel}/dashboard.json`), 'the dashboard file came');
    assert.deepEqual(byItself.outside, [], 'no write outside the temporary home');
    // What was asked to start: the login check's stand-in of Claude Code (as `serve` always ran it), and the names the
    // other parts look for (found nowhere on this PATH). Nothing of this work: no systemctl, loginctl, sudo, locale or
    // npm, and nothing named by a full path outside the home.
    const { which } = await import('../../src/setup/system.mjs');
    const name = (p) => p.split(' ')[0];
    assert.deepEqual(byItself.programs.map(name).filter((n) => /(^|\/)(systemctl|loginctl|sudo|locale|npm|apt-get)$/.test(n)), [], byItself.programs.join(' | '));
    for (const n of byItself.programs.map(name)) {
      const found = path.isAbsolute(n) ? n : which(n, process.env, process.platform);
      assert.ok(!found || found.startsWith(w.root + path.sep), `${n}: only the test's own programs are found (${found})`);
    }

    // The unit file and the settings are the last version's: an update does not rewrite or close them by itself.
    assert.equal(fs.readFileSync(unit, 'utf8'), unitBefore);
    assert.match(unitBefore, new RegExp(`Environment="LANG=${MISSING.replace('.', '\\.')}"`));
    assert.equal(process.env.LANG, MISSING, 'the running service keeps the language its unit gave it');
    // ...only the next unit file set-up or `service install` writes drops it.
    const { unitText } = await import('../../src/server/service/systemd.mjs');
    assert.doesNotMatch(unitText({ env: unitEnv, locales: THIS_COMPUTER }), /LANG=/);
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8'));
    assert.equal(cfg.server.host, kind === 'server' ? '0.0.0.0' : undefined, 'the settings are as the last version left them');
    assert.equal(fs.readFileSync(path.join(state, 'server.json'), 'utf8'), '{"kind":"ssh"}\n', 'the saved reason stays, on the desktop too');

    // The dashboard file holds the key of the local facts route, for this user only.
    const file = path.join(state, 'dashboard.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const { key } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/local/facts`)).status, 404, 'no key: told nothing');
    assert.equal((await fetch(`${base}/api/local/facts`, { headers: { 'x-hoprig-local-key': 'x'.repeat(43) } })).status, 404, 'a wrong key: told nothing');
    const r = await fetch(`${base}/api/local/facts`, { headers: { 'x-hoprig-local-key': key } });
    assert.equal(r.status, 200);
    const f = await r.json();
    assert.deepEqual([f.host, f.port, f.pid, f.backend], ['127.0.0.1', port, process.pid, 'pty']);

    // The page, when opened: on the server it names the ways to reach it; on the desktop it does not count as one.
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-for-tests' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const view = await (await fetch(`${base}/api/settings`, { headers: { Origin: base, Cookie: cookie } })).json();
    if (kind === 'server') assert.match(view.network.server.why, /reached over ssh/);
    else assert.equal(view.network.server, undefined);
    const asked = changes(running, snapshot(w.root)).filter((c) => !c.endsWith('/dashboard.json'));
    t.diagnostic(`${kind}: changed by the requests: ${JSON.stringify(asked)}`);
    // A login (a person's act, not the start) keeps its session and notes the password's strength in the settings
    // (strength.mjs, as before this work); nothing else of the settings changes.
    assert.deepEqual(asked, ['changed config/config.json', `added ${stateRel}/web-sessions.json`]);
    const cfgAfter = JSON.parse(fs.readFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8'));
    const { passwordCheck, ...serverAfter } = cfgAfter.server;
    assert.ok(passwordCheck, 'the login noted the password\'s strength');
    assert.deepEqual({ ...cfgAfter, server: serverAfter }, cfg, 'the login changed nothing else of the settings');

    seen.stop();
    await app.close();
    app = null;
    const closed = changes(before, snapshot(w.root));
    t.diagnostic(`${kind}: changed after it stopped: ${JSON.stringify(closed)}`);
    assert.deepEqual(closed.filter((c) => !c.split(' ')[1].startsWith(`${stateRel}/`) && c !== 'changed config/config.json'), [], 'after it stopped: nothing outside the state folder but the login\'s note');
    assert.ok(!closed.includes(`added ${stateRel}/dashboard.json`), 'the dashboard file went with it');
    assert.equal(fs.readFileSync(unit, 'utf8'), unitBefore, 'the unit file is still the last version\'s');
  });
}
