// The card of the wall on the dashboard (src/server/deck.mjs): a session whose run record keeps a hold (hook.mjs
// `held`) carries `held` on its card where Hands-off is offered, with what it wanted to run, why it is the owner's and
// what Yes and No do; where it is not offered the card carries nothing of it. And the project's view lists, on every
// read, the sessions its switch cannot cover (src/server/handsoff.mjs `uncovered`), so the line stays after a reload.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

// Hands-off is not offered on Windows (src/handsoff.mjs handsOffOffered): a test that switches it on or reads its
// answer gets 409 or nothing there.
const OFFERED = { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' };

const box = sandbox('wall-card-server');
test.after(() => box.cleanup());
process.env.HOPRIG_TERM_ID = 'pty-1';
const SHOP = path.join(box.home, 'shop');
fs.mkdirSync(SHOP, { recursive: true });

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { WALL_REASON } = await import('../../src/wall.mjs');
const R = await import('../../src/runs.mjs');
const { readRun } = await import('../../src/runfile.mjs');
const V = hoprigVersion();

const BASE = { launcher: ['launcher'], server: { roots: [box.home], passwordHash: await hashPassword('right-password') } };
saveConfig(BASE);
let screenNow = '';
const backend = {
  list: async () => [{ id: 'pty-1', session: 'shop', cwd: SHOP, pid: process.pid, active: true, activity: Date.now(), created: Date.now(), command: 'claude' }],
  capture: async () => screenNow, kind: 'pty', capabilities: {},
};
const app = createServer({ backend, watch: false, dashboardFile: false });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const HELD = { kind: 'push', why: 'push', part: 'git push origin main', length: 20, partOf: true, tool: 'Bash', at: 1_700_000_000_000 };
function heldSession() {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), sessionId: '11111111-2222-3333-4444-555555555555', status: 'attention', asks: ['main'], askType: 'permission', askWhat: 'cd app && npm test && git push origin main', askAt: 1, held: HELD }));
  return file;
}

test('offered: the card of a held act says what, why, and what Yes and No do', OFFERED, async () => {
  saveConfig({ ...BASE, handsOff: { offered: true } });
  const file = heldSession();
  test.after(() => R.removeRun(file));
  const s = (await call('GET', '/api/sessions/shop')).json.session;
  assert.equal(s.status, 'attention');
  assert.deepEqual(s.held, { title: 'A push to the main branch or a tag', what: 'git push origin main', more: 0, partOf: true, file: false, reason: WALL_REASON.push, yes: 'Allow runs it this once.', no: 'Do not allow: it does not run, and the session stops and waits for your message.', tool: 'Bash', at: HELD.at });
  R.removeRun(file);
});

test('offered:false (hidden): the card carries nothing of the hold, whatever the record keeps', async () => {
  saveConfig({ ...BASE, handsOff: { offered: false } }); // the owner hid the feature; saveConfig replaces handsOff
  const file = heldSession();
  try {
    const s = (await call('GET', '/api/sessions/shop')).json.session;
    assert.equal('held' in s, false);
  } finally {
    R.removeRun(file);
  }
});

test('the project\'s view names the sessions it cannot cover on every read, not only in the answer to the press', OFFERED, async () => {
  saveConfig({ ...BASE, handsOff: { offered: true } });
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), termName: 'shop', status: 'waiting' })); // no hold in its handed settings
  const on = await call('POST', '/api/handsoff/project', { dir: SHOP, on: true });
  assert.deepEqual(on.json.uncovered, ['shop']);
  const real = fs.realpathSync(SHOP);
  for (let i = 0; i < 2; i++) {
    const all = (await call('GET', '/api/handsoff')).json.projects.find((p) => p.dir === real);
    assert.deepEqual(all.uncovered, ['shop'], 'read again (a reload): still named');
    assert.deepEqual((await call('GET', `/api/handsoff?dir=${encodeURIComponent(SHOP)}`)).json.uncovered, ['shop']);
  }
  R.removeRun(file);
  const gone = (await call('GET', '/api/handsoff')).json.projects.find((p) => p.dir === real);
  assert.equal('uncovered' in gone, false, 'the session ended: the line goes');
  await call('POST', '/api/handsoff/project', { dir: SHOP, on: false });
});

// A held act is the owner's own and is answered once: the card must not carry "Allow, and don't ask again" even when
// the tool's dialog draws that option (src/server/deck.mjs card.always). A plain permission still carries it.
const ALWAYS_SCREEN = fs.readFileSync(new URL('./fixtures/claude-screens/perm-fetch-80.txt', import.meta.url), 'utf8');

test('a held act carries no "Allow, and don\'t ask again", though a plain permission on the same screen does', OFFERED, async () => {
  saveConfig({ ...BASE, handsOff: { offered: true } });
  screenNow = ALWAYS_SCREEN;
  try {
    // A plain permission (no hold): the screen's option reaches the card, so the screen truly offers it.
    const { file: plain } = R.createRun({ profile: 'api', cwd: SHOP });
    fs.writeFileSync(plain, JSON.stringify({ ...readRun(plain), sessionId: '11111111-2222-3333-4444-555555555555', status: 'attention', asks: ['main'], askType: 'permission', askWhat: 'fetch example.com', askAt: 1 }));
    const noHold = (await call('GET', '/api/sessions/shop')).json.session;
    assert.ok(noHold.always && noHold.always.key === '2', 'the screen offers the option for a plain permission');
    R.removeRun(plain);
    // The same screen, but the call was held by the wall: no "don't ask again" for his own act.
    const held = heldSession();
    const s = (await call('GET', '/api/sessions/shop')).json.session;
    assert.ok(s.held, 'the held card is shown');
    assert.equal(s.always, null, 'no lasting-rule answer beside a held act');
    R.removeRun(held);
  } finally {
    screenNow = '';
  }
});
