// "Allow everything" is the owner's alone (src/allguard.mjs): chosen only on his own dashboard page, after he accepted it
// once on this computer, and only where Allow bypass permissions mode is on. A linked computer's token and Tia's door
// are refused on every route that sets it; a start nobody chooses for (a default, a schedule, Tia) starts in Bypass
// permissions; a session of Tia's never holds it; the switch going off takes it away; as root it is not offered.
// The real dashboard on the stand-ins (fixtures/fake-claude.mjs, a recording backend for terminal starts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('allguards');
test.after(() => box.cleanup());
const work = path.join(box.root, 'work');
const proj = path.join(work, 'proj');
fs.mkdirSync(proj, { recursive: true });

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { LAUNCH_FLAG } = await import('../../src/launchfile.mjs');
const G = await import('../../src/allguard.mjs');
const BASE = { launcher: ['launcher'], usage: false, server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'manual' } };
saveConfig({ ...BASE, allowBypass: true });
writeProfile('sub', { label: 'Main' });

const launches = [];
const backend = {
  kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '',
  create: async ({ name, argv }) => {
    launches.push(JSON.parse(fs.readFileSync(argv[argv.indexOf(LAUNCH_FLAG) + 1], 'utf8')));
    return { name, id: 'pty-1' };
  },
  respawn: async () => {},
};
const app = createServer({ backend, watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'pw-for-tests' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const send = async (headers, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json = null;
  try {
    json = JSON.parse(t);
  } catch {
    /* no body */
  }
  return { status: r.status, json };
};
const owner = (method, p, body) => send({ Origin: base, Cookie: cookie }, method, p, body);
const hub = createToken('hub'); // another computer's token: caller "computer"
const token = (method, p, body) => send({ Authorization: `Bearer ${hub.token}` }, method, p, body);
const setCfg = (o) => saveConfig({ ...BASE, allowBypass: undefined, allowEverythingAt: undefined, ...o });
const ALL = 'allowEverything';
const POSIX = { skip: process.platform === 'win32' && 'the stand-ins are POSIX' };

test('before it is accepted: every route that sets it says 409 all-unseen to the owner and 403 to anyone else', POSIX, async () => {
  setCfg({ allowBypass: true });
  assert.equal((await owner('GET', '/api/settings/bypass')).json.everything, false);
  for (const [name, call] of [
    ['a new App session', (who) => who('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: ALL })],
    ['a terminal session', (who) => who('POST', '/api/sessions', { dir: proj, mode: 'new', profile: 'sub', permissionMode: ALL })],
    ['the defaults', (who) => who('POST', '/api/settings', { sessionDefaults: { permissionMode: ALL } })],
  ]) {
    const o = await call(owner);
    assert.equal(o.status, 409, `${name}: ${JSON.stringify(o.json)}`);
    assert.equal(o.json.error, G.UNSEEN_LINE, name);
    assert.equal(o.json.code ?? o.json.details?.code, 'all-unseen', name);
    const t = await call(token);
    assert.equal(t.status, 403, `${name}: ${JSON.stringify(t.json)}`);
    assert.equal(t.json.error, G.NOT_OWNER_LINE, name);
  }
  assert.equal(launches.length, 0, 'nothing started');
  assert.ok(!(await owner('GET', '/api/settings')).json.sessionChoices.permissionModes.includes('bypassPermissions') === false, 'Bypass is offered');
  assert.deepEqual((await owner('GET', '/api/settings')).json.sessionChoices.permissionModes.slice(-2), ['bypassPermissions', ALL], 'right after Bypass');
});

test('the acknowledgement: confirm needed, the owner\'s page only, only while Bypass is allowed', POSIX, async () => {
  setCfg({ allowBypass: true });
  assert.equal((await owner('POST', '/api/settings/bypass/everything', {})).status, 400, 'without confirm');
  const t = await token('POST', '/api/settings/bypass/everything', { confirm: true });
  assert.equal(t.status, 403);
  assert.equal(t.json.error, G.NOT_OWNER_LINE);
  assert.equal(loadConfig().allowEverythingAt, undefined, 'a token accepted nothing');
  const ok = await owner('POST', '/api/settings/bypass/everything', { confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.everything, true);
  assert.ok(Number.isFinite(loadConfig().allowEverythingAt));
  setCfg({});
  const off = await owner('POST', '/api/settings/bypass/everything', { confirm: true });
  assert.equal(off.status, 409, 'Bypass is not allowed');
  assert.equal(off.json.error, G.SWITCH_OFF_LINE);
  assert.equal(loadConfig().allowEverythingAt, undefined);
});

test('accepted: the owner\'s page chooses it, a token is refused on every route, a default is carried only for his own page', POSIX, async () => {
  setCfg({ allowBypass: true, allowEverythingAt: 5 });
  const c = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: ALL });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const A = `/api/chats/${c.json.id}`;
  let v = (await owner('GET', A)).json;
  assert.equal(v.permissionMode, ALL);
  assert.deepEqual(v.choices.modes.slice(-2), ['bypassPermissions', ALL]);
  // The mode route: the owner's page can go there and back; a token cannot.
  assert.equal((await owner('POST', `${A}/mode`, { mode: 'manual' })).status, 200);
  assert.equal((await token('POST', `${A}/mode`, { mode: ALL })).status, 403);
  assert.equal((await owner('GET', A)).json.permissionMode, 'manual');
  assert.equal((await owner('POST', `${A}/mode`, { mode: ALL })).status, 200);
  assert.equal((await owner('GET', A)).json.permissionMode, ALL);
  // Another computer's token: every start that names it.
  assert.equal((await token('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: ALL })).status, 403);
  assert.equal((await token('POST', '/api/sessions', { dir: proj, mode: 'new', profile: 'sub', permissionMode: ALL })).status, 403);
  assert.equal((await token('POST', '/api/settings', { sessionDefaults: { permissionMode: ALL } })).status, 403);
  assert.equal((await token('POST', `${A}/answer`, { request: 'x', allow: true, mode: ALL })).status, 403);
  // The page's terminal start: the launch file says all, and Claude Code gets Bypass.
  launches.length = 0;
  const t1 = await owner('POST', '/api/sessions', { dir: proj, mode: 'new', profile: 'sub', permissionMode: ALL });
  assert.equal(t1.status, 200, JSON.stringify(t1.json));
  assert.equal(launches[0].all, true);
  assert.ok(launches[0].argv.join(' ').includes('--permission-mode bypassPermissions'));
  assert.ok(!launches[0].argv.includes(ALL));
  // A start that is not chosen for it.
  assert.equal((await owner('POST', '/api/sessions', { dir: proj, mode: 'new', profile: 'sub', permissionMode: 'bypassPermissions' })).status, 200);
  assert.equal('all' in launches.at(-1), false);
});

test('a default of it: only his own page starts in it; a token, a schedule and a plan start in Bypass', POSIX, async () => {
  setCfg({ allowBypass: true, allowEverythingAt: 5 });
  assert.equal((await owner('POST', '/api/settings', { sessionDefaults: { permissionMode: ALL } })).status, 200);
  assert.equal(loadConfig().sessionDefaults.permissionMode, ALL);
  // carried unchanged (what Tia's change_setting does) passes, also for a token
  assert.equal((await token('POST', '/api/settings', { sessionDefaults: { permissionMode: ALL } })).status, 200);
  // his page: a chat and a terminal with no mode named take it
  const mine = await owner('POST', '/api/chats', { dir: proj, profile: 'sub' });
  assert.equal((await owner('GET', `/api/chats/${mine.json.id}`)).json.permissionMode, ALL);
  launches.length = 0;
  await owner('POST', '/api/sessions', { dir: proj, mode: 'new', profile: 'sub' });
  assert.equal(launches[0].all, true);
  // not his page: Bypass
  const theirs = await token('POST', '/api/chats', { dir: proj, profile: 'sub', defaults: true });
  assert.equal((await owner('GET', `/api/chats/${theirs.json.id}`)).json.permissionMode, 'bypassPermissions');
  launches.length = 0;
  assert.equal((await token('POST', '/api/sessions', { dir: proj, mode: 'new', profile: 'sub' })).status, 200);
  assert.equal('all' in launches[0], false);
  // the chats of his own page take the folder's last chat too, but a start through ctx open (a schedule) does not
  const chat = app.features.find((f) => f.name === 'chat');
  const sched = await chat.open({ dir: proj, profile: 'sub', defaults: true });
  assert.equal((await owner('GET', `/api/chats/${sched.id}`)).json.permissionMode, 'bypassPermissions');
  const named = await chat.open({ dir: proj, profile: 'sub', defaults: true }, { page: false }).catch((e) => e);
  assert.equal(named.id !== undefined, true);
  await assert.rejects(chat.open({ dir: proj, profile: 'sub', permissionMode: ALL }), (e) => e.status === 403 && e.message === G.NOT_OWNER_LINE, 'a named Allow everything without his page is refused');
  await assert.rejects(chat.open({ dir: proj, profile: 'sub', permissionMode: ALL, hers: true }, { page: true }), (e) => e.status === 409 && e.message === G.HERS_LINE, 'a chat of Tia\'s never');
  await assert.rejects(chat.open({ dir: proj, profile: 'sub', permissionMode: ALL, byTia: true }, { page: true }), (e) => e.message === G.HERS_LINE);
  const hers = await chat.open({ dir: proj, profile: 'sub', defaults: true, hers: true }, { page: true });
  assert.equal((await owner('GET', `/api/chats/${hers.id}`)).json.permissionMode, 'bypassPermissions', 'a default is Bypass for hers even on his page');
  // another coding tool does not have it: the usual list refusal
  assert.equal((await owner('POST', '/api/chats', { dir: proj, profile: 'sub', tool: 'opencode', permissionMode: ALL })).status, 400);
});

test('the switch going off takes it away: its chats go to Manual, the default is cleared, every route refuses', POSIX, async () => {
  setCfg({ allowBypass: true, allowEverythingAt: 5 });
  const c = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: ALL });
  await owner('POST', '/api/settings', { sessionDefaults: { permissionMode: ALL } });
  const off = await owner('POST', '/api/settings/bypass', { allow: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.defaults, true);
  assert.ok(off.json.changed >= 1, 'the count includes the Allow everything chats');
  assert.equal((await owner('GET', `/api/chats/${c.json.id}`)).json.permissionMode, 'manual');
  assert.equal(loadConfig().sessionDefaults.permissionMode, undefined);
  assert.equal(loadConfig().allowEverythingAt, 5, 'accepted once on this computer: kept');
  const r = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: ALL });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, G.SWITCH_OFF_LINE);
  assert.ok(!(await owner('GET', '/api/settings')).json.sessionChoices.permissionModes.includes(ALL));
  // and on again: it is a mode like the others, no second question
  await owner('POST', '/api/settings/bypass', { allow: true, confirm: true });
  assert.equal((await owner('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: ALL })).status, 200);
});

test('as root: neither Bypass nor Allow everything is offered or accepted, and a default of it says why', POSIX, async () => {
  setCfg({ allowBypass: true, allowEverythingAt: 5, sessionDefaults: { permissionMode: ALL } });
  const r = createServer({ backend, watch: false, root: true, workUser: null, dashboardFile: false });
  const { port: p2 } = await r.listen(0, '127.0.0.1');
  const b2 = `http://127.0.0.1:${p2}`;
  try {
    const lg = await fetch(`${b2}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2 }, body: JSON.stringify({ password: 'pw-for-tests' }) });
    const ck = lg.headers.get('set-cookie').split(';')[0];
    const post = async (p, body) => {
      const x = await fetch(b2 + p, { method: 'POST', headers: { Origin: b2, Cookie: ck, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: x.status, json: JSON.parse((await x.text()) || '{}') };
    };
    const a = await post('/api/chats', { dir: proj, profile: 'sub', permissionMode: ALL });
    assert.equal(a.status, 409);
    assert.equal(a.json.error, (await import('../../src/bypassgate.mjs')).ALL_ROOT_LINE);
    const d = await post('/api/chats', { dir: proj, profile: 'sub', defaults: true });
    assert.equal(d.status, 409, 'nobody chooses: a default of it is refused as a default of Bypass is');
    const t = await (await fetch(`${b2}/api/chats/tools`, { headers: { Origin: b2, Cookie: ck } })).json();
    for (const x of t.tools.filter((y) => y.modes)) assert.ok(!x.modes.includes(ALL) && !x.modes.includes('bypassPermissions'), x.id);
    assert.equal((await post('/api/sessions', { dir: proj, mode: 'new', profile: 'sub', permissionMode: ALL })).status, 409);
  } finally {
    await r.close();
  }
});

test('a hand-over between a terminal and a chat continues in Bypass, never in Allow everything', async () => {
  const src = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'chat', 'handoff.mjs'), 'utf8');
  assert.match(src, /=== ALL \? BYPASS :/, 'the chat made from a terminal never takes Allow everything from the last chat or the defaults');
  const lines = await import('../../src/chat/engines/claude-lines.mjs');
  assert.equal(lines.sdkMode(ALL), 'bypassPermissions');
  const args = lines.chatArgs({ sessionId: 's', permissionMode: ALL, allowBypass: true });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.ok(!args.includes(ALL), 'Claude Code never gets the word');
  assert.ok(!lines.chatArgs({ sessionId: 's', permissionMode: ALL, allowBypass: false }).includes('--permission-mode'), 'no Bypass allowed: no mode at all');
});
