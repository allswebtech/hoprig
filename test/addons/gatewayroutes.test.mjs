// The page's Add a gateway and Remove (src/addons/gatewayroutes.mjs) over real HTTP: the first answer is the question
// with the exact program and arguments, nothing is written until it comes back with confirmed: true; only the owner's
// own signed-in page may do it (not a request without its cookie, as Tia's in-process ones are, not a machine token);
// the add-ons list then shows what the gateway runs, no Install for a program, and the accounts route offers it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewayroutes');
test.after(() => box.cleanup());
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = await freePort();
const relay = path.join(box.root, 'relay');
fs.writeFileSync(relay, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { gatewayRoutes } = await import('../../src/addons/gatewayroutes.mjs');
saveConfig({ server: { passwordHash: await hashPassword('right-password') }, addons: { trouteai: { port: await freePort() } } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const app = createServer({ backend, watch: false, dashboardFile: false });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
async function call(p, body, headers = { Cookie: cookie }) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: JSON.parse((await r.text()) || '{}') };
}
const definition = { id: 'relay', title: 'Relay', bin: relay, port: PORT, args: ['--port', 'PORT'], dashboard: '/' };
const defined = () => loadConfig().gateways?.defined || [];

test('add: the question first with exactly what it runs, then the owner\'s yes', async () => {
  let r = await call('/api/gateways/defined/add', { definition: { ...definition, args: ['--port', '$(id)'] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /the arguments use only/);
  r = await call('/api/gateways/defined/add', { definition });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.match(r.json.confirm, /Relay is a program Hoprig will run on this computer/);
  assert.ok(r.json.runs.includes(`  ${relay} --port ${PORT}`), r.json.runs.join('\n'));
  assert.deepEqual(defined(), [], 'nothing written before the yes');
  assert.equal((await call('/api/gateways/defined/add', { definition, confirmed: true })).status, 400, 'a yes without the program it was shown');
  r = await call('/api/gateways/defined/add', { definition, confirmed: true, pin: r.json.pin });
  assert.deepEqual(r.json, { ok: true, id: 'relay' });
  assert.deepEqual(defined().map((d) => d.id), ['relay']);

  const list = (await call('/api/addons')).json.addons;
  assert.deepEqual(list.map((a) => a.id), ['trouteai', 'relay', 'public-link']);
  const a = list.find((x) => x.id === 'relay');
  assert.deepEqual([a.installable, a.defined, a.command, a.installed, a.page], [false, true, [relay, '--port', String(PORT)], true, `http://localhost:${PORT}`]);
  assert.equal('installable' in list[0] || 'defined' in list[0], false, 'the shipped one answers as before');
  const acc = (await call('/api/accounts')).json;
  assert.deepEqual(acc.gateways.map((g) => [g.id, g.title, g.installable, g.page, g.defaults.name, g.defaults.label]), [
    ['trouteai', 'TRouteAI', true, `http://localhost:${loadConfig().addons.trouteai.port}`, 'api', 'API via TRouteAI'],
    ['relay', 'Relay', false, `http://localhost:${PORT}`, 'relay', 'API via Relay'],
  ]);
});

test('only a browser signed in to this dashboard: not without its cookie (Tia\'s requests), not with a machine token', async () => {
  const routes = gatewayRoutes({ HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } }, readJson: async () => ({ definition, confirmed: true }) });
  // What it asks for, as it holds: a browser signed in to this dashboard (any such one), not "this computer's own page".
  for (const [, , fn] of routes) await assert.rejects(fn({ headers: {} }, []), (e) => e.status === 403 && /a browser signed in to this computer's own dashboard/.test(e.message));
  const r = await call('/api/gateways/defined/remove', { id: 'relay', confirmed: true }, { Authorization: `Bearer hop_${'x'.repeat(40)}` });
  assert.ok(r.status === 401 || r.status === 403, String(r.status));
  assert.deepEqual(defined().map((d) => d.id), ['relay']);
});

test('remove: the question first, then it is gone; a shipped gateway is never removed', async () => {
  assert.equal((await call('/api/gateways/defined/remove', { id: 'trouteai', confirmed: true })).status, 400);
  let r = await call('/api/gateways/defined/remove', { id: 'relay' });
  assert.equal(r.json.ok, false);
  assert.match(r.json.confirm, /Relay is stopped if it runs, and forgotten/);
  assert.equal(defined().length, 1);
  r = await call('/api/gateways/defined/remove', { id: 'relay', confirmed: true });
  assert.deepEqual(r.json, { ok: true });
  assert.deepEqual(defined(), []);
  assert.equal((await call('/api/gateways/defined/remove', { id: 'relay', confirmed: true })).status, 404);
});

test('the page\'s Remove never ends a program Hoprig did not start on the gateway\'s port', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = await import('node:child_process');
  const port = await freePort();
  const other = spawn(process.execPath, ['-e', `require('node:http').createServer((q, s) => s.end('mine')).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 50));
    saveConfig({ gateways: { ...loadConfig().gateways, defined: [{ ...definition, id: 'relay', port }] } });
    const r = await call('/api/gateways/defined/remove', { id: 'relay', confirmed: true });
    assert.deepEqual(r.json, { ok: true });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(await fetch(`http://127.0.0.1:${port}/`).then((x) => x.text(), () => null), 'mine', 'it still answers');
  } finally {
    other.kill('SIGKILL');
  }
});

test('an error about one part of the form says which, and how the page can say it under its own label', async () => {
  const cases = [
    [{}, 'id'],
    [{ id: 'relay-z', title: '' }, 'title'],
    [{ id: 'relay-z', title: 'Relay Z', port: 'x' }, 'port'],
    [{ id: 'relay-z', title: 'Relay Z', port: PORT + 1 }, 'bin'],
    [{ id: 'relay-z', title: 'Relay Z', port: PORT + 1, bin: 'relay-nowhere' }, 'bin'],
    [{ id: 'relay-z', title: 'Relay Z', port: PORT + 1, bin: relay, args: ['--port'] }, 'args'],
    [{ id: 'relay-z', title: 'Relay Z', port: PORT + 1, bin: relay, dashboard: 'dash' }, 'dashboard'],
    [{ id: 'relay-z', title: 'Relay Z', port: PORT + 1, npm: 'Not A Package' }, 'npm'],
  ];
  for (const [d, field] of cases) {
    const r = await call('/api/gateways/defined/add', { definition: d });
    assert.equal(r.status, 400, JSON.stringify(d));
    assert.equal(r.json.field, field, `${JSON.stringify(d)}: ${r.json.error}`);
    assert.ok(['title', 'id', 'bin', 'port', 'args', 'dashboard', 'npm'].includes(field), 'one the page has a label for (test/server/web.test.mjs)');
    assert.doesNotMatch(r.json.hint, /\b(id|title|bin|dashboard)\b/, `the hint names no key: ${r.json.hint}`);
  }
});

test('the add-ons list says which definitions of config.json were not loaded, and why', async () => {
  const keep = loadConfig().gateways;
  saveConfig({ gateways: { ...keep, defined: [{ id: 'relay', title: 'Relay', bin: relay, port: loadConfig().addons.trouteai.port }] } });
  try {
    const r = (await call('/api/addons')).json;
    assert.deepEqual(r.skipped.map((x) => x.id), ['relay']);
    assert.match(r.skipped[0].error, /port \d+ is TRouteAI's/);
    assert.equal(r.addons.some((a) => a.id === 'relay'), false);
  } finally {
    saveConfig({ gateways: keep });
  }
});

test('a provider whose gateway was removed is marked: its sessions would not start', async () => {
  const { deleteProfile, writeProfile } = await import('../../src/profiles.mjs');
  const start = (id) => `${process.execPath} /x/bin/hoprig.mjs addons start ${id}`;
  writeProfile('via-gone', { label: 'API via Relay', prerun: start('relay-gone'), env: { ANTHROPIC_BASE_URL: 'http://localhost:7777', ANTHROPIC_AUTH_TOKEN: 'k' } });
  writeProfile('via-shipped', { label: 'API via TRouteAI', prerun: start('trouteai'), env: { ANTHROPIC_BASE_URL: 'http://localhost:20017', ANTHROPIC_AUTH_TOKEN: 'k' } });
  writeProfile('with-link', { label: 'With the link', prerun: start('public-link'), env: { ANTHROPIC_API_KEY: 'k' } });
  try {
    const acc = (await call('/api/accounts')).json.accounts;
    const of = (n) => acc.find((a) => a.name === n);
    assert.deepEqual(of('via-gone').gatewayGone, { id: 'relay-gone' }, 'removed: no reason');
    assert.equal(of('via-gone').viaGateway, null);
    assert.equal('gatewayGone' in of('via-shipped'), false, 'its gateway is there');
    assert.equal('gatewayGone' in of('with-link'), false, 'the public link is no gateway');
  } finally {
    for (const n of ['via-gone', 'via-shipped', 'with-link']) deleteProfile(n);
  }
});

test('the page\'s yes counts only for the file it was shown: a program changed after the question adds nothing', { skip: process.platform === 'win32' }, async () => {
  const file = path.join(box.root, 'relay-shown');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const def = { id: 'relay-shown', title: 'Relay Shown', bin: file, port: await freePort() };
  const asked = await call('/api/gateways/defined/add', { definition: def });
  assert.equal(asked.json.ok, false);
  const before = defined().length;
  fs.writeFileSync(file, '#!/bin/sh\necho another program\n', { mode: 0o755 }); // changed between the question and the yes
  const r = await call('/api/gateways/defined/add', { definition: def, confirmed: true, pin: asked.json.pin });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /not the one you were shown/);
  assert.equal(defined().length, before, 'nothing written');
});

test('a gateway in config.json that was not loaded: its provider says so and why, and the page\'s Remove takes it out', async () => {
  const { deleteProfile, writeProfile } = await import('../../src/profiles.mjs');
  const keep = loadConfig().gateways;
  // Written by hand with a word the arguments may not use.
  saveConfig({ gateways: { ...keep, defined: [...(keep?.defined || []), { id: 'relay-hand', title: 'Relay Hand', bin: relay, port: await freePort(), args: ['$(id)', 'PORT'] }] } });
  writeProfile('via-hand', { label: 'API via Relay Hand', prerun: `${process.execPath} /x/bin/hoprig.mjs addons start relay-hand`, env: { ANTHROPIC_BASE_URL: 'http://localhost:7778', ANTHROPIC_AUTH_TOKEN: 'k' } });
  try {
    const acc = (await call('/api/accounts')).json.accounts;
    const gone = acc.find((a) => a.name === 'via-hand').gatewayGone;
    assert.equal(gone.id, 'relay-hand');
    assert.match(gone.notLoaded, /the arguments use only/);
    let r = await call('/api/gateways/defined/remove', { id: 'relay-hand' });
    assert.equal(r.json.ok, false);
    assert.match(r.json.confirm, /The gateway relay-hand is taken out of config\.json\. It was not loaded \(.*\), so Hoprig does not stop it\. The provider API via Relay Hand starts it/);
    r = await call('/api/gateways/defined/remove', { id: 'relay-hand', confirmed: true });
    assert.deepEqual(r.json, { ok: true });
    assert.equal(defined().some((d) => d.id === 'relay-hand'), false);
  } finally {
    deleteProfile('via-hand');
    saveConfig({ gateways: keep });
  }
});

test('Confirm the new program: the question shows the file as it is now, a yes for another file changes nothing, sharing and keys stay', { skip: process.platform === 'win32' }, async () => {
  const K = await import('../../src/gateway/keys.mjs');
  const { fileSha256 } = await import('../../src/addons/localgateway.mjs');
  const file = path.join(box.root, 'relay-update');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const def = { id: 'relay-up', title: 'Relay Up', bin: file, port: await freePort() };
  const q = await call('/api/gateways/defined/add', { definition: def });
  assert.deepEqual((await call('/api/gateways/defined/add', { definition: def, confirmed: true, pin: q.json.pin })).json, { ok: true, id: 'relay-up' });
  K.setShared('relay-up', 'relay-up');
  const key = K.createKey('relay-up', 'laptop').key;
  try {
    assert.deepEqual((await call('/api/gateways/defined/confirm', { id: 'relay-up' })).json, { ok: true, already: true });
    fs.writeFileSync(file, '#!/bin/sh\necho version 2\n', { mode: 0o755 }); // the owner updates it
    const row = (await call('/api/addons')).json.addons.find((a) => a.id === 'relay-up');
    assert.equal(row.needsConfirm, 'changed', 'the add-ons list says so');
    let asked = await call('/api/gateways/defined/confirm', { id: 'relay-up' });
    assert.equal(asked.json.ok, false);
    assert.match(asked.json.confirm, /The program of Relay Up changed since you confirmed it/);
    assert.ok(asked.json.runs.includes(`Its fingerprint (sha256) now: ${fileSha256(file)}`), asked.json.runs.join('\n'));
    assert.deepEqual(asked.json.pin, { bin: file, sha256: fileSha256(file) });
    assert.equal((await call('/api/gateways/defined/confirm', { id: 'relay-up', confirmed: true })).status, 400, 'a yes without the program it was shown');
    fs.writeFileSync(file, '#!/bin/sh\necho version 3\n', { mode: 0o755 }); // changed again between the question and the yes
    const late = await call('/api/gateways/defined/confirm', { id: 'relay-up', confirmed: true, pin: asked.json.pin });
    assert.equal(late.status, 400);
    assert.match(late.json.error, /not the one you were shown/);
    assert.notEqual(defined().find((d) => d.id === 'relay-up').sha256, fileSha256(file), 'nothing written');
    asked = await call('/api/gateways/defined/confirm', { id: 'relay-up' });
    assert.deepEqual((await call('/api/gateways/defined/confirm', { id: 'relay-up', confirmed: true, pin: asked.json.pin })).json, { ok: true });
    assert.equal(defined().find((d) => d.id === 'relay-up').sha256, fileSha256(file));
    assert.equal((await call('/api/addons')).json.addons.find((a) => a.id === 'relay-up').needsConfirm, undefined);
    assert.equal(K.sharedProvider('relay-up'), 'relay-up');
    assert.equal(K.verifyKey(key, 'relay-up')?.name, 'laptop');
    assert.equal((await call('/api/gateways/defined/confirm', { id: 'relay-up', confirmed: true, pin: asked.json.pin }, { Authorization: `Bearer hop_${'x'.repeat(40)}` })).status >= 401, true, 'not with a machine token');
  } finally {
    await call('/api/gateways/defined/remove', { id: 'relay-up', confirmed: true });
  }
});

test('Confirm after an update moved the link to a new folder: the page\'s question names the file it leads to now and the one confirmed', { skip: process.platform === 'win32' }, async () => {
  const { fileSha256 } = await import('../../src/addons/localgateway.mjs');
  const v1 = path.join(box.root, 'opt', 'relay-1', 'relay');
  const v2 = path.join(box.root, 'opt', 'relay-2', 'relay');
  for (const f of [v1, v2]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `#!/bin/sh\necho ${f}\n`, { mode: 0o755 });
  }
  const link = path.join(box.root, 'relay-link');
  fs.symlinkSync(v1, link);
  const def = { id: 'relay-mv', title: 'Relay Mv', bin: link, port: await freePort() };
  const q = await call('/api/gateways/defined/add', { definition: def });
  assert.equal((await call('/api/gateways/defined/add', { definition: def, confirmed: true, pin: q.json.pin })).json.ok, true);
  try {
    fs.rmSync(link);
    fs.symlinkSync(v2, link);
    fs.rmSync(path.dirname(v1), { recursive: true });
    assert.equal((await call('/api/addons')).json.addons.find((a) => a.id === 'relay-mv').needsConfirm, 'gone');
    const asked = await call('/api/gateways/defined/confirm', { id: 'relay-mv' });
    assert.match(asked.json.confirm, new RegExp(`you confirmed ${v1}, and ${link} leads to ${v2} now`));
    assert.deepEqual(asked.json.pin, { bin: v2, sha256: fileSha256(v2) });
    assert.ok(asked.json.runs.some((l) => l.startsWith(`  ${v2} `)), asked.json.runs.join('\n'));
    assert.deepEqual((await call('/api/gateways/defined/confirm', { id: 'relay-mv', confirmed: true, pin: asked.json.pin })).json, { ok: true });
    assert.equal(defined().find((d) => d.id === 'relay-mv').bin, v2);
  } finally {
    await call('/api/gateways/defined/remove', { id: 'relay-mv', confirmed: true });
  }
});
