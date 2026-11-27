// What the Operator now sees of the computer's own health, through the real sources (a temporary home, stand-in servers
// on ports the system hands out): a gateway that answers with server errors, a port another program holds, a provider
// address that answers nothing, a coding tool that died with no end hook, a linked computer that went silent, a merge
// half done, and a limit with no order set. Each is an item within one look and gone when its cause is gone.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-health');
test.after(() => box.cleanup());

const { createRun, updateRun, removeRun } = await import('../../src/runs.mjs');
const { defaultSources } = await import('../../src/operator/sources.mjs');
const { buildBoard } = await import('../../src/operator/board.mjs');
const { attention } = await import('../../src/operator/attention.mjs');
const { detectRepo } = await import('../../src/operator/detect/repo.mjs');
const { detectComputer } = await import('../../src/operator/detect/computer.mjs');
const { profilesDir } = await import('../../src/paths.mjs');

const projects = path.join(box.root, 'projects');
fs.mkdirSync(projects);
const cards = [];
let profiles = [{ name: 'plan-a', signedIn: true, usage: null }];
const ctx = { state: async () => ({ sessions: cards, profiles }), config: () => ({ projectsDir: projects, server: {} }) };
const SID = '77777777-7777-4777-8777-777777777777';

async function look(src, now) {
  await src.tick();
  const board = await buildBoard(src.sources, { timeoutMs: 20_000, ...(now ? { now } : {}) });
  return attention(board, now ? { now } : {});
}
const listen = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const close = (srv) => new Promise((r) => srv.close(r));

test('a gateway that answers its port with server errors is a stopped item with the restart act; when its health answers again it is gone', async () => {
  let status = 503;
  const { srv, port } = await listen((q, s) => { s.statusCode = q.url === '/health' ? status : 200; s.end(); });
  try {
    const gate = { id: 'gate', status: async () => ({ installed: true, running: true, url: `http://127.0.0.1:${port}` }) };
    const items = async () => (await look(defaultSources(ctx, { port: () => null, gateways: () => [gate], usersOf: () => ['plan-g'] }))).items.filter((i) => i.subject === 'gateway gate');
    const [it] = await items();
    assert.equal(it?.class, 'stopped');
    assert.equal(it.recommended, 'restart-gateway');
    assert.match(it.facts[0], new RegExp(`answers with server errors \\(HTTP 503\\) on port ${port}$`));
    status = 404; // no such address still means it is up
    assert.deepEqual(await items(), []);
    status = 200;
    assert.deepEqual(await items(), []);
  } finally {
    await close(srv);
  }
});

test('a port another program holds: said with the program and its pid, no restart act, and that program is left running', { skip: process.platform !== 'linux' && 'the holder is read from /proc' }, async () => {
  const { srv, port } = await listen((q, s) => s.end());
  try {
    // The add-on says what the real one says when something else answers on its port: not running, `foreign`.
    const gate = { id: 'gate', status: async () => ({ installed: true, running: false, foreign: true, url: `http://127.0.0.1:${port}` }) };
    cards.splice(0, cards.length, { name: 'gamma', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'plan-g', label: 'plan-g' }, status: 'working', statusAt: Date.now() });
    const l = await look(defaultSources(ctx, { port: () => null, gateways: () => [gate], usersOf: () => ['plan-g'] }));
    const [it] = l.items.filter((i) => i.subject === 'gateway gate');
    assert.equal(it?.class, 'stopped');
    assert.deepEqual(it.acts.map((a) => a.id), ['open'], 'no restart, no end');
    assert.match(it.facts[0], new RegExp(`^port ${port} is held by node[\\w-]*, pid ${process.pid}$`));
    // The program still answers: nothing was ended or touched.
    assert.equal(await new Promise((r) => http.get({ host: '127.0.0.1', port }, (res) => { res.resume(); r(res.statusCode); })), 200);
  } finally {
    cards.length = 0;
    await close(srv);
  }
});

test('a provider address that answers nothing is one row naming the sessions that cannot work; a key in the address is never sent; an answering one is no row', async () => {
  const closed = await freePort();
  fs.writeFileSync(path.join(profilesDir(), 'gw1.env'), `ANTHROPIC_BASE_URL=http://127.0.0.1:${closed}\nANTHROPIC_AUTH_TOKEN=made-up-token-123\nLABEL=Plain gateway\n`);
  const { srv, port } = await listen((q, s) => s.end());
  fs.writeFileSync(path.join(profilesDir(), 'gw2.env'), `ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\nANTHROPIC_AUTH_TOKEN=made-up-token-456\n`);
  fs.writeFileSync(path.join(profilesDir(), 'gw3.env'), `ANTHROPIC_BASE_URL=http://127.0.0.1:${closed}/?key=abc\nANTHROPIC_AUTH_TOKEN=made-up-token-789\n`);
  profiles = [{ name: 'plan-a', signedIn: true, usage: null }, { name: 'gw1', label: 'Plain gateway', signedIn: true, usage: null }, { name: 'gw2', signedIn: true, usage: null }, { name: 'gw3', signedIn: true, usage: null }];
  const open = (n, p) => ({ name: n, kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: p }, status: 'working', statusAt: Date.now() });
  cards.splice(0, cards.length, open('one', 'gw1'), open('two', 'gw1'), open('three', 'gw2'), open('four', 'gw3'));
  try {
    const l = await look(defaultSources(ctx, { port: () => null }));
    const rows = l.items.filter((i) => i.kind === 'provider');
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].class, 'stopped');
    assert.match(rows[0].facts[0], new RegExp(`^provider Plain gateway does not answer at its address \\(127\\.0\\.0\\.1:${closed}\\)$`));
    assert.equal(rows[0].facts[1], '2 open sessions on it cannot work');
    assert.deepEqual(rows[0].acts.map((a) => a.id), ['open'], 'not Hoprig\'s to restart');
    assert.equal(JSON.stringify(l).includes('made-up-token'), false, 'no key anywhere in the list');
    assert.equal(rows[0].recommended, 'open');
    // The sessions are closed: the row is gone with them.
    cards.length = 0;
    const l2 = await look(defaultSources(ctx, { port: () => null }));
    assert.deepEqual(l2.items.filter((i) => i.kind === 'provider'), []);
  } finally {
    cards.length = 0;
    profiles = [{ name: 'plan-a', signedIn: true, usage: null }];
    await close(srv);
  }
});

test('a coding tool that died with no end hook offers Reopen with its conversation; one that ended itself (SessionEnd) or has no conversation does not', async () => {
  const src = defaultSources(ctx, { port: () => null });
  const mk = (over) => {
    const { file, run } = createRun({ profile: 'plan-a', cwd: box.home });
    updateRun(file, { status: 'working', ...over });
    return { file, run };
  };
  const died = mk({});
  const quit = mk({ status: 'ended', endReason: 'prompt_input_exit' });
  const card = (name, run, extra = {}) => ({ name, kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'plan-a' }, runId: run.runId, sessionId: SID.replace(/7$/, name === 'died' ? '7' : name === 'quit' ? '8' : '9'), status: 'working', statusAt: Date.now(), ...extra });
  cards.splice(0, cards.length, card('died', died.run), card('quit', quit.run), card('nocv', mk({}).run, { sessionId: null }));
  try {
    await look(src);
    // Each terminal is a plain shell now: the tool left its pane.
    cards.splice(0, cards.length, ...['died', 'quit', 'nocv'].map((name) => ({ name, kind: 'shell', cwd: box.home })));
    const l = await look(src);
    const by = Object.fromEntries(l.items.filter((i) => i.kind === 'ended').map((i) => [i.subject, i]));
    assert.deepEqual(by['session died'].acts.map((a) => a.id), ['reopen', 'open']);
    assert.equal(by['session died'].recommended, 'reopen');
    assert.equal(by['session died'].target.reopen, true);
    assert.equal(by['session died'].target.cwd, box.home);
    assert.equal(by['session died'].target.profile, 'plan-a');
    assert.equal(by['session quit'].recommended, 'open', 'he ended it himself: only Open');
    assert.equal(by['session nocv'].recommended, 'open', 'no conversation to resume');
  } finally {
    cards.length = 0;
    for (const x of [died, quit]) removeRun(x.file);
  }
});

test('a linked computer that has not answered for 5 minutes is one row; before that, or while it answers, none', async () => {
  const at = Date.now();
  const iso = (t) => new Date(t).toISOString();
  let list = [];
  const rooms = () => ({ computers: list });
  const src = defaultSources(ctx, { port: () => null, rooms, now: () => at });
  const subjects = async (now) => (await look(src, now)).items.filter((i) => i.subject.startsWith('computer ')).map((i) => i.subject);
  list = [{ name: 'laptop', here: false, reached: false, seenAt: iso(at - 2 * 60_000) }, { name: 'desk', here: false, reached: true, seenAt: iso(at) }, { name: 'new', here: false, reached: false, seenAt: null }];
  assert.deepEqual(await subjects(at), [], 'silent for 2 minutes only; one never seen is unknown, not offline');
  assert.deepEqual(await subjects(at + 4 * 60_000), ['computer laptop'], '6 minutes since it answered; the one that answers and the one never seen say nothing');
  list = [{ ...list[0], reached: true, seenAt: iso(at + 5 * 60_000) }];
  assert.deepEqual(await subjects(at + 5 * 60_000), [], 'it answered again: gone');
});

test('computer.mjs: silent for 5 minutes gives one row with Open Computers and no act on the other computer', () => {
  const now = Date.parse('2026-03-10T14:00:00Z');
  const board = { computers: [
    { name: 'laptop', online: false, offlineSince: new Date(now - 6 * 60_000).toISOString() },
    { name: 'tablet', online: false, offlineSince: new Date(now - 4 * 60_000).toISOString() },
    { name: 'desk', online: true },
    { name: 'spare', online: null },
  ] };
  const items = detectComputer(board, { now });
  assert.deepEqual(items.map((i) => i.subject), ['computer laptop']);
  assert.equal(items[0].facts[0], 'computer laptop has not answered for 6 min');
  assert.deepEqual(items[0].acts.map((a) => a.id), ['open']);
});

test('a merge half done is named in words, with Open and nothing that changes the git tree', () => {
  const board = { repos: [
    { name: 'shop', path: 'shop', project: 'shop', branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, dirty: 2, merging: 'merge', fetchedAt: null },
    { name: 'blog', path: 'blog', project: 'blog', branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, dirty: 0, merging: 'rebase', fetchedAt: null },
  ] };
  const [a, b] = detectRepo(board, { now: 1 });
  assert.equal(a.subject, 'merge half done in shop');
  assert.match(a.facts[0], /^a merge is half done in shop$/);
  assert.equal(a.class, 'waits');
  assert.deepEqual(a.acts.map((x) => x.id), ['open']);
  assert.match(b.facts[0], /^a rebase is half done in blog$/);
});

test('a merge half done in a real clone shows as that item, and is gone when git finishes it', { skip: (() => { try { execFileSync('git', ['--version']); return false; } catch { return true; } })() && 'git is not installed' }, async () => {
  const dir = path.join(projects, 'shop', 'code', 'app');
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Alex', GIT_AUTHOR_EMAIL: 'alex@box2', GIT_COMMITTER_NAME: 'Alex', GIT_COMMITTER_EMAIL: 'alex@box2' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), `${git('rev-parse', 'HEAD').trim()}\n`);
  const src = defaultSources(ctx, { port: () => null });
  const subjects = async () => (await look(src)).items.filter((i) => i.kind === 'repo').map((i) => i.subject);
  assert.deepEqual(await subjects(), ['merge half done in shop/code/app']);
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'));
  // The slow check looks again once a source starts over (a new look five minutes on does the same).
  const again = defaultSources(ctx, { port: () => null });
  assert.deepEqual((await look(again)).items.filter((i) => i.kind === 'repo' && /half done/.test(i.subject)), []);
});

test('a session at a limit with no order set: the row names the next subscription provider of his list, and never a paid one', async () => {
  profiles = [{ name: 'plan-a', kind: 'subscription', signedIn: true, usage: null }, { name: 'key-x', kind: 'api', signedIn: true, usage: null }, { name: 'plan-b', label: 'Second plan', kind: 'subscription', signedIn: true, usage: null }];
  cards.splice(0, cards.length, { name: 'orders', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'plan-a' }, status: 'waiting', statusAt: Date.now(), canSwitch: true, runLimit: { at: Date.now() - 60_000, text: 'Usage limit reached' } });
  try {
    const src = defaultSources(ctx, { port: () => null });
    const [it] = (await look(src)).items.filter((i) => i.kind === 'limit');
    assert.equal(it.recommended, 'switch');
    assert.ok(it.facts.includes('next provider in the order: Second plan'), it.facts.join('|'));
    profiles = [{ name: 'plan-a', kind: 'subscription', signedIn: true, usage: null }, { name: 'key-x', kind: 'api', signedIn: true, usage: null }];
    const [alone] = (await look(defaultSources(ctx, { port: () => null }))).items.filter((i) => i.kind === 'limit');
    assert.equal(alone.recommended, 'open', 'only a paid one is left: no move is named');
  } finally {
    cards.length = 0;
    profiles = [{ name: 'plan-a', signedIn: true, usage: null }];
  }
});
