// What Tia's cards make run BY THEMSELVES in the real dashboard (createServer), Tia on: a start, the cards' route with no
// card and with made-up ids, and three ticks of the dashboard's upkeep. Nothing new is written outside the dashboard's
// own state folder, no session starts, no coding tool or model is started.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from '../work/helpers.mjs';

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

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('Tia on, her cards\' route asked with no card and with made-up ids, three ticks: nothing new written, no session, no model', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const w = tempWork('tia-cards-byitself');
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root));
  // A coding tool or launcher that starts leaves this file behind (outside the state folder): the snapshot sees it.
  const trap = path.join(w.root, 'trap.mjs');
  fs.writeFileSync(trap, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(w.root, 'STARTED'))}, process.argv.join(' '));\n`);
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword, COOKIE } = await import('../../src/server/auth.mjs');
  saveConfig({ claudeBin: trap, launcher: [process.execPath, trap], usage: false, addons: { trouteai: { port: 8092 } }, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'work' } });
  writeProfile('sub', { label: 'Main' });
  const engines = [];
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({
    watch: false, dashboardFile: false, tmuxSocket: `tia-cards-byitself-${process.pid}`,
    assistant: { engine: { spawnImpl: (...a) => { engines.push(a); throw new Error('no engine in this test'); }, resolveEnv: async () => ({ ...process.env }) } },
  });
  t.after(async () => {
    await app.close().catch(() => {});
    w.cleanup();
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const login = await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.ok(cookie.startsWith(`${COOKIE}=`));
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  // From here: the test's own start and sign-in are done (a sign-in notes how strong the password is, in the config).
  await new Promise((res) => setTimeout(res, 500));
  const cfgFile = path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json');
  const cfgBefore = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const before = snapshot(w.root);

  // The cards' route: no card in view, and ids of no card of this dashboard.
  let r = await owner('POST', '/api/assistant/views', { ids: [] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.cards, {});
  r = await owner('POST', '/api/assistant/views', { ids: ['v_000000000000', 'v_0123456789ab'] });
  assert.deepEqual(r.json.cards, { v_000000000000: null, v_0123456789ab: null });
  assert.equal((await owner('POST', '/api/assistant/views', { ids: ['<script>'] })).status, 400, 'only card ids');
  assert.equal((await owner('POST', '/api/assistant/views/v_000000000000/undo', {})).status, 404);
  // Not by another site, not by Tia's own token.
  assert.equal((await request(base, 'POST', '/api/assistant/views', { body: { ids: [] }, headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
  const { stateDir } = await import('../../src/paths.mjs');
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  assert.equal((await request(base, 'POST', '/api/assistant/views', { body: { ids: [] }, headers: { Authorization: `Bearer ${tia}` } })).status, 403);

  for (let i = 0; i < 3; i++) await app.watcher.tick();
  await new Promise((res) => setTimeout(res, 500));
  const after = snapshot(w.root);
  const cfgAfter = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const keys = [...new Set([...Object.keys(cfgBefore), ...Object.keys(cfgAfter)])].filter((k) => JSON.stringify(cfgBefore[k]) !== JSON.stringify(cfgAfter[k]));
  const inner = Object.fromEntries(keys.map((k) => [k, Object.keys({ ...(cfgBefore[k] || {}), ...(cfgAfter[k] || {}) }).filter((x) => JSON.stringify((cfgBefore[k] || {})[x]) !== JSON.stringify((cfgAfter[k] || {})[x]))]));
  assert.deepEqual(changes(before, after).filter((f) => !f.startsWith('state/')), [], `nothing outside the dashboard's own state changed (config: ${JSON.stringify(inner)})`);
  assert.equal(fs.existsSync(path.join(w.root, 'STARTED')), false, 'no coding tool or launcher started');
  assert.deepEqual(engines, [], 'no model call');
  assert.deepEqual((await owner('GET', '/api/state')).json.sessions, [], 'no session');
});
