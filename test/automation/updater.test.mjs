// Settings → Updates on the server: the updater (rows, Check now, Update now, Update all, one at a time, the log),
// the rules of each real item (with stand-ins for git, npm and the add-on), the routes, and the old Claude-only
// setting read once into the new one. Nothing here installs, downloads or asks a server anything.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAutomation } from '../../src/automation/index.mjs';
import { automationFeature } from '../../src/automation/feature.mjs';
import { gitFacts, hoprigItem, publicLinkState, toolItem, toolOf, tunnelItem } from '../../src/automation/updateitems.mjs';
import { readSwitch } from '../../src/addons/linkswitch.mjs';
import { INFO_TTL_MS, createUpdater } from '../../src/automation/updater.mjs';
import { claude, fakeCtx, fakeDeck, fakeItem, tmpDir } from './helpers.mjs';

const newer = (o = {}) => ({ installed: '1.0.0', latest: '1.1.0', method: 'test', updateAvailable: true, canUpdate: true, ...o });
const settle = async (u) => {
  for (let i = 0; i < 100; i++) {
    const l = u.log(0);
    if (!l.running) return l;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the update did not end');
};

function make(items, { cards = [], cfg = {} } = {}) {
  let config = cfg;
  let clock = 1_000_000;
  const rec = [];
  const u = createUpdater({ items, cards: async () => cards, config: () => config, saveConfig: (p) => (config = { ...config, ...p }), record: (e) => rec.push(e), now: () => clock });
  return { u, rec, config: () => config, tick: (ms) => (clock += ms) };
}

test('the rows: installed, newest, what the button does, and why it must wait', async () => {
  const items = [
    fakeItem('hoprig', { info: newer({ canUpdate: false, why: 'update it with git yourself' }) }),
    fakeItem('claude', { info: newer() }),
    fakeItem('codex', { installable: true, info: { installed: null, latest: '0.169.0', updateAvailable: false, canUpdate: true } }),
    fakeItem('opencode', { info: newer(), blocked: () => '1 OpenCode session open: close it first' }),
    fakeItem('cloudflared', { info: newer({ updateAvailable: false, latest: '1.0.0' }) }),
    fakeItem('broken', { fail: 'offline' }),
  ];
  const { u } = make(items);
  const v = await u.view();
  assert.deepEqual({ mode: v.mode, notify: v.notify, running: v.running }, { mode: 'manual', notify: false, running: null }, 'Manual by default');
  const by = Object.fromEntries(v.items.map((r) => [r.id, r]));
  assert.equal(by.hoprig.action, null);
  assert.equal(by.hoprig.why, 'update it with git yourself');
  assert.equal(by.claude.action, 'update');
  assert.equal(by.codex.action, 'install', 'a missing coding tool can be installed from its row');
  assert.equal(by.opencode.blocked, '1 OpenCode session open: close it first');
  assert.equal(by.cloudflared.action, null, 'up to date: nothing to press');
  assert.equal(by.broken.error, 'offline');
  assert.equal(by.broken.action, null);
});

test('facts are kept 10 minutes; Check now looks again (one item or all)', async () => {
  const a = fakeItem('a', { info: newer() });
  const b = fakeItem('b', { info: newer() });
  const { u, tick } = make([a, b]);
  await u.view();
  await u.view();
  assert.deepEqual([a.calls.info, b.calls.info], [1, 1]);
  await u.view({ fresh: true, id: 'a' });
  assert.deepEqual([a.calls.info, b.calls.info], [2, 1], 'only the one asked for');
  assert.deepEqual([a.calls.fresh, b.calls.fresh], [1, 0], 'Check now tells the item to look past its own caches');
  tick(INFO_TTL_MS);
  await u.view();
  assert.deepEqual([a.calls.info, b.calls.info], [3, 2]);
  await assert.rejects(u.view({ fresh: true, id: 'nope' }), (e) => e.status === 404);
});

test('Update now: one at a time, refused with the reason when it must wait, the output in one log', async () => {
  let release;
  const slow = fakeItem('claude', { info: newer(), update: () => new Promise((r) => (release = () => r({ ok: true, version: '1.1.0' }))) });
  const open = fakeItem('codex', { info: newer(), blocked: () => '1 Codex session open: close it first' });
  const fresh = fakeItem('opencode', { info: newer({ updateAvailable: false, latest: '1.0.0' }) });
  const { u, rec } = make([slow, open, fresh]);
  await assert.rejects(u.start('codex'), (e) => e.status === 409 && /close it first/.test(e.message));
  await assert.rejects(u.start('opencode'), (e) => e.status === 409 && /up to date/.test(e.message));
  await assert.rejects(u.start('zzz'), (e) => e.status === 404);
  assert.deepEqual(await u.start('claude'), { started: true, ids: ['claude'], skipped: [] });
  await assert.rejects(u.start('claude'), (e) => e.status === 409 && /already running/.test(e.message));
  assert.equal((await u.view()).running, 'claude');
  release();
  const l = await settle(u);
  assert.deepEqual(l.lines, ['--- claude ---', 'updating claude']);
  assert.equal(l.results.claude.ok, true);
  assert.equal(u.log(1).lines.length, 1, 'read from a line on');
  const row = (await u.view()).items.find((r) => r.id === 'claude');
  assert.equal(row.last.version, '1.1.0');
  assert.equal(slow.calls.info, 2, 'looked again after the update');
  assert.match(rec[0].outcome, /ok: now 1\.1\.0/);
});

test('two presses at once (a double click, two pages, the automatic rule) start one update, not two', async () => {
  let active = 0;
  let most = 0;
  const item = fakeItem('codex', { info: newer(), update: async () => { active++; most = Math.max(most, active); await new Promise((r) => setTimeout(r, 30)); active--; return { ok: true, version: '1.1.0' }; } });
  const { u } = make([item]);
  const tries = await Promise.allSettled([u.start('codex'), u.start('codex'), u.start('all'), u.auto('codex')]);
  assert.equal(tries.filter((t) => t.status === 'fulfilled' && t.value.started).length, 1);
  assert.ok(tries.slice(1, 3).every((t) => t.status === 'rejected' && t.reason.status === 409));
  assert.match(tries[3].value.waited, /another update is running/);
  await settle(u);
  assert.equal(item.calls.update, 1);
  assert.equal(most, 1);
});

test('Update all leaves a git checkout of Hoprig out; Automatic tells about what it does not install', async () => {
  const items = [fakeItem('hoprig', { info: newer({ notInAll: 'a git checkout is updated on its own (Update now on its card)' }), autoOk: () => false }), fakeItem('claude', { info: newer() })];
  const { u } = make(items);
  const r = await u.start('all');
  assert.deepEqual(r, { started: true, ids: ['claude'], skipped: [{ id: 'hoprig', why: 'a git checkout is updated on its own (Update now on its card)' }] });
  await settle(u);
  const { afterCheck } = await import('../../src/automation/updates.mjs');
  const rows = [{ id: 'hoprig', title: 'Hoprig', installed: '0.1.0', latest: '0.2.0', updateAvailable: true, canUpdate: true, auto: false }];
  const a = afterCheck({ rows, settings: { mode: 'auto', notify: false }, data: {} });
  assert.deepEqual(a.actions.map((x) => x.type), ['tell'], 'Automatic does not install Hoprig: it tells, once');
  assert.deepEqual(afterCheck({ rows, settings: { mode: 'auto', notify: false }, data: a.data }).actions, []);
  assert.deepEqual(afterCheck({ rows, settings: { mode: 'manual', notify: false }, data: {} }).actions, [], 'Manual without notify: nothing');
});

test('Update all: every installed item with a newer version that may go now; the others are said, nothing is installed', async () => {
  const items = [
    fakeItem('claude', { info: newer() }),
    fakeItem('codex', { info: newer(), blocked: () => 'open' }),
    fakeItem('opencode', { installable: true, info: { installed: null, latest: '2.3.0', canUpdate: true } }),
    fakeItem('cloudflared', { info: newer(), update: () => ({ ok: false, output: 'download failed\nHTTP 404' }) }),
  ];
  const { u } = make(items);
  const r = await u.start('all');
  assert.deepEqual(r, { started: true, ids: ['claude', 'cloudflared'], skipped: [{ id: 'codex', why: 'open' }] });
  const l = await settle(u);
  assert.equal(l.results.cloudflared.error, 'HTTP 404');
  assert.equal(items[2].calls.update, 0, 'Update all never installs');
  const none = make([fakeItem('x')]);
  assert.deepEqual(await none.u.start('all'), { started: false, ids: [], skipped: [] });
});

test('the settings are checked and saved under "updates"', () => {
  const { u, config } = make([]);
  assert.deepEqual(u.changeSettings({ mode: 'auto' }), { mode: 'auto', notify: false });
  assert.deepEqual(config().updates, { mode: 'auto', notify: false });
  assert.throws(() => u.changeSettings({ mode: 'yes' }), /"manual" or "auto"/);
});

// ---- the real items, with stand-ins ----

test('cards belong to a coding tool by their "tool", older ones to Claude Code', () => {
  assert.equal(toolOf({ kind: 'claude' }), 'claude');
  assert.equal(toolOf({ kind: 'chat' }), 'claude');
  assert.equal(toolOf({ kind: 'claude', tool: 'codex' }), 'codex');
  assert.equal(toolOf({ kind: 'opencode' }), 'opencode');
  assert.equal(toolOf({ kind: 'shell' }), null);
});

test('a coding tool: Claude Code waits only for working sessions; Codex and OpenCode for any open one', () => {
  const tool = (id, whenRunning) => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code', managed: id !== 'claude', pin: '1', updateItem: { whenRunning }, installedVersion: () => '1' });
  const cc = toolItem('claude', { tool: tool('claude', 'keeps-copy') });
  let outside = [];
  const cx = toolItem('codex', { tool: tool('codex', 'wait-until-none'), runs: () => outside });
  const idle = [claude('a', { status: 'waiting' })];
  const busy = [claude('a', { status: 'working' })];
  const codexOpen = [{ name: 'c', kind: 'codex', tool: 'codex', status: 'waiting' }];
  assert.equal(cc.blocked(busy), null, 'Update now: a running Claude Code keeps its copy');
  assert.equal(cc.autoBlocked(idle), null);
  assert.match(cc.autoBlocked(busy), /1 working Claude Code session/);
  // A chat runs Claude Code too: its turn, or only a background task (its card then says "working"), holds it back.
  const chatAt = (status, background = false) => ({ name: 'chat:c1', kind: 'chat', chatId: 'c1', status, background });
  assert.match(cc.autoBlocked([chatAt('working', true)]), /1 working Claude Code session/);
  assert.match(cc.autoBlocked([...busy, chatAt('working')]), /2 working Claude Code sessions/);
  assert.equal(cc.autoBlocked([chatAt('waiting')]), null);
  assert.equal(cx.blocked([chatAt('working')]), null, 'a chat does not hold Codex back');
  assert.equal(cx.blocked(busy), null, 'Claude sessions do not hold Codex back');
  assert.match(cx.blocked(codexOpen), /1 Codex session open: close it first/);
  // A session started with `hoprig codex` in a terminal the dashboard does not hold has no card, only a run record.
  outside = [{ runId: 'r1', tool: 'codex' }, { runId: 'r2', tool: 'codex' }];
  assert.match(cx.blocked([]), /2 Codex sessions open: close them first/);
  assert.match(cx.whenRunning, /Close its sessions first/);
  assert.match(cc.whenRunning, /keep the version they started with/);
});

test('a coding tool that is missing is installed by its row; one that is there is updated', async () => {
  const did = [];
  let have = null;
  const t = { id: 'codex', name: 'Codex', managed: true, pin: '0.169.0', updateItem: { whenRunning: 'wait-until-none' }, installedVersion: () => have, install: async () => (did.push('install'), { ok: true }), update: async () => (did.push('update'), { ok: true }), info: async () => ({ installed: have, latest: '0.169.0', method: 'hoprig' }) };
  const on = [];
  let why = null;
  const it = toolItem('codex', { tool: t, turnOn: (id) => on.push(id), readyToReplace: async () => why });
  assert.equal((await it.info()).method, "Hoprig's tools folder");
  assert.match((await it.info()).note, /Installs 0\.169\.0, the version this Hoprig is tested with/);
  await it.update();
  have = '0.169.0';
  await it.update();
  assert.deepEqual(did, ['install', 'update']);
  assert.deepEqual(on, ['codex'], 'installing turns it on');
  // Its server still in use (or a session the cards did not show): npm does not run.
  why = 'Codex\'s server is still in use: try again when its sessions have ended';
  const lines = [];
  const r = await it.update({ onLine: (l) => lines.push(l) });
  assert.deepEqual([r.ok, did.length], [false, 2]);
  assert.match(lines[0], /server is still in use.*Nothing changed/);
  assert.equal(it.autoOk({ installed: null }), false, 'Automatic never installs');
});

test('Hoprig from a git checkout: read with ls-remote only, never updated by itself', async () => {
  const calls = [];
  const HEAD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);
  // The command after "-C <folder>" (a read through the reader has its fixed settings before it, and a status its
  // --ignore-submodules); the reader's list of the folder's own settings answers "none".
  const run = (answers) => async (argv) => {
    const cmd = argv.slice(argv.indexOf('-C') + 2).filter((a) => a !== '--ignore-submodules=dirty').join(' ');
    if (cmd.startsWith('config --includes')) return { ok: true, code: 0, stdout: '' };
    calls.push(cmd);
    const k = Object.keys(answers).find((p) => cmd.startsWith(p));
    return k ? answers[k] : { ok: false, code: 1, stdout: '' };
  };
  const base = { 'rev-parse HEAD': { ok: true, code: 0, stdout: `${HEAD}\n` }, 'rev-parse --abbrev-ref': { ok: true, code: 0, stdout: 'origin/main\n' } };
  let f = await gitFacts('/app', run({ ...base, 'ls-remote': { ok: true, code: 0, stdout: `${HEAD}\trefs/heads/main\n` } }));
  assert.equal(f.newer, false);
  f = await gitFacts('/app', run({ ...base, 'ls-remote': { ok: true, code: 0, stdout: `${NEW}\trefs/heads/main\n` }, 'merge-base': { ok: false, code: 1 } }));
  assert.equal(f.newer, true);
  f = await gitFacts('/app', run({ ...base, 'ls-remote': { ok: true, code: 0, stdout: `${NEW}\trefs/heads/main\n` }, 'merge-base': { ok: true, code: 0 } }));
  assert.equal(f.newer, false, 'already in this checkout: it is ahead');
  f = await gitFacts('/app', run({ 'rev-parse HEAD': base['rev-parse HEAD'] }));
  assert.deepEqual([f.upstream, f.newer], [null, null]);
  assert.ok(calls.every((c) => !/^(fetch|pull)/.test(c)), 'never fetches or pulls to look');

  const deps = (kind, answers, newest = { version: '0.2.0', note: null }) => ({
    run: run(answers),
    selfupdate: { installKind: () => kind, newestVersion: async () => newest, updatePlan: () => [] },
    checks: { appRoot: () => '/app', appVersion: () => '0.1.0' },
  });
  const git = hoprigItem(deps('git', { ...base, 'ls-remote': { ok: true, code: 0, stdout: `${NEW}\trefs/heads/main\n` }, 'merge-base': { ok: false, code: 1 } }));
  const gi = await git.info();
  assert.deepEqual({ installed: gi.installed, latest: gi.latest, updateAvailable: gi.updateAvailable, canUpdate: gi.canUpdate }, { installed: '0.1.0 (aaaaaaa)', latest: 'newer commits on origin/main', updateAvailable: true, canUpdate: true });
  assert.equal(git.autoOk(gi), false, 'a git checkout never updates by itself');
  const noUp = await hoprigItem(deps('git', { 'rev-parse HEAD': base['rev-parse HEAD'] })).info();
  assert.equal(noUp.canUpdate, false);
  assert.match(noUp.why, /with git yourself/);
  const npm = hoprigItem(deps('npm', {}));
  const ni = await npm.info();
  assert.deepEqual([ni.latest, ni.updateAvailable, npm.autoOk(ni)], ['0.2.0', true, false], 'not even from npm: a running dashboard needs a restart for it');
  assert.equal(npm.blocked([claude('a', { status: 'working' })]), null, 'Update now is the owner\'s choice');
  // The same version and an older one are not updates; a version that could not be read is unknown, with its note.
  for (const [v, avail] of [['0.1.0', false], ['0.0.1', false], ['0.1.1', true]]) {
    const i = await hoprigItem(deps('npm', {}, { version: v, note: null })).info();
    assert.deepEqual([i.latest, i.updateAvailable, i.note], [v, avail, null], v);
  }
  const unread = await hoprigItem(deps('npm', {}, { version: null, note: 'The newest version could not be read from example.com (it could not be reached).' })).info();
  assert.deepEqual([unread.latest, unread.updateAvailable, unread.canUpdate], [null, false, true]);
  assert.match(unread.note, /could not be read/);
  assert.equal((await hoprigItem(deps('other', {})).info()).canUpdate, false);
  assert.match(git.whenRunning, /Hoprig never updates itself: Automatic tells you/);
  assert.match(gi.notInAll, /git checkout is updated on its own/);
  assert.ok(calls.some((c) => c.startsWith('ls-remote')));
  // ls-remote never waits for a password.
  const envs = [];
  await gitFacts('/app', async (argv, o) => (envs.push(o.env), { ok: false, code: 1, stdout: '' }));
  assert.equal(envs[0].GIT_TERMINAL_PROMPT, '0');
  // Update now on a checkout with uncommitted work: refused, nothing pulled.
  const ran = [];
  const dirty = hoprigItem({ ...deps('git', { 'status --porcelain': { ok: true, code: 0, stdout: ' M src/x.mjs\n' } }), stream: async (argv) => (ran.push(argv), { ok: true }), selfupdate: { installKind: () => 'git', updatePlan: () => [{ argv: ['git', 'pull'] }] } });
  const lines = [];
  const r = await dirty.update({ onLine: (l) => lines.push(l) });
  assert.deepEqual([r.ok, ran.length], [false, 0]);
  assert.match(lines[0], /changes that are not committed/);
  const clean = hoprigItem({ ...deps('git', { 'status --porcelain': { ok: true, code: 0, stdout: '' } }), stream: async (argv) => (ran.push(argv), { ok: true }), selfupdate: { installKind: () => 'git', updatePlan: () => [{ argv: ['git', 'pull'] }] } });
  const done = await clean.update({ onLine: () => {} });
  assert.deepEqual([done.ok, done.restart, ran.length], [true, true, 1]);
});

test('the tunnel helper: the version Hoprig ships, only its own copy is updated, never while a public link is on', async () => {
  const mk = ({ bin, out = 'cloudflared version 2026.9.0 (built …)', link = { on: false } } = {}) => tunnelItem({
    run: async () => ({ ok: true, stdout: out }),
    cloudflared: { findBin: () => bin, binDir: () => '/state/addons/bin' },
    publiclink: { CLOUDFLARED_VERSION: '2026.10.1', update: async () => ({ ok: true }) },
    linkState: () => link,
  });
  const own = await mk({ bin: '/state/addons/bin/cloudflared' }).info();
  assert.deepEqual({ installed: own.installed, latest: own.latest, updateAvailable: own.updateAvailable, canUpdate: own.canUpdate }, { installed: '2026.9.0', latest: '2026.10.1', updateAvailable: true, canUpdate: true });
  const sys = await mk({ bin: '/usr/bin/cloudflared' }).info();
  assert.equal(sys.canUpdate, false);
  assert.match(sys.why, /package manager/);
  const none = await mk({ bin: null }).info();
  assert.deepEqual([none.installed, none.canUpdate], [null, false]);
  assert.match(none.why, /first time the public link is turned on/);
  assert.equal(mk().blocked([]), null);
  assert.match(mk({ link: { on: true, kind: 'Temporary' } }).blocked([]), /public link is on \(Temporary\)/);
  assert.equal(mk().autoOk(own), true);
  assert.equal(mk().autoOk(sys), false);
  assert.deepEqual(await mk({ bin: '/state/addons/bin/cloudflared' }).update({ onLine: () => {} }), { ok: true, version: '2026.9.0', output: '' }, 'the add-on module\'s own update()');
});

test('the tunnel helper reads the Public link switch: a Temporary and a Custom link both count, also while it ends', async () => {
  const ls = (record = {}, oursPid = null) => ({ readSwitch, readRecord: () => record, ours: (pid) => pid === oursPid });
  const cfg = (publicLink) => ({ publicLink });
  assert.deepEqual(publicLinkState(ls(), cfg(undefined)), { on: false }, 'never turned on');
  assert.deepEqual(publicLinkState(ls(), cfg({ on: false, kind: 'custom' })), { on: false });
  assert.deepEqual(publicLinkState(ls(), cfg({ on: true, kind: 'custom' })), { on: true, kind: 'Custom' });
  assert.deepEqual(publicLinkState(ls(), cfg({ on: true, kind: 'temporary' })), { on: true, kind: 'Temporary' });
  assert.deepEqual(publicLinkState(ls(), cfg({ on: true })), { on: true, kind: 'Temporary' }, 'Temporary is the default kind');
  // Turned off a moment ago: its cloudflared still runs until it has ended; a number that is not ours does not count.
  assert.deepEqual(publicLinkState(ls({ kind: 'custom', pid: 4242 }, 4242), cfg({ on: false, kind: 'custom' })), { on: true, kind: 'Custom' });
  assert.deepEqual(publicLinkState(ls({ kind: 'custom', pid: 4242 }, null), cfg({ on: false, kind: 'custom' })), { on: false });
  // The item itself, with the switch on as Custom.
  const item = tunnelItem({ run: async () => ({ ok: true, stdout: '' }), cloudflared: { findBin: () => null, binDir: () => '/x' }, publiclink: { CLOUDFLARED_VERSION: '1' },
    linkswitch: { ...ls(), readSwitch: () => readSwitch(cfg({ on: true, kind: 'custom' })) } });
  await item.prepare();
  assert.match(item.blocked([]), /public link is on \(Custom\): turn it off first/);
});

// ---- the routes and the automations around it ----

const req = (body) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } });

test('the routes: GET, Check now, settings, run, log; bad input is a 400', async () => {
  const t = tmpDir('updroutes');
  try {
    const f = fakeCtx({ deck: fakeDeck(), stateDir: t.dir, now: () => 1000, updateItems: [fakeItem('claude', { info: newer() })] });
    const feature = automationFeature(null, { ctx: f.ctx, tick: false });
    feature.start();
    const call = async (method, p, body) => {
      const u = new URL(p, 'http://x');
      for (const [m, re, fn] of feature.routes) {
        const match = re.exec(u.pathname);
        if (match && m === method) return fn(req(body), match, u.searchParams);
      }
      throw new Error(`no route ${method} ${p}`);
    };
    assert.equal((await call('GET', '/api/updates')).items[0].action, 'update');
    assert.equal((await call('POST', '/api/updates/check', { id: 'claude' })).items.length, 1);
    await assert.rejects(call('POST', '/api/updates/check', { id: '../x' }), (e) => e.status === 400);
    await assert.rejects(call('POST', '/api/updates/check', { id: 'claude', extra: 1 }), (e) => e.status === 400);
    assert.deepEqual((await call('POST', '/api/updates/settings', { mode: 'auto' })).settings, { mode: 'auto', notify: false });
    await assert.rejects(call('POST', '/api/updates/settings', { mode: 'always' }), (e) => e.status === 400);
    assert.deepEqual(await call('POST', '/api/updates/run', { id: 'claude' }), { started: true, ids: ['claude'], skipped: [] });
    await assert.rejects(call('POST', '/api/updates/run', {}), (e) => e.status === 400);
    const l = await settle(feature.automation.updater);
    assert.equal((await call('GET', '/api/updates/log?from=0')).lines.length, l.lines.length);
    await feature.close();
  } finally {
    t.cleanup();
  }
});

test('the old Claude-only setting: moved once at start; an older page or Tia may still send it', async () => {
  const t = tmpDir('updlegacy');
  try {
    const f = fakeCtx({ deck: fakeDeck(), stateDir: t.dir, now: () => 1000, automation: { retry: { enabled: true }, updates: { claude: 'notify' } } });
    let a = createAutomation(f.ctx);
    assert.deepEqual(f.config().updates, { mode: 'manual', notify: true });
    assert.equal(f.config().automation.updates, undefined, 'the old row is gone');
    assert.equal(f.config().automation.retry.enabled, true, 'the rest stays');
    assert.equal(a.api.status().settings.updates.claude, 'notify', 'older pages still read it');
    a.api.changeSettings({ updates: { claude: 'auto' }, retry: { enabled: false } });
    assert.deepEqual(f.config().updates, { mode: 'manual', notify: true, itemModes: { claude: 'auto' } }, 'an older page\'s "auto" is about Claude Code only');
    assert.equal(a.api.status().settings.updates.claude, 'auto');
    assert.equal(f.config().automation.retry.enabled, false);
    assert.equal(f.config().automation.updates, undefined, 'never written back into the automations');
    a.api.changeSettings({ updates: { claude: 'off' } });
    assert.deepEqual(f.config().updates, { mode: 'manual', notify: false }, 'an older page\'s "off" also stops telling, and pins nothing');
    assert.equal(a.api.status().settings.updates.claude, 'off');
    a.api.changeSettings({ updates: { claude: 'notify' } });
    assert.deepEqual(f.config().updates, { mode: 'manual', notify: true });
    assert.equal(a.api.status().settings.updates.claude, 'notify');
    assert.throws(() => a.api.changeSettings({ updates: { claude: 'always' } }), /off, notify, auto/);
    assert.throws(() => a.api.changeSettings({ updates: { mode: 'auto' } }), /Settings → Updates/);
    await a.close();
    // An owner who had Claude Code update itself: after the move, only Claude Code does; nothing else starts
    // installing by itself without a new choice.
    const g = fakeCtx({ deck: fakeDeck(), stateDir: t.dir, now: () => 1000, automation: { updates: { claude: 'auto' } } });
    a = createAutomation(g.ctx);
    assert.deepEqual(g.config().updates, { mode: 'manual', notify: false, itemModes: { claude: 'auto' } });
    const U = await import('../../src/automation/updates.mjs');
    const s = U.readUpdateSettings(g.config());
    assert.deepEqual(['hoprig', 'claude', 'opencode', 'cloudflared'].map((id) => U.modeOf(s, id)), ['manual', 'auto', 'manual', 'manual']);
    assert.equal(U.looksInBackground(s), true, 'it still looks, to update Claude Code');
    const rows = ['claude', 'codex'].map((id) => ({ id, title: id, installed: '1', latest: '2', updateAvailable: true, canUpdate: true, auto: true }));
    assert.deepEqual(U.afterCheck({ rows, settings: s, data: {} }).actions.map((x) => [x.type, x.id]), [['update', 'claude']]);
    // The page sets it back to the mode for everything.
    assert.deepEqual(U.cleanUpdateSettings({ itemModes: { claude: null } }, s), { mode: 'manual', notify: false });
    assert.throws(() => U.cleanUpdateSettings({ itemModes: { vim: 'auto' } }, s), /not updated here/);
    assert.throws(() => U.cleanUpdateSettings({ itemModes: { claude: 'always' } }, s), /"manual", "auto" or null/);
    await a.close();
  } finally {
    t.cleanup();
  }
});

test('a default dashboard looks for nothing in the background; Automatic or notify look every 6 hours', async () => {
  const t = tmpDir('updlook');
  try {
    const item = fakeItem('claude', { info: newer() });
    const f = fakeCtx({ deck: fakeDeck(), stateDir: t.dir, now: () => 1000, updateItems: [item] });
    const a = createAutomation(f.ctx);
    const H = 3600_000;
    await a.tick(7 * H);
    assert.equal(item.calls.info, 0, 'Manual without notify: the page looks when it is opened');
    a.updater.changeSettings({ mode: 'auto' });
    await a.tick(7 * H + 1000);
    assert.equal(item.calls.info, 1);
    assert.equal(item.calls.update, 1, 'Automatic installs it');
    await a.tick(8 * H);
    assert.equal(item.calls.info, 1, 'not again before 6 hours');
    await a.close();
  } finally {
    t.cleanup();
  }
});

test('the output shows the home folder as "~" (no user name on the page)', async () => {
  const os = await import('node:os');
  const home = os.homedir();
  const item = fakeItem('codex', { info: newer(), update: () => ({ ok: false, output: `npm error in ${home}/.npm` }) });
  item.update = async ({ onLine }) => {
    onLine(`$ npm install --prefix ${home}/.local/state/hoprig/tools/codex`);
    return { ok: false, output: `npm error in ${home}/.npm` };
  };
  const { u } = make([item]);
  await u.start('codex');
  const l = await settle(u);
  assert.equal(l.lines[1], '$ npm install --prefix ~/.local/state/hoprig/tools/codex');
  assert.equal(l.results.codex.error, 'npm error in ~/.npm');
});

test('Settings → Updates lists the offered coding tools only: Hoprig, Claude Code, OpenCode, the tunnel helper', async () => {
  const U = await import('../../src/automation/updates.mjs');
  const { realItems } = await import('../../src/automation/updateitems.mjs');
  const { demoUpdateItems } = await import('../../src/demo/updates.mjs');
  assert.deepEqual([...U.UPDATE_ITEMS], ['hoprig', 'claude', 'opencode', 'cloudflared']);
  assert.deepEqual(realItems().map((i) => [i.id, i.title]), [['hoprig', 'Hoprig'], ['claude', 'Claude Code'], ['opencode', 'OpenCode'], ['cloudflared', 'Tunnel helper (cloudflared)']]);
  assert.deepEqual(demoUpdateItems().map((i) => i.id), ['hoprig', 'claude', 'opencode', 'cloudflared'], 'the demo too');
  assert.doesNotMatch(JSON.stringify(realItems().concat(demoUpdateItems()).map((i) => [i.title, i.whenRunning])), /Codex/);
  // A setting that names Codex (written by a version that offered it) is read as if it did not; a new one is refused.
  const s = U.readUpdateSettings({ updates: { mode: 'manual', notify: false, itemModes: { codex: 'auto', opencode: 'auto' } } });
  assert.deepEqual(s, { mode: 'manual', notify: false, itemModes: { opencode: 'auto' } });
  assert.throws(() => U.cleanUpdateSettings({ itemModes: { codex: 'auto' } }, s), /"codex" is not updated here/);
});
