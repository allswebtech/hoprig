// Two real dashboards, each in its own process with its own folders: B runs a gateway (the fake one, at the port its
// TRouteAI add-on is set to), A is the hub B is paired to by code. From A: B's gateway is listed, "Use here" turns
// sharing on there, gets a key and writes a provider on A that goes through A's own dashboard; a streamed request on
// that provider reaches the gateway with the gateway's own key. Then B goes offline: the provider's state and the
// answer to Claude Code say so in plain words.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPO } from '../machines/harness.mjs';
import { GW_KEY, fakeGateway, stream } from './fakegateway.mjs';

const BIN = path.join(REPO, 'bin', 'hoprig.mjs');
const PASSWORD = 'test-password-1';
const skip = process.platform === 'win32' && 'POSIX processes';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last))})`);
};

async function machine(root, name, setupMore = '', gwPort = 1) {
  const dir = path.join(root, name);
  const d = { config: path.join(dir, 'config'), state: path.join(dir, 'state'), profiles: path.join(dir, 'profiles'), claude: path.join(dir, 'claude') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  const port = await freePort();
  // No `trouteai` on this PATH: the add-on must never start or ask the real one.
  const env = { ...process.env, PATH: '/usr/bin:/bin', HOPRIG_CONFIG_DIR: d.config, HOPRIG_STATE_DIR: d.state, HOPRIG_PROFILES_DIR: d.profiles, CLAUDE_CONFIG_DIR: d.claude };
  const setup = `
    const { saveConfig } = await import(${JSON.stringify(path.join(REPO, 'src', 'config.mjs'))});
    const { writeProfile } = await import(${JSON.stringify(path.join(REPO, 'src', 'profiles.mjs'))});
    const { hashPassword } = await import(${JSON.stringify(path.join(REPO, 'src', 'server', 'auth.mjs'))});
    saveConfig({ addons: { trouteai: { port: ${gwPort} } }, server: { backend: 'pty', host: '127.0.0.1', port: ${port}, roots: [${JSON.stringify(dir)}], machineLabel: ${JSON.stringify(name.toUpperCase())}, passwordHash: await hashPassword(${JSON.stringify(PASSWORD)}) } });
    ${setupMore}`;
  execFileSync(process.execPath, ['--input-type=module', '-e', setup], { env });
  return { name, port, env, base: `http://127.0.0.1:${port}`, ...d, cli: (...a) => execFileSync(process.execPath, [BIN, ...a], { env, encoding: 'utf8' }) };
}

function serve(m) {
  m.child = spawn(process.execPath, [BIN, 'serve'], { env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
  m.out = '';
  m.child.stdout.on('data', (c) => (m.out += c));
  m.child.stderr.on('data', (c) => (m.out += c));
  return until(`${m.name} to listen`, async () => (await fetch(`${m.base}/login`)).status === 200);
}

async function browser(m) {
  const login = await fetch(`${m.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: m.base }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return async (p, body) => {
    const r = await fetch(m.base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: m.base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, json: JSON.parse(text || '{}'), text };
  };
}

test('a linked computer\'s gateway: listed, used with one click, streamed through both dashboards, offline in plain words', { skip, timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-gw-two-'));
  const gw = await fakeGateway();
  const b = await machine(root, 'b', `writeProfile('api', { label: 'API via TRouteAI', env: { ANTHROPIC_BASE_URL: 'http://localhost:${gw.port}', ANTHROPIC_AUTH_TOKEN: ${JSON.stringify(GW_KEY)}, ANTHROPIC_MODEL: 'combo-best' } });`, gw.port);
  const a = await machine(root, 'a');
  t.after(async () => {
    for (const m of [a, b]) if (m.child && m.child.exitCode === null) m.child.kill('SIGTERM');
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([serve(a), serve(b)]);
  const hub = await browser(a);
  const code = /([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/.exec(b.cli('pair'))[1];
  const added = await hub('/api/machines/url', { url: b.base, code, name: 'b', label: 'B' });
  assert.equal(added.status, 200, added.text);

  // Listed from A: this computer has none running, B has one that is not shared yet.
  let all = await hub('/api/gateways/all');
  assert.equal(all.status, 200, all.text);
  const [here, other] = all.json.computers;
  assert.equal(here.machine, null);
  assert.equal(here.gateways[0].running, false);
  assert.equal(other.machine, 'b');
  assert.equal(other.label, 'B');
  assert.equal(other.state, 'online');
  assert.deepEqual(other.gateways.map((g) => [g.id, g.running, g.shared, g.ready]), [['trouteai', true, false, true]]);
  assert.equal(other.gateways[0].keys, undefined, 'another dashboard does not see B\'s keys');

  // One click: sharing on there, a key from there, the provider here.
  const used = await hub('/api/gateways/use', { machine: 'b', gateway: 'trouteai', share: true });
  assert.equal(used.status, 200, used.text);
  const prof = fs.readFileSync(path.join(a.profiles, `${used.json.name}.env`), 'utf8');
  assert.match(prof, new RegExp(`ANTHROPIC_BASE_URL=http://127.0.0.1:${a.port}/gateway/m/b/trouteai`));
  assert.match(prof, /ANTHROPIC_AUTH_TOKEN=hop_gw_/);
  assert.match(prof, /ANTHROPIC_MODEL=combo-best/);
  assert.doesNotMatch(prof, /PRERUN/, 'nothing is started on A');
  assert.equal(prof.includes(GW_KEY), false, 'the gateway\'s own key never left B');
  assert.equal(used.text.includes('hop_gw_'), false, 'the key is not sent to the page');
  const key = /ANTHROPIC_AUTH_TOKEN=(\S+)/.exec(prof)[1];
  assert.equal((await hub('/api/gateways/use', { machine: 'b', gateway: 'trouteai' })).status, 409, 'not twice');
  all = await hub('/api/gateways/all');
  assert.equal(all.json.computers[1].gateways[0].shared, true);
  assert.equal(all.json.computers[1].gateways[0].usedAs.name, used.json.name);

  // Claude Code on A: its provider's address and key.
  const before = gw.seen.length;
  const r = await stream(`http://127.0.0.1:${a.port}/gateway/m/b/trouteai/v1/messages`, {
    headers: { authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'combo-best', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'Hi' }] }),
  });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /message_start[\s\S]*message_stop/);
  assert.ok(r.chunks.length >= 2 && r.chunks.at(-1).at - r.chunks[0].at >= 200, 'streamed through both dashboards');
  const seen = gw.seen.slice(before);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${GW_KEY}`);
  assert.equal(JSON.stringify(seen[0].headers).includes('hop_'), false, 'neither the gateway key nor a machine token reaches the gateway');
  const wrong = await stream(`http://127.0.0.1:${a.port}/gateway/m/b/trouteai/v1/messages`, { headers: { authorization: `Bearer hop_gw_${'z'.repeat(43)}` }, body: '{}' });
  assert.equal(wrong.status, 401);

  let accounts = await hub('/api/accounts');
  assert.deepEqual(accounts.json.accounts.find((x) => x.name === used.json.name).remote, { computer: 'B', title: 'TRouteAI', state: 'online', text: 'On B' });

  // B goes away.
  b.child.kill('SIGTERM');
  await until('B to stop', () => b.child.exitCode !== null || b.child.signalCode !== null);
  const off = await stream(`http://127.0.0.1:${a.port}/gateway/m/b/trouteai/v1/messages`, { headers: { authorization: `Bearer ${key}` }, body: '{}' });
  assert.equal(off.status, 502);
  assert.match(JSON.parse(off.text).error.message, /B is offline or its dashboard is not running/);
  accounts = await until('the offline state', async () => {
    const x = await hub('/api/accounts');
    const s = x.json.accounts.find((y) => y.name === used.json.name).remote;
    return s && s.state === 'offline' ? s : null;
  });
  assert.match(accounts.text, /offline/);
  assert.equal(`${a.out}${b.out}`.includes('hop_gw_'), false, 'no key in either log');
  assert.equal(`${a.out}${b.out}`.includes(GW_KEY), false);
});
