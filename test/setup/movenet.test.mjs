// The move asks first whether the user's own install can reach the network (src/setup/movenet.mjs, runMove in
// moverun.mjs). Never the real network: every look is handed a fetch of the test's own, and the global fetch is a
// recorder that fails the test when it is asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

// The move to a user of its own is Linux only: root, user ids, runuser and systemd, with POSIX paths.
const LINUX_ONLY = { skip: process.platform === 'win32' && 'the move to a user of its own is Linux only (root, chown by uid, POSIX paths)' };

const s = scratch();
test.after(s.cleanup);
const N = await import('../../src/setup/movenet.mjs');
const R = await import('../../src/setup/moverun.mjs');
const M = await import('../../src/setup/movecli.mjs');

const root = path.join(s.tmp, 'root');
const dirs = { config: path.join(root, '.config/hoprig'), state: path.join(root, '.local/state/hoprig'), claude: path.join(root, '.claude'), workspace: path.join(root, 'Workspace') };
fs.mkdirSync(dirs.state, { recursive: true });
fs.mkdirSync(path.join(dirs.config), { recursive: true });
fs.writeFileSync(path.join(dirs.config, 'config.json'), '{}');
// A server with only root: no user of Hoprig's yet (getent finds none), nothing running.
const io = { home: root, uid: 0, env: { TMUX_TMPDIR: path.join(s.tmp, 'tmux') }, dirs, run: async () => ({ ok: false, code: 2, stdout: '', stderr: '' }), statfs: () => ({ bavail: 1e7, bsize: 4096 }), workRunning: async () => 0, hasBash: () => false };

/** The global fetch, replaced while `fn` runs by one that records: the move's default look must never be asked. */
async function noRealFetch(fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    throw new Error('the real network was asked');
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
    assert.deepEqual(asked, [], 'the default fetch was not called');
  }
}

/** Steps that fail the test when asked: nothing is made, copied or switched. */
const never = Object.fromEntries(['makeUser', 'copy', 'check', 'switchSys', 'own', 'mark', 'clearOwn', 'endTerminals', 'gateways', 'gatewaySys'].map((k) => [k, () => assert.fail(`step ${k} ran`)]));

test("what the user's install needs: the registry it will use, Node.js's place, nvm and Claude Code; only hosts, never a password", () => {
  assert.deepEqual(N.networkNeeds(path.join(s.tmp, 'no-such-home')).map((n) => n.host), ['registry.npmjs.org', 'nodejs.org', 'raw.githubusercontent.com', 'github.com', 'claude.ai', 'downloads.claude.ai']);
  const home = path.join(s.tmp, 'npmrc-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.npmrc'), 'fund=false\nregistry=https://alex:made-up-secret@npm.example.com/shop/\n');
  const needs = N.networkNeeds(home);
  assert.deepEqual(needs, [{ host: 'npm.example.com', url: 'https://npm.example.com/', npm: true }, { host: 'nodejs.org', url: 'https://nodejs.org/' }, { host: 'raw.githubusercontent.com', url: 'https://raw.githubusercontent.com/' }, { host: 'github.com', url: 'https://github.com/' }, { host: 'claude.ai', url: 'https://claude.ai/' }, { host: 'downloads.claude.ai', url: 'https://downloads.claude.ai/' }]);
  assert.doesNotMatch(JSON.stringify(needs), /made-up-secret|alex/);
});

test('the look is bounded: every host asked at once, each within its limit; any HTTP answer counts as reached', async () => {
  const needs = N.networkNeeds(path.join(s.tmp, 'no-such-home'));
  const started = [];
  const fetch = (url, o) => {
    started.push(url);
    assert.ok(o.signal instanceof AbortSignal, 'a limit on each request');
    if (url.includes('nodejs.org')) return Promise.resolve({ ok: false, status: 401 }); // an answer all the same
    if (url.includes('registry')) return Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    // Never answers. A real fetch keeps the process alive while it waits (its open connection, see
    // movenet-silent.test.mjs); a timer that only the limit clears does the same here, or on Node 22.11 the time
    // limit alone does not, and the run ends before the look does.
    return new Promise((res, rej) => {
      const alive = setTimeout(() => {}, 60_000);
      o.signal.addEventListener('abort', () => {
        clearTimeout(alive);
        rej(o.signal.reason);
      });
    });
  };
  const t0 = Date.now();
  const r = await N.reachAll(needs, { fetch, ms: 200 });
  assert.equal(started.length, 6, 'all asked');
  assert.ok(Date.now() - t0 < 2000, 'within the limit, not one after the other');
  assert.deepEqual(r, { ok: false, unreached: ['registry.npmjs.org', 'raw.githubusercontent.com', 'github.com', 'claude.ai', 'downloads.claude.ai'] });
  assert.equal(N.REACH_MS, 10_000);
});

test('a host that cannot be reached stops the move first, with one line: nothing is made or copied', async () => {
  const plan = { user: { name: 'hoprig', uid: null, gid: null, home: '/home/hoprig' }, make: true, network: N.networkNeeds(root), dirs };
  const said = [];
  const asked = [];
  // The REAL steps' look, with only its lowest call handed in.
  const reachFetch = async (url) => {
    asked.push(url);
    if (url.includes('registry')) throw new Error('connect ETIMEDOUT');
    return { ok: true, status: 200 };
  };
  const r = await noRealFetch(() => R.runMove(plan, { say: (l) => said.push(l), steps: never, low: { reachFetch } }));
  assert.deepEqual(r, { ok: false, step: 'network' });
  assert.equal(asked.length, 6);
  assert.deepEqual(said, ["The move needs the network for the user hoprig's own install, and registry.npmjs.org could not be reached: nothing was made or copied, and root's Hoprig works as before. Check that this server can reach the internet (its firewall or its provider), then run the move again: hoprig move-to-user --yes --user hoprig"]);
  // Every host reached: the move goes on to the making (the first step after the look).
  let making = 0;
  const on = await noRealFetch(() => R.runMove(plan, { say: () => {}, steps: { ...never, makeUser: async () => ((making += 1), { ok: false, why: 'made up' }) }, low: { reachFetch: async () => ({ ok: true, status: 200 }) } }));
  assert.deepEqual([on, making], [{ ok: false, step: 'user' }, 1]);
});

test('the go-on after an earlier run made the user and its copy: the stop says what is left and offers no removal, since this run made none of it', async () => {
  // The look of `move-to-user --yes --user hoprig` after a run that made hoprig, copied and stopped: the user is there
  // (no making), and the mark says an earlier move made it.
  const plan = {
    user: { name: 'hoprig', uid: 1234, gid: 1234, home: '/srv/hoprig' }, make: false, network: N.networkNeeds(root), dirs,
    again: { user: 'hoprig', home: '/srv/hoprig', parts: ['/srv/hoprig/.config/hoprig'], madeUser: true, state: 'copying' },
    parts: [{ id: 'config', to: '/srv/hoprig/.config/hoprig' }, { id: 'ssh', to: '/srv/hoprig/.ssh' }],
  };
  const said = [];
  const r = await noRealFetch(() => R.runMove(plan, { say: (l) => said.push(l), steps: never, low: { reachFetch: async () => { throw new TypeError('fetch failed'); } } }));
  assert.deepEqual(r, { ok: false, step: 'network' });
  assert.deepEqual(said, [
    "The move needs the network for the user hoprig's own install, and registry.npmjs.org, nodejs.org, raw.githubusercontent.com, github.com, claude.ai and downloads.claude.ai could not be reached: nothing more was made or copied. Check that this server can reach the internet (its firewall or its provider), then go on as the lines below say.",
    "Left behind, none of it in use: the copy in /srv/hoprig, lingering for hoprig, the user hoprig (made by an earlier move). Root's installation works as before.",
    'To go on: hoprig move-to-user --yes --user hoprig (it takes this copy away first and copies again; a part changed since is set aside beside it, never deleted)',
  ]);
});

test("the go-on after a move that switched and went back: the network stop offers no command that takes the user's work away", async () => {
  // The look of the move again after --back: the mark says the user's dashboard ran on that copy for a while.
  for (const madeUser of [true, false]) {
    const plan = {
      user: { name: 'hoprig', uid: 1234, gid: 1234, home: '/srv/hoprig' }, make: false, network: N.networkNeeds(root), dirs,
      again: { user: 'hoprig', home: '/srv/hoprig', parts: ['/srv/hoprig/Workspace'], madeUser, state: 'back', switchingAt: '2026-11-01T00:09:00Z', switchedAt: '2026-11-01T00:10:00Z', backAt: '2026-11-15T00:00:00Z' },
      parts: [{ id: 'workspace', to: '/srv/hoprig/Workspace' }, { id: 'ssh', to: '/srv/hoprig/.ssh' }],
    };
    const said = [];
    const r = await noRealFetch(() => R.runMove(plan, { say: (l) => said.push(l), steps: never, low: { reachFetch: async () => { throw new TypeError('fetch failed'); } } }));
    assert.deepEqual(r, { ok: false, step: 'network' });
    assert.deepEqual(said.slice(1), [
      "The earlier move's copy in /srv/hoprig, which hoprig's dashboard ran on, is kept as it is: nothing of it is taken away, and the user hoprig stays.",
      'To go on: hoprig move-to-user --yes --user hoprig (it sets that copy aside beside it, never deleted, and copies again)',
    ], `madeUser ${madeUser}`);
    assert.doesNotMatch(said.join('\n'), /userdel|rm -r|rm -f|disable-linger|takes this copy away/);
  }
});

test("the command line and the page's job say the stop; the dry run and --json say in one line that the install needs the network", LINUX_ONLY, async () => {
  const low = { reachFetch: async () => { throw new Error('connect ENETUNREACH'); } };
  // The dry run: the line, after the steps.
  const out = [];
  assert.equal(await noRealFetch(() => M.main(['--dry-run'], { io, cfg: {}, low, out: (l) => out.push(l), err: (l) => out.push(l) })), 0, out.join('\n'));
  const line = "The user hoprig's own install needs the network (Node.js and the packages come from there): registry.npmjs.org, nodejs.org, raw.githubusercontent.com, github.com, claude.ai and downloads.claude.ai. The move checks them before it makes or copies anything.";
  assert.equal(out.filter((l) => l === line).length, 1, out.join('\n'));
  assert.ok(out.indexOf(line) > out.indexOf('Steps that run as administrator:'));
  // --json (the hub's look): the hosts and the same line.
  const json = [];
  await noRealFetch(() => M.main(['--dry-run', '--json'], { io, cfg: {}, low, out: (l) => json.push(l) }));
  assert.deepEqual(JSON.parse(json[0]).network, { hosts: ['registry.npmjs.org', 'nodejs.org', 'raw.githubusercontent.com', 'github.com', 'claude.ai', 'downloads.claude.ai'], line });
  // --yes through the page's job: no host answers, the stop line is the job's, nothing was made.
  const job = path.join(s.tmp, 'move-job.json');
  const lines = [];
  assert.equal(await noRealFetch(() => M.main(['--yes', '--job', job], { io, cfg: {}, steps: never, low, out: (l) => lines.push(l), err: (l) => lines.push(l) })), 1);
  const stop = "The move needs the network for the user hoprig's own install, and registry.npmjs.org, nodejs.org, raw.githubusercontent.com, github.com, claude.ai and downloads.claude.ai could not be reached: nothing was made or copied, and root's Hoprig works as before. Check that this server can reach the internet (its firewall or its provider), then run the move again: hoprig move-to-user --yes --user hoprig";
  assert.equal(lines.at(-1), stop, lines.join('\n'));
  const j = JSON.parse(fs.readFileSync(job, 'utf8'));
  assert.equal(j.lines.at(-1), stop);
  assert.deepEqual(j.result, { ok: false, code: 1 });
  assert.deepEqual(fs.readdirSync(dirs.state), [], 'no mark, no lock left: nothing of the move was written');
});

test('a server that goes out through a proxy: the look is not made (Node would not use it), said in one line, and the move goes on', LINUX_ONLY, async () => {
  // The setting's name only, never its value (it may hold a password).
  assert.equal(N.proxyOf(path.join(s.tmp, 'no-such-home'), { env: { HTTPS_PROXY: 'http://alex:made-up-secret@proxy.example.com:3128' } }), 'HTTPS_PROXY');
  assert.equal(N.proxyOf(path.join(s.tmp, 'no-such-home'), { env: { http_proxy: 'http://proxy.example.com:3128' } }), 'http_proxy');
  assert.equal(N.proxyOf(path.join(s.tmp, 'no-such-home'), { env: { HTTPS_PROXY: ' ' } }), null);
  const home = path.join(s.tmp, 'proxy-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.npmrc'), 'fund=false\nhttps-proxy=http://proxy.example.com:3128\n');
  assert.equal(N.proxyOf(home, { env: {} }), 'https-proxy in ~/.npmrc');
  assert.equal(N.proxyOf(root, { env: {} }), null);
  // The move: no host is asked, the one line, then the making (the first step after the look).
  const plan = { user: { name: 'hoprig', uid: null, gid: null, home: '/home/hoprig' }, make: true, network: N.networkNeeds(root), proxy: 'HTTPS_PROXY', dirs };
  const said = [];
  let making = 0;
  const r = await noRealFetch(() => R.runMove(plan, { say: (l) => said.push(l), steps: { ...never, reach: () => assert.fail('the look ran'), makeUser: async () => ((making += 1), { ok: false, why: 'made up' }) } }));
  assert.deepEqual([r, making], [{ ok: false, step: 'user' }, 1]);
  assert.equal(said[0], "The network was not checked: this server goes out through a proxy (HTTPS_PROXY), which the user's install uses.");
  // The dry run's line says so instead of promising a check, and names no value.
  const out = [];
  assert.equal(await noRealFetch(() => M.main(['--dry-run'], { io: { ...io, env: { ...io.env, HTTPS_PROXY: 'http://alex:made-up-secret@proxy.example.com:3128' } }, cfg: {}, out: (l) => out.push(l), err: (l) => out.push(l) })), 0, out.join('\n'));
  assert.ok(out.includes("The user hoprig's own install needs the network (Node.js and the packages come from there): registry.npmjs.org, nodejs.org, raw.githubusercontent.com, github.com, claude.ai and downloads.claude.ai. This server goes out through a proxy (HTTPS_PROXY), so the move does not check them itself: the install goes through that proxy."), out.join('\n'));
  assert.doesNotMatch(out.join('\n'), /made-up-secret|proxy\.example\.com/);
});

test("a proxy only npm uses (~/.npmrc): the registry is not asked, every other host is, and one that cannot be reached stops the move", LINUX_ONLY, async () => {
  const needs = N.networkNeeds(root);
  const proxy = 'https-proxy in ~/.npmrc';
  const plan = { user: { name: 'hoprig', uid: null, gid: null, home: '/home/hoprig' }, make: true, network: needs, proxy, dirs };
  const asked = [];
  const said = [];
  const reachFetch = async (url) => {
    asked.push(new URL(url).host);
    if (url.includes('nodejs.org')) throw new Error('connect ETIMEDOUT');
    return { ok: true, status: 200 };
  };
  const r = await noRealFetch(() => R.runMove(plan, { say: (l) => said.push(l), steps: never, low: { reachFetch } }));
  assert.deepEqual(r, { ok: false, step: 'network' });
  assert.deepEqual(asked.sort(), ['claude.ai', 'downloads.claude.ai', 'github.com', 'nodejs.org', 'raw.githubusercontent.com']);
  assert.deepEqual(said, [
    'registry.npmjs.org was not checked: npm goes out through a proxy (https-proxy in ~/.npmrc). The other hosts are checked, because nvm, Node.js\'s download and Claude Code\'s installer do not use it.',
    "The move needs the network for the user hoprig's own install, and nodejs.org could not be reached: nothing was made or copied, and root's Hoprig works as before. Check that this server can reach the internet (its firewall or its provider), then run the move again: hoprig move-to-user --yes --user hoprig",
  ]);
  // A proxy of the environment: nothing is asked (every part of the install inherits it).
  assert.deepEqual(N.toCheck(needs, 'HTTPS_PROXY'), []);
  assert.deepEqual(N.toCheck(needs, null), needs);
  // The dry run's line says which host is not checked and that the others are.
  // Root's ~/.npmrc, as the look reads it (handed in: the file itself is not written into this test's root).
  const npmrc = path.join(root, '.npmrc');
  const readFile = (f, ...a) => (f === npmrc ? 'https-proxy=http://alex:made-up-secret@proxy.example.com:3128\n' : fs.readFileSync(f, ...a));
  const out = [];
  assert.equal(await noRealFetch(() => M.main(['--dry-run'], { io: { ...io, readFile }, cfg: {}, out: (l) => out.push(l), err: (l) => out.push(l) })), 0, out.join('\n'));
  assert.ok(out.includes("The user hoprig's own install needs the network (Node.js and the packages come from there): registry.npmjs.org, nodejs.org, raw.githubusercontent.com, github.com, claude.ai and downloads.claude.ai. npm goes out through a proxy (https-proxy in ~/.npmrc), so the move does not check registry.npmjs.org itself; it checks the others before it makes or copies anything (nvm, Node.js's download and Claude Code's installer do not use that proxy)."), out.join('\n'));
  assert.doesNotMatch(out.join('\n'), /made-up-secret|proxy\.example\.com/);
});

test('a host that answers with a certificate Node does not trust (a private registry) counts as reached', async () => {
  // A server of the test's own on 127.0.0.1 with a certificate it signed itself: the real fetch, never the network.
  const https = await import('node:https');
  const { makeCert } = await import('../machines/certs.mjs');
  const c = makeCert({ cn: '127.0.0.1', ips: ['127.0.0.1'] });
  const srv = https.createServer({ key: c.keyPem, cert: c.cert }, (q, res) => ((res.statusCode = 401), res.end()));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const closed = await new Promise((r) => { const t = https.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  try {
    const needs = [{ host: `127.0.0.1:${port}`, url: `https://127.0.0.1:${port}/` }, { host: `127.0.0.1:${closed}`, url: `https://127.0.0.1:${closed}/` }];
    assert.deepEqual(await N.reachAll(needs, { fetch: globalThis.fetch, ms: 3000 }), { ok: false, unreached: [`127.0.0.1:${closed}`] });
  } finally {
    srv.close();
  }
});
