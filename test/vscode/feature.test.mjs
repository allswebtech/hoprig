// VS Code in the dashboard, against a stand-in VS Code server (fixtures/fake-code.mjs) inside the real dashboard
// server: the login, the private socket, the dashboard's cookie never passed on, the WebSocket upgrade, which folders
// may be opened, the license and the switch, the idle stop, "open on this computer", and another computer's token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('vscode');
test.after(() => box.cleanup());

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-code.mjs');
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { upstreamCookie } = await import('../../src/vscode/proxy.mjs');
const { cleanVscodePatch, desktopAvailable, vscodeSettings } = await import('../../src/vscode/feature.mjs');

const projects = path.join(box.root, 'projects');
const proj = path.join(projects, 'app');
fs.mkdirSync(proj, { recursive: true });
const outside = path.join(box.root, 'elsewhere');
fs.mkdirSync(outside);
const log = path.join(box.root, 'fake.log');
const opened = path.join(box.root, 'opened.txt');
const desktop = path.join(box.root, 'desktop.mjs');
fs.writeFileSync(desktop, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(opened)}, process.argv.slice(2).join('\\n'));\n`);

saveConfig({ server: { passwordHash: await hashPassword('right-password'), port: 1, roots: [projects] } });
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
const env = { ...process.env, FAKE_CODE_LOG: log, ANTHROPIC_API_KEY: 'must-not-pass', HOPRIG_PROFILE: 'p1', DISPLAY: ':9' };
const app = createServer({
  backend, watch: false, machines: { claudeVersion: async () => null },
  vscode: { command: [process.execPath, FAKE], desktopCommand: [process.execPath, desktop], env, platform: 'linux', dataDir: path.join(box.root, 'vsdata'), readyMs: 10_000, tickMs: 60_000 },
});
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
const feature = app.features.find((f) => f.name === 'vscode');
test.after(() => app.close());

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie') }));
const cookie = (await post('/api/login', { password: 'right-password' })).cookie.split(';')[0];
const get = (p, headers = {}) => fetch(base + p, { headers: { Cookie: cookie, ...headers }, redirect: 'manual' });
const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const folderUrl = (dir) => `/vscode/?folder=${encodeURIComponent(dir)}`;

test('vscode: off until the license is accepted and it is turned on; then settings are kept', async () => {
  let r = await get(folderUrl(proj));
  assert.equal(r.status, 403);
  assert.match(await r.text(), /off/);
  const st = await (await get('/api/vscode')).json();
  assert.deepEqual([st.installed, st.enabled, st.license.accepted, st.running, st.idleMinutes], [true, false, false, false, 15]);
  assert.equal(st.desktop.available, true, 'DISPLAY is set');
  r = await post('/api/vscode/settings', { enabled: true }, { Cookie: cookie });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /license/);
  assert.equal((await post('/api/vscode/settings', { enabled: true })).status, 401, 'needs the login');
  assert.equal((await post('/api/vscode/settings', { acceptLicense: true }, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403, 'needs this site');
  assert.equal((await post('/api/vscode/settings', { color: 'red' }, { Cookie: cookie })).status, 400);
  assert.equal((await post('/api/vscode/settings', { sshTarget: 'me@pc; rm -rf /' }, { Cookie: cookie })).status, 400);
  r = await post('/api/vscode/settings', { acceptLicense: true, enabled: true, idleMinutes: 20, sshTarget: 'me@my-pc' }, { Cookie: cookie });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.enabled, r.json.license.accepted, r.json.idleMinutes, r.json.sshTarget], [true, true, 20, 'me@my-pc']);
  assert.match(loadConfig().vscode.licenseAcceptedAt, /^\d{4}-/);
  assert.equal(lines().length, 0, 'turning it on starts nothing yet');
});

test('vscode: the login is needed; VS Code listens only on a private socket and never sees the dashboard login', async () => {
  let r = await fetch(base + folderUrl(proj), { redirect: 'manual', headers: { Accept: 'text/html' } });
  assert.deepEqual([r.status, r.headers.get('location')], [302, '/login']);
  r = await fetch(base + '/vscode/static/x.js', { redirect: 'manual' });
  assert.equal(r.status, 401);
  r = await fetch(base + folderUrl(proj), { redirect: 'manual', headers: { Cookie: 'sid=forged' } });
  assert.equal(r.status, 401, 'a made-up login cookie');
  assert.equal(lines().length, 0, 'nothing started for a stranger');

  r = await get(folderUrl(proj), { Cookie: `${cookie}; theme=dark` });
  const body = await r.text();
  assert.equal(r.status, 200);
  assert.match(body, new RegExp(`workbench /vscode/ folder=${proj}`));
  assert.deepEqual(r.headers.getSetCookie(), ['vscode-other=1; Path=/'], 'its own cookies pass');
  assert.equal(r.headers.get('content-security-policy'), "script-src 'self' 'unsafe-eval'", 'VS Code keeps its own policy');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('cross-origin-opener-policy'), null);

  const seen = lines().filter((l) => l.url);
  const last = seen[seen.length - 1];
  assert.equal(last.cookie, 'theme=dark', 'the dashboard login cookie is not passed on');
  assert.equal(last.host, `127.0.0.1:${port}`, 'VS Code writes links to the address the browser uses');
  const start = lines().find((l) => l.started);
  assert.deepEqual(start.env, [], 'no provider variable reaches VS Code');
  assert.equal(start.umask, 0o077, 'every file and socket it makes is private');
  assert.ok(start.args.includes('--accept-server-license-terms') && start.args.includes('/vscode') && start.args.includes('--without-connection-token'));
  assert.ok(!start.args.includes('--host') && !start.args.includes('--port'), 'no network port');
  const sock = start.args[start.args.indexOf('--socket-path') + 1];
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700, 'its folder is this user\'s only');
  assert.deepEqual(feature.vscode.server.target, { socketPath: sock });
});

test('vscode: only folders inside the roots, no workspace files', async () => {
  for (const p of [folderUrl(outside), folderUrl(`${proj}/../../elsewhere`), folderUrl('/'), `/vscode/?workspace=${encodeURIComponent(`${proj}/x.code-workspace`)}`, folderUrl(path.join(proj, 'missing'))]) {
    const r = await get(p);
    assert.equal(r.status, 403, p);
  }
  assert.equal((await get(folderUrl(proj))).status, 200);
  assert.equal((await post('/api/vscode/desktop', { dir: outside }, { Cookie: cookie })).status, 400);
});

test('vscode: WebSocket upgrades need this site and the login, then pass both ways', async () => {
  const wsBase = `ws://127.0.0.1:${port}/vscode/stable-x?reconnectionToken=1`;
  const refusal = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(wsBase, { headers });
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('open', () => resolve('open'));
    ws.on('error', () => {});
  });
  assert.equal(await refusal({ Cookie: cookie }), 403, 'no Origin');
  assert.equal(await refusal({ Cookie: cookie, Origin: 'https://evil.example' }), 403, 'another site');
  assert.equal(await refusal({ Origin: base }), 401, 'no login');
  const ws = new WebSocket(wsBase, { headers: { Cookie: cookie, Origin: base } });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  assert.equal(feature.vscode.openCount(), 1);
  ws.send('hi');
  assert.equal(String(await new Promise((r) => ws.once('message', r))), 'echo:hi');
  assert.equal(lines().filter((l) => l.upgrade).pop().cookie, '', 'the login cookie stays with the dashboard');
  assert.equal(feature.vscode.idleCheck(Date.now() + 10 * 3600_000), false, 'an open VS Code tab keeps it running');
  ws.close();
  await new Promise((r) => ws.once('close', r));
  for (let i = 0; i < 50 && feature.vscode.openCount(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(feature.vscode.openCount(), 0);
});

test('vscode: stopped when idle; the next page opens it again', async () => {
  const vs = feature.vscode.server;
  assert.equal(vs.running, true);
  const pid = vs.child.pid;
  assert.equal(feature.vscode.idleCheck(Date.now() + 60_000), false, 'not idle long enough');
  assert.equal(feature.vscode.idleCheck(Date.now() + 21 * 60_000), true);
  for (let i = 0; i < 100 && vs.child; i++) await new Promise((r) => setTimeout(r, 30));
  assert.equal(vs.child, null);
  assert.throws(() => process.kill(pid, 0), 'its process is gone');
  assert.ok(lines().some((l) => l.stopped));
  assert.equal((await get('/vscode/static/a.js')).status, 503, 'its files do not start it');
  assert.equal((await get(folderUrl(proj))).status, 200, 'its page does');
  assert.notEqual(vs.child.pid, pid);
});

test('vscode: turned off stops it; on this computer opens the folder with `code <folder>`', async () => {
  let r = await post('/api/vscode/desktop', { dir: proj }, { Cookie: cookie });
  assert.deepEqual([r.status, r.json], [200, { opened: true }]);
  for (let i = 0; i < 100 && !fs.existsSync(opened); i++) await new Promise((res) => setTimeout(res, 30));
  assert.equal(fs.readFileSync(opened, 'utf8'), fs.realpathSync(proj));
  r = await post('/api/vscode/settings', { enabled: false }, { Cookie: cookie });
  assert.equal(r.json.running, false);
  assert.equal(feature.vscode.server.child, null);
  assert.equal((await get(folderUrl(proj))).status, 403);
});

test('vscode: another computer\'s token reaches neither the routes nor VS Code', async () => {
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { token } = createToken('hub');
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(base + '/api/vscode', { headers: auth })).status, 403);
  const r = await fetch(base + '/api/vscode/desktop', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: proj }) });
  assert.equal(r.status, 403);
  assert.equal((await fetch(base + folderUrl(proj), { headers: auth, redirect: 'manual' })).status, 403);
});

test('vscode: the pieces', () => {
  assert.equal(upstreamCookie('sid=abc; theme=dark'), 'theme=dark');
  assert.equal(upstreamCookie('sid=abc'), null);
  assert.equal(desktopAvailable({}, 'linux'), false);
  assert.equal(desktopAvailable({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
  assert.equal(desktopAvailable({}, 'darwin'), true);
  assert.deepEqual(vscodeSettings({ vscode: { idleMinutes: 2, sshTarget: 'bad target' } }), { enabled: false, licenseAcceptedAt: null, idleMinutes: 15, sshTarget: '' });
  assert.throws(() => cleanVscodePatch({ enabled: true }, { licenseAcceptedAt: 'x', enabled: false }, { installed: false }), /not installed/);
  assert.throws(() => cleanVscodePatch({ acceptLicense: false }, {}, { installed: true }), /only be true/);
  assert.throws(() => cleanVscodePatch({ idleMinutes: 3 }, {}, { installed: true }), /5 to 1440/);
});
