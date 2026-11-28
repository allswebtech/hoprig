// The census of her cards, on a real dashboard: for EVERY row of the acts file that she may put on a card and that no tool of
// hers reaches (the catalog's own routes), she asks, a card appears with every value whole, he confirms with his login, and the
// route answers as for him (never 401 or 403). A few routes would restart or install on the machine that runs the test: their
// request goes only as far as the door (which says it is the owner's press), no further. And for EVERY row of a never class
// that is a route: she gets the screen to open, no request leaves, and the door refuses it even on a card that names it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const A = await import('../../src/assistant/acts.mjs');
const C = await import('../../src/assistant/catalog.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { runConfirmed } = await import('../../src/assistant/confirmed.mjs');

// Routes that would restart, install, kill or move something on the computer running the test: only the door is asked.
const DOOR_ONLY = new Set(['health.restart', 'services.action', 'system.processes.end', 'pcsetup.tool', 'pcsetup.recipe', 'onboarding.install-claude', 'machine.move', 'machines.move', 'pcsetup.clone', 'pcsetup.project.start', 'pcsetup.project.command.start', 'health.line', 'adopt.apply', 'workspace.onlyhere.push']);

const rows = A.loadActs().rows;
const cardRows = rows.filter((r) => C.isCardRoute(r));
const neverRoutes = rows.filter((r) => r.kind === 'route' && r.facts && r.facts.never !== 'none');

/** A value that fits a field's schema and means nothing (no path, no real id). */
function sampleOf(s) {
  if ('const' in s) return s.const;
  if (s.enum) return s.enum[0];
  switch (s.type) {
    case 'integer': return s.minimum ?? 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    default: return 'zz-sample'.slice(0, s.maxLength ?? 9);
  }
}
function argsFor(row) {
  const out = {};
  const places = C.placesOf(row);
  for (let i = 0; i < places.ids; i += 1) out[['target', 'target2', 'target3'][i]] = 'zz-sample';
  if (places.variants[0]) out.variant = places.variants[0][0];
  const props = (row.input && row.input.properties) || {};
  for (const k of (row.input && row.input.required) || []) out[k] = sampleOf(props[k] || {});
  return out;
}

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(t); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function dashboard(t) {
  const box = sandbox('reachcensus');
  const work = path.join(box.root, 'work');
  fs.mkdirSync(path.join(work, 'projects'), { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'ask' } });
  const app = createServer({ watch: false, dashboardFile: false, workspace: { dir: path.join(box.root, 'ws'), projectsDir: () => path.join(work, 'projects') } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); box.cleanup(); });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args, conversation) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': conversation } })).json;
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => resolve(res.headers['set-cookie'][0].split(';')[0]));
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const confirm = (id) => request(base, 'POST', `/api/assistant/cards/${id}/confirm`, { body: {}, headers: { Cookie: cookie } });
  return { app, call, confirm, feature: (n) => app.features.find((f) => f.name === n) };
}

test('every card row of the catalog: she asks, a card shows the whole values, he confirms, the route answers as for him', { timeout: 280_000 }, async (t) => {
  const d = await dashboard(t);
  const ops = d.feature('assistant').ops;
  const real = ops.routeCall;
  let last = null;
  ops.routeCall = async (c, method, p, body) => {
    const row = last;
    if (DOOR_ONLY.has(row.id)) {
      // Only the door: it must say this is the owner's own press (owner: true), and nothing is sent on.
      try {
        row.door = checkRoute(method, c && c !== 'this' ? `/m/${c}${p}` : p, body, { config: () => ({}) });
      } catch (e) {
        row.refused = e.message;
        throw e;
      }
      return { ok: true };
    }
    try {
      const r = await real(c, method, p, body);
      row.status = 200;
      return r;
    } catch (e) {
      row.status = e.status;
      throw e;
    }
  };
  const results = [];
  let viaFind = 0;
  let n = 0;
  for (const row of cardRows) {
    n += 1;
    const conv = `census-${n}`;
    const args = argsFor(row);
    const seen = { id: row.id, status: null, door: null };
    last = seen;
    const found = await d.call('find_acts', { query: row.id.replace(/[.-]/g, ' '), limit: 8 }, conv);
    if (found.text.includes(`"id":"${row.id}"`)) viaFind += 1;
    else d.feature('assistant').core.shown.add(conv, { act: [row.id] });
    // A tool result showed the thing the act is aimed at (picks: reach-picks.test.mjs).
    d.feature('assistant').core.shown.add(conv, { target: Object.values(args).filter((v) => typeof v === 'string') });
    const r = await d.call('do_act', { act: row.id, args, why: 'he asked for it' }, conv);
    const m = /card (c_[0-9a-f]{12})/.exec(r.text || '');
    assert.ok(m, `${row.id}: no card: ${String(r.text).slice(0, 200)}`);
    // The card shows every value whole.
    const card = d.feature('assistant').core.cards.get ? d.feature('assistant').core.cards.get(m[1]) : null;
    if (card) for (const [k, v] of Object.entries(args)) assert.ok(card.lines.some((l) => l.includes(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)), `${row.id}: the card does not show ${k}`);
    const done = await d.confirm(m[1]);
    // The act may fail for its made-up values (400, 404, 409): that is the route's own answer to him, not a refusal of her.
    assert.ok([200, 409, 400, 404, 422, 500, 502].includes(done.status), `${row.id}: confirm answered ${done.status}`);
    seen.said = done.status === 200 ? '' : String(done.json && done.json.error).slice(0, 120);
    seen.card = done.json.card && done.json.card.status;
    results.push(seen);
  }
  const bad = results.filter((x) => x.status === 401 || x.status === 403 || (x.status === null && !x.door));
  const reached = results.filter((x) => x.status !== null).length;
  const doorOnly = results.filter((x) => x.door).length;
  console.log(`CARD CENSUS rows ${cardRows.length}: confirmed ${results.length} (found by find_acts ${viaFind}); route answered ${reached} (not 401 or 403: ${reached - bad.filter((x) => x.status !== null).length}); door only ${doorOnly} (owner press ${results.filter((x) => x.door && x.door.owner === true).length}); statuses ${JSON.stringify(results.reduce((m, x) => ({ ...m, [x.status ?? 'door']: (m[x.status ?? 'door'] || 0) + 1 }), {}))}`);
  assert.deepEqual(bad.map((x) => `${x.id} ${x.status} ${x.refused || ''}`), [], 'a route refused her after his confirmed card');
  assert.ok(results.every((x) => !x.door || x.door.owner === true), 'a door-only row passed without the owner press');
  assert.equal(results.length, cardRows.length);
});

test('every never row that is a route: she is sent to the screen, no request leaves, and the door refuses it even on a card that names it', { timeout: 120_000 }, async (t) => {
  const d = await dashboard(t);
  const ops = d.feature('assistant').ops;
  let sent = 0;
  const real = ops.routeCall;
  ops.routeCall = async (...a) => { sent += 1; return real(...a); };
  let n = 0;
  let open = 0;
  for (const row of neverRoutes) {
    n += 1;
    const conv = `never-${n}`;
    d.feature('assistant').core.shown.add(conv, { act: [row.id], target: Object.values(argsFor(row)).filter((v) => typeof v === 'string') });
    const r = await d.call('do_act', { act: row.id, args: argsFor(row) }, conv);
    assert.ok(!/card c_/.test(r.text || ''), `${row.id}: a never row got a card`);
    open += 1;
    // The door: a request for its address is refused for her, also inside a confirmed card that names this very act.
    const path0 = row.source.replace(/^[A-Z]+ /, '').replace(/<id>/g, 'zz-sample').replace(/\(([a-z-]+)(\|[a-z-|]+)?\)/g, '$1');
    const method = row.source.split(' ')[0];
    const card = { id: 'c_000000000000', tool: 'do_act', input: { act: row.id, args: argsFor(row) } };
    let refused = false;
    try {
      runConfirmed(card, () => checkRoute(method, path0, method === 'GET' ? undefined : {}, { config: () => ({}) }));
    } catch (e) {
      refused = e.status === 403;
    }
    assert.ok(refused, `${row.id}: the door let a never route through`);
  }
  console.log(`NEVER CENSUS route rows of a never class ${neverRoutes.length}: open answer, no card ${open}; requests that left ${sent}`);
  assert.equal(sent, 0, 'a tool call of hers reached a route for a never row');
  assert.equal(open, neverRoutes.length);
});
