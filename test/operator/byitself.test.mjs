// What the Operator does BY ITSELF in the real dashboard (createServer), with default settings, Tia off and the panel
// never opened: a start and three ticks of the dashboard's watcher, each tick a minute and more apart (the slow checks
// run at most once a minute, git once in five). It says what runs, what it starts, what it writes, and what one round
// costs; then the same with the panel open (its first look and a look every 15 s).
//
// Set OPERATOR_BYITSELF=<file> to have the measured figures written there.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from '../work/helpers.mjs';

const posix = process.platform !== 'win32';

/** Every file under `root` → a hash of its content. */
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

/** The programs the process starts and the connections it opens (local and away). */
function watchProcess() {
  const seen = { programs: [], local: [], away: [] };
  const orig = {};
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    orig[k] = childProcess[k];
    childProcess[k] = function (file, args, ...rest) {
      seen.programs.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])]);
      return orig[k].call(this, file, args, ...rest);
    };
  }
  syncBuiltinESMExports();
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const a = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o = a && typeof a === 'object' ? a : { port: a, host: typeof args[1] === 'string' ? args[1] : undefined };
    if (!o.path) (/^(127\.|::1$|::ffff:127\.|localhost$)/.test(String(o.host || 'localhost')) ? seen.local : seen.away).push(`${o.host || 'localhost'}:${o.port}`);
    return connect.apply(this, args);
  };
  seen.stop = () => {
    Object.assign(childProcess, orig);
    syncBuiltinESMExports();
    net.Socket.prototype.connect = connect;
  };
  return seen;
}

// A program as its name and its first word that is not an option or a config pair (git -c x=y status → "git status").
const name = (p) => {
  const words = p.slice(1).filter((a, i, all) => !a.startsWith('-') && !/=/.test(a) && all[i - 1] !== '-L' && all[i - 1] !== '-C');
  return [path.basename(p[0]), ...words.slice(0, 1)].join(' ');
};

test('with the panel never opened and Tia off, the Operator\'s checks run on the dashboard\'s tick: what they start, write and cost; with the panel open, a look starts nothing', { timeout: 90_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  // A gateway program installed on this computer is not this test's: its folder leaves PATH, so nothing knocks on it.
  const PATH = process.env.PATH;
  process.env.PATH = PATH.split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'trouteai'))).join(path.delimiter);
  t.after(() => { process.env.PATH = PATH; });
  const w = tempWork('operator-byitself');
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root));
  const shop = path.join(w.projects, 'shop');
  w.repo(shop);
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  // The shipped gateway's port is set to one of this test's own: its status knocks on that port, never on a gateway
  // that runs on this computer for real.
  saveConfig({ claudeBin: path.join(w.root, 'no-claude'), usage: false, addons: { trouteai: { port: 8092 } }, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') } });
  let offset = 0;
  const now = () => Date.now() + offset;
  const before = snapshot(w.root);
  const seen = watchProcess();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `op-byitself-${process.pid}`, operator: { now } });
  await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500)); // what the start itself does is over
  const atStart = seen.programs.length;

  // The Operator's own listener on the tick, timed apart from the other features'.
  const listeners = [...app.watcher.tickListeners];
  const mine = listeners.filter((fn) => /own\.tick\(\)/.test(String(fn)));
  assert.equal(mine.length, 1, 'the Operator listens to the tick even with the panel never opened');
  const rounds = [];
  app.watcher.tickListeners.delete(mine[0]);
  app.watcher.onTick(async (cards) => {
    const from = seen.programs.length;
    const local = seen.local.length;
    const t0 = performance.now();
    await mine[0](cards);
    rounds.push({ ms: Math.round(performance.now() - t0), programs: seen.programs.slice(from).map(name), connections: seen.local.slice(local) });
  });
  for (let i = 0; i < 3; i++) {
    await app.watcher.tick();
    offset += 5 * 60_000 + 1000; // the next tick comes after every check's wait, git's too
  }
  const quiet = snapshot(w.root);

  // The panel open: its first look (look=1), then a look every 15 s; each one is a board from what the checks hold.
  const op = app.features.find((f) => f.name === 'operator');
  const [, , listRoute] = op.routes.find(([m, re]) => m === 'GET' && re.test('/api/operator/attention'));
  const req = (url) => ({ url, socket: { localPort: app.server.address().port, localAddress: '127.0.0.1' } });
  const looks = [];
  for (const url of ['/api/operator/attention?look=1', '/api/operator/attention', '/api/operator/attention']) {
    const from = seen.programs.length;
    const t0 = performance.now();
    const r = await listRoute(req(url));
    looks.push({ url, ms: Math.round(performance.now() - t0), programs: seen.programs.slice(from).map(name), items: r.count });
    offset += 15_000;
  }
  const open = snapshot(w.root);
  await app.close();
  app = null;
  seen.stop();

  const figures = {
    startPrograms: seen.programs.slice(0, atStart).map(name),
    rounds,
    looks,
    homeChangesWhileClosed: changes(before, quiet),
    writesWhileClosed: changes(before, quiet).filter((f) => f.startsWith('state/operator')),
    writesOfThePanel: changes(quiet, open),
    away: seen.away,
  };
  if (process.env.OPERATOR_BYITSELF) fs.writeFileSync(process.env.OPERATOR_BYITSELF, `${JSON.stringify(figures, null, 1)}\n`);

  // Nobody looks: each tick a round of the checks. They read and start programs; they never write, never call a
  // model, never connect away from this computer.
  assert.equal(rounds.length, 3);
  for (const r of rounds) {
    assert.ok(r.programs.some((p) => /^git /.test(p)), `git reads the repositories: ${r.programs}`);
    const bases = r.programs.map((p) => p.split(' ')[0]);
    // The machine check reads the platform's own programs: macOS has netstat and lsof where Linux has ss.
    const machine = process.platform === 'darwin' ? ['ps', 'df', 'netstat', 'lsof'] : ['ps', 'df', 'ss'];
    assert.ok(machine.every((b) => bases.includes(b)), `the machine check: ${r.programs}`);
    assert.ok(!r.programs.some((p) => /claude|codex|opencode|node/.test(p)), `no coding tool or model: ${r.programs}`);
    assert.ok(!r.programs.some((p) => /^git (fetch|pull|push|commit|merge|checkout|reset)/.test(p)), `no git that changes or sends: ${r.programs}`);
  }
  assert.deepEqual(figures.writesWhileClosed, [], 'the checks write nothing');
  assert.deepEqual(figures.homeChangesWhileClosed.filter((f) => !f.startsWith('state/')), [], 'nothing in the home, the workspace or the git server changed');
  assert.deepEqual(seen.away, [], 'no connection away from this computer');
  for (const r of rounds) assert.ok(!r.connections.includes('127.0.0.1:20017'), `no knock on a real gateway: ${r.connections}`);
  // The panel open: a look starts no program (it reads what the checks hold) and writes only its look time.
  for (const l of looks) assert.deepEqual(l.programs, [], `${l.url} starts nothing`);
  assert.deepEqual(figures.writesOfThePanel, ['state/operator/looks.json'], 'the first look writes its time, nothing else');
  // Everything of the reflexes is off after an install: no record of them, no lock, nothing of theirs written.
  assert.ok(!Object.keys({ ...quiet, ...open }).some((f) => /state\/operator\/reflex/.test(f)), 'no record and no lock of the reflexes');
});

test('with one rule on (the leftover rule, nothing left over): what a round of the rules costs on top of the checks', { timeout: 90_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const PATH = process.env.PATH;
  process.env.PATH = PATH.split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'trouteai'))).join(path.delimiter);
  t.after(() => { process.env.PATH = PATH; });
  const w = tempWork('operator-onerule');
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ claudeBin: path.join(w.root, 'no-claude'), usage: false, addons: { trouteai: { port: 8093 } }, assistant: { enabled: true }, operator: { acts: true, rules: { leftover: true } }, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') } });
  let offset = 0;
  const now = () => Date.now() + offset;
  const seen = watchProcess();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  // Nothing of this computer counts as left over for this test: its rule never ends what another program runs.
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `op-onerule-${process.pid}`, operator: { now, keepLeftover: () => false } });
  await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const before = snapshot(w.root);
  const op = app.features.find((f) => f.name === 'operator');
  const rounds = [];
  for (let i = 0; i < 3; i++) {
    const from = seen.programs.length;
    const t0 = performance.now();
    const r = await op.reflex.round();
    rounds.push({ ms: Math.round(performance.now() - t0), programs: seen.programs.slice(from).map(name), acted: r.acted });
    offset += 60_000;
  }
  const after = snapshot(w.root);
  if (process.env.OPERATOR_ONERULE) fs.writeFileSync(process.env.OPERATOR_ONERULE, `${JSON.stringify({ rounds, writes: changes(before, after) }, null, 1)}\n`);
  for (const r of rounds) {
    assert.equal(r.acted, 0);
    assert.deepEqual(r.programs, [], `a round reads what the checks hold and starts nothing: ${r.programs}`);
  }
  assert.deepEqual(changes(before, after), [], 'a round with nothing to do writes nothing');
  assert.deepEqual(seen.away, []);
});
