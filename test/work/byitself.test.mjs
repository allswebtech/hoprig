// What Work's runs that end by themselves and its schedules do BY THEMSELVES in the real dashboard (createServer):
// - a home of the shape most owners have after an update (no schedule, Work items with no repeat and no run time,
//   the automations on as by default): the start and three ticks start nothing, commit nothing, call nothing outside
//   this computer, and write only the state files named here;
// - a home with one schedule as an earlier version saved it: it starts its session on this computer, as before;
// - the automations' tick starts what waits (the server's wiring of drain, src/automation/feature.mjs).
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempWork } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ALONE = path.join(HERE, 'fixtures', 'fake-alone.mjs');
const FAKE_CLAUDE = path.join(HERE, '..', 'automation', 'fixtures', 'fake-claude.mjs');
const posix = process.platform !== 'win32';

/** Every file under `root` (git's own files too) → a hash of its content. */
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

/** What the process does meanwhile: programs it starts, and connections that leave this computer. */
function watchProcess() {
  const seen = { programs: [], away: [] };
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
    if (!o.path && !/^(127\.|::1$|::ffff:127\.|localhost$)/.test(String(o.host || 'localhost'))) seen.away.push(`${o.host}:${o.port}`);
    return connect.apply(this, args);
  };
  seen.stop = () => {
    Object.assign(childProcess, orig);
    syncBuiltinESMExports();
    net.Socket.prototype.connect = connect;
  };
  return seen;
}

async function home(name, { automation } = {}) {
  const w = tempWork(name);
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root)); // a workspace of its own: never the real one
  const shop = path.join(w.projects, 'shop');
  w.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const claudeBin = path.join(w.root, 'fake-claude.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`, { mode: 0o755 });
  saveConfig({
    claudeBin, usage: false,
    server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') },
    work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
    ...(automation ? { automation } : {}),
  });
  writeProfile('sub', { label: 'Main', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  // two ordinary tasks: no repeat, no run time
  const { workStore } = await import('../../src/work/store.mjs');
  const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
  const { loadConfig } = await import('../../src/config.mjs');
  const store = () => workStore(resolvePlace(loadConfig()), { projects: projectNames() });
  for (const title of ['Fix the footer', 'Write the price list']) await store().add({ title, project: 'shop', note: 'DO:commit' });
  w.git(shop, 'add', '-A');
  w.git(shop, 'commit', '-q', '-m', 'Two tasks');
  w.git(shop, 'push', '-q');
  const ranFile = path.join(path.dirname(w.root), `${path.basename(w.root)}-ran.jsonl`);
  process.env.FAKE_ALONE_ARGS = ranFile; // outside the home: written only when a run's coding tool starts
  return { w, shop, store, ranFile };
}

async function serve(opts = {}) {
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({
    watch: false, dashboardFile: false, tmuxSocket: `byitself-${process.pid}`,
    work: { alone: { command: { command: process.execPath, args: [FAKE_ALONE] }, resolveEnv: async () => ({ ...process.env }), minuteMs: 600 } },
    ...opts,
  });
  await app.listen(0, '127.0.0.1');
  const auto = () => app.features.find((f) => f.name === 'automation').automation;
  return { app, tick: () => auto().tick() };
}

const WORK_WRITES = /^(home\/Workspace\/projects\/shop\/docs\/plans\/|server\/)/;

test('a home with no schedule and Work items with no run time: the start and three ticks start nothing, commit nothing, call nothing away, and write only the state files named', { timeout: 60_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const { w, shop, ranFile } = await home('byitself-quiet');
  const before = snapshot(w.root);
  const refs = w.git(shop, 'for-each-ref', '--format=%(refname) %(objectname)');
  const seen = watchProcess();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    fs.rmSync(ranFile, { force: true });
    w.cleanup();
  });
  const s = await serve();
  app = s.app;
  await new Promise((r) => setTimeout(r, 1500)); // the start of Work's runner (settle what was left, drain) is done
  for (let i = 0; i < 3; i++) await s.tick();
  await new Promise((r) => setTimeout(r, 500));
  const after = snapshot(w.root);
  const sessions = await app.backend.list();
  // Another program's part of Work (no Work token, no webhook, the default): no timer of its deliveries.
  const hooksRunning = app.features.find((f) => f.name === 'work').hooks.running();
  await app.close();
  app = null;
  const closed = snapshot(w.root);
  seen.stop();
  assert.equal(hooksRunning, false, 'no webhook: the deliveries look at nothing');
  assert.ok(!Object.keys(after).some((f) => /^(config\/work-access\.json|state\/work-token-use\.json)$/.test(f)), 'no Work token or webhook file written');

  assert.deepEqual(sessions, [], 'no session started');
  assert.equal(fs.existsSync(ranFile), false, 'no run that ends by itself started');
  assert.equal(w.git(shop, 'for-each-ref', '--format=%(refname) %(objectname)'), refs, 'no commit, no branch, no tag');
  assert.deepEqual(w.git(shop, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'no worktree');
  assert.deepEqual(seen.away, [], 'no connection away from this computer');
  const coding = seen.programs.filter((p) => p.some((a) => a.includes('fake-claude') || a.includes('fake-alone')));
  assert.deepEqual(coding, [], 'no coding tool started');
  const gitWrites = seen.programs.filter((p) => /(^|\/)git$/.test(p[0]) && p.some((a) => /^(commit|push|fetch|pull|merge|worktree|update-ref|checkout|switch|reset|branch|tag)$/.test(a)));
  assert.deepEqual(gitWrites, [], 'no git command that changes or sends anything');
  const changed = changes(before, after);
  assert.deepEqual(changed.filter((f) => WORK_WRITES.test(f)), [], 'nothing of Work\'s files or the git server changed');
  if (process.env.BYITSELF_CHANGES) fs.writeFileSync(process.env.BYITSELF_CHANGES, `${JSON.stringify({ changed, programs: seen.programs }, null, 1)}\n`);
  assert.ok(seen.programs.some((p) => /(^|\/)git$/.test(p[0])), 'the watch sees the programs started (git reads the Work file\'s place)');
  // The state files a start writes, each by the feature named; the same list as a dashboard without Work's runs by
  // themselves and its schedules writes (compared on a build before Work's runs by themselves came in).
  assert.deepEqual(changed, [
    'state/addons/link.json', // Settings → Add-ons
    'state/assistant-token', // Tia's own token
    'state/automation/restore.json', // the automations' restore
    'state/automation/workspace.json', // the automations' workspace care
    'state/bypass-first-look.json', // Settings → Allow bypass permissions mode
    'state/cleaned-vscode', // the code editor's one-time cleanup
    'state/project-command-token', // New project's command
    'state/work-command-token', // `hoprig tasks do` (Work)
    'state/work-writer', // Work's computer id (random): the one file of Work's runs by themselves, read by the tick's run-time check
  ].filter((f) => changed.includes(f)), 'only these state files');
  assert.ok(!changed.some((f) => /^state\/(work-alone|work-trees)(\/|$)/.test(f) || f === 'state/automation/items.json'), 'nothing of the runs that end by themselves');
  // the stop only takes back the tokens it gave out (Work's command, New project's command, Tia's)
  assert.deepEqual(changes(after, closed).filter((f) => !/^state\/(work-command|project-command|assistant)-token$/.test(f)), [], 'the stop writes nothing more');
});

// A schedule as the released version saved it (its cleanSchedule: id, label, enabled, when, action, since; no
// computer, no run by itself).
test('a home with one schedule saved by an earlier version: at its time it starts its session on this computer, as before, and nothing of the runs by themselves', { timeout: 90_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const at = new Date(Date.now() + 120_000);
  at.setSeconds(0, 0);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const { w, shop, ranFile } = await home('byitself-old');
  const old = { id: 'lq3x7k2abc12', label: 'Nightly check', enabled: true, when: { kind: 'daily', time: hhmm }, action: { type: 'start', dir: shop, profile: 'sub', prompt: 'scheduled hello' }, since: Date.now() - 3_600_000 };
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  saveConfig({ ...loadConfig(), automation: { schedules: { list: [old] } } });
  const seen = watchProcess();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    fs.rmSync(ranFile, { force: true });
    w.cleanup();
  });
  const s = await serve({ automation: { now } });
  app = s.app;
  await s.tick();
  assert.deepEqual(await app.backend.list(), [], 'not before its time');
  offset += at.getTime() - Date.now() + 5_000;
  await s.tick();
  const end = Date.now() + 20_000;
  let list = [];
  while (Date.now() < end && !(list = await app.backend.list()).length) await new Promise((r) => setTimeout(r, 200));
  assert.equal(list.length, 1, 'its session started here');
  const log = fs.readFileSync(path.join(w.root, 'state', 'automation.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.automation === 'schedules' && /started "Nightly check"/.test(e.did) && e.outcome === 'ok'), JSON.stringify(log));
  assert.equal(log.some((e) => /not run|missed|cannot be reached/.test(`${e.did} ${e.outcome}`)), false);
  assert.equal(readCfgSchedule(loadConfig()).computer, undefined, 'the schedule is kept as it was: no computer added');
  assert.equal(fs.existsSync(path.join(w.root, 'state', 'work-alone', 'waiting.json')), false, 'nothing waits');
  assert.equal(fs.existsSync(path.join(w.root, 'state', 'work-trees')), false, 'no worktree');
  assert.equal(fs.existsSync(ranFile), false, 'no run by itself');
  assert.deepEqual(seen.away, [], 'no connection away from this computer');
});
const readCfgSchedule = (c) => c.automation.schedules.list[0];

test('the automations\' tick in the real dashboard starts what waits (Work\'s drain is wired to the runner)', { timeout: 60_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const { w, ranFile } = await home('byitself-drain');
  let app = null;
  t.after(async () => {
    if (app) await app.close().catch(() => {});
    fs.rmSync(ranFile, { force: true });
    w.cleanup();
  });
  const s = await serve();
  app = s.app;
  await new Promise((r) => setTimeout(r, 1000)); // the runner's own start (it drains once) is over
  const id = 'fix-the-footer';
  const file = path.join(w.root, 'state', 'work-alone', 'waiting.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify([{ key: id, job: { item: id, provider: 'sub', by: 'owner' }, at: new Date().toISOString(), why: 'another run of shop works now' }])}\n`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(ranFile), false, 'nothing starts it but the tick');
  await s.tick();
  const end = Date.now() + 10_000;
  while (Date.now() < end && !fs.existsSync(ranFile)) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(ranFile), 'the tick started the waiting run');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [], 'and took it off the list');
});

// What Work tells by itself (src/work/tell.mjs) after an update: today's config (a push address, no events list) gets
// none of it, and its ticks write, start and send nothing; with one item turned on the ticks read files only (no
// program starts) and write the one ledger file. The receiver is this test's own, on a port of this computer.
test('Work\'s notifications after an update: today\'s push config gets none, and its ticks start no program; one item on writes only the ledger', { timeout: 90_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const http = await import('node:http');
  const got = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      got.push(req.headers.title || '');
      res.end('ok');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/t`;
  const { w, ranFile } = await home('byitself-tell');
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  saveConfig({ ...loadConfig(), server: { ...loadConfig().server, notify: { url } } });
  const seen = watchProcess();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    await new Promise((r) => srv.close(r));
    fs.rmSync(ranFile, { force: true });
    w.cleanup();
  });
  const before = snapshot(w.root);
  const s = await serve();
  app = s.app;
  const tell = app.features.find((f) => f.name === 'work').tell;
  await new Promise((r) => setTimeout(r, 2500)); // the teller's own first look (2 s after the start) is over
  const startPrograms = seen.programs.length;
  for (let i = 0; i < 3; i++) {
    await s.tick();
    assert.deepEqual(await tell.tick(), { off: true }, 'everything of it is off');
  }
  assert.deepEqual(got, [], 'nothing sent');
  const ledger = path.join(w.root, 'state', 'work-told.json');
  assert.equal(fs.existsSync(ledger), false, 'no ledger written');
  assert.deepEqual(changes(before, snapshot(w.root)).filter((f) => /work-told|language-sample/.test(f)), []);
  // One item on: the ticks read the runs, the session records and the workflows (files) and write the ledger.
  saveConfig({ ...loadConfig(), server: { ...loadConfig().server, notify: { url, work: { finished: true } } } });
  const mark = seen.programs.length;
  for (let i = 0; i < 3; i++) await tell.tick();
  assert.deepEqual(seen.programs.slice(mark), [], 'reading progress starts no program');
  assert.ok(startPrograms >= 0);
  assert.deepEqual(got, [], 'nothing new to tell: nothing sent');
  assert.ok(fs.existsSync(ledger), 'the ledger is its one file');
  const all = changes(before, snapshot(w.root));
  assert.deepEqual(all.filter((f) => /^state\/work-(told|told\.json\.)/.test(f) || f === 'state/work-told.json'), ['state/work-told.json']);
  assert.deepEqual(seen.away, [], 'no connection away from this computer');
});
