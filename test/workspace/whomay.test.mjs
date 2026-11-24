// Who may drop, change the groups of the map or write the rules text from the Workspace page (whomay.mjs), over real
// HTTP on a temporary home: the owner's own page (signed in, its own origin) may; another site may not; a script's
// token (hoprig pair) may not; a hub this computer joined may only with the mark its relay sets for its own page,
// never with Tia's mark; Tia's token and her door may not. The read-only check stays open to a token, without a ticket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropWorld, reset } from './dropfix.mjs';

const w = await dropWorld('whomay', { labels: ['desk'] });
const [D] = w.computers;
D.use();
process.env.HOPRIG_WORKSPACE_DIR = D.ws; // a workspace of its own: never the real one
await reset(D);
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { OWNER_PAGE_HEADER, SELF_HEADER } = await import('../../src/machines/relay.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { createServer } = await import('../../src/server/server.mjs');
saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [D.home], backend: 'pty' } });
const script = createToken('a script');
const hub = createToken('hub');
fs.writeFileSync(path.join(D.env.HOPRIG_CONFIG_DIR, 'joined.json'), JSON.stringify({ hubs: [{ id: '0123456789ab', target: 'alex@box2', port: 7433, tokenId: hub.id }] }));
// Traps first on PATH: a program this test must never reach fails loudly (the joined hub above is made up).
const traps = path.join(w.root, 'traps');
fs.mkdirSync(traps, { recursive: true });
const trapped = path.join(w.root, 'trapped.log');
for (const n of ['ssh', 'sudo', 'systemctl', 'loginctl', 'npm', 'apt-get']) fs.writeFileSync(path.join(traps, n), `#!/bin/sh\necho "${n} $*" >> '${trapped}'\nexit 99\n`, { mode: 0o755 });
process.env.PATH = `${traps}${path.delimiter}${process.env.PATH}`;
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `whomay-${process.pid}` });
// The HTTP server only: the features' start (the tunnels to joined hubs) is not wanted here.
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const { port } = app.server.address();
// The settings name the port it listens on: `hoprig pair --json` (pairInfo) knocks on the dashboard's address from
// them, and without one that is the default port, where a contributor's own dashboard listens.
saveConfig({ server: { port } });
const origin = `http://127.0.0.1:${port}`;
test.after(async () => {
  await new Promise((r) => app.server.close(r));
  assert.equal(fs.existsSync(trapped) ? fs.readFileSync(trapped, 'utf8') : '', '', 'no trapped program was started');
  w.cleanup();
});
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const post = async (p, body, headers) => {
  const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const page = { Cookie: cookie, Origin: origin };
const bearer = (t, extra = {}) => ({ Authorization: `Bearer ${t}`, ...extra });

test('a token gets the read-only check, never a ticket; the owner\'s page gets a ticket', async () => {
  for (const h of [bearer(script.token), bearer(hub.token), bearer(hub.token, { [SELF_HEADER]: '1' })]) {
    const r = await post('/api/workspace/drop/check', { name: 'shop' }, h);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ticket, undefined);
  }
  const mine = await post('/api/workspace/drop/check', { name: 'shop' }, page);
  assert.match(mine.json.ticket, /^[0-9a-f]{64}$/);
  const viaHub = await post('/api/workspace/drop/check', { name: 'shop' }, bearer(hub.token, { [OWNER_PAGE_HEADER]: '1' }));
  assert.match(viaHub.json.ticket, /^[0-9a-f]{64}$/, 'a joined hub\'s own page: the sheet on the computer that drops');
});

test('a drop: refused from a script\'s token, from Tia\'s mark, from a hub without the mark, from another site and from Tia', async () => {
  const ticket = (await post('/api/workspace/drop/check', { name: 'shop' }, page)).json.ticket;
  const tries = [
    [bearer(script.token, { [OWNER_PAGE_HEADER]: '1' }), /comes only from your own page: on this computer's dashboard, or through a main computer of yours/],
    [bearer(hub.token, { [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' }), /the owner's own step: Tia shows him the sheet/],
    [bearer(hub.token), /the main computer.s Hoprig is older than this computer.s. Update Hoprig on the main computer, then press again/],
    [bearer('tia_0123456789abcdef0123456789abcdef'), null],
    [{ Cookie: cookie, Origin: 'http://evil.example' }, /cross-site/],
  ];
  for (const [h, re] of tries) {
    const r = await post('/api/workspace/drop', { ticket, typed: 'shop' }, h);
    assert.ok(r.status === 401 || r.status === 403, `${JSON.stringify(h)}: ${r.status}`);
    if (re) assert.match(r.json.error, re);
  }
  assert.ok(fs.existsSync(D.shop), 'nothing was dropped');
  // Tia's door never reaches the drop, the groups or the rules: refused before any dispatch.
  for (const [m, p] of [['POST', '/api/workspace/drop'], ['POST', '/m/box2/api/workspace/drop'], ['POST', '/api/workspace/group'], ['POST', '/api/workspace/group/remove'], ['POST', '/api/workspace/rules']]) {
    // A real group add: refused by the body rule (only her dry run passes); the others: never routes of hers.
    assert.throws(() => checkRoute(m, p, {}), /not a route Tia's tools use|owner's own step|owner's own press/, `${m} ${p}`);
  }
  // The ticket was not used by any refused try: the owner's page drops with it.
  const ok = await post('/api/workspace/drop', { ticket }, page);
  assert.equal(ok.json.result, 'dropped', JSON.stringify(ok.json));
});

test('a group add or remove and the rules text: a dry run for anyone who may read; the change only from the owner\'s page', async () => {
  const dry = await post('/api/workspace/group', { dir: 'kits', dryRun: true }, bearer(script.token));
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  assert.equal(dry.json.dryRun, true);
  for (const [p, b] of [['/api/workspace/group', { dir: 'kits' }], ['/api/workspace/group/remove', { dir: 'kits' }], ['/api/workspace/rules', {}]]) {
    for (const h of [bearer(script.token), bearer(hub.token), bearer(hub.token, { [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' })]) {
      const r = await post(p, b, h);
      assert.equal(r.status, 403, `${p} ${JSON.stringify(h)} ${JSON.stringify(r.json)}`);
    }
  }
  const map = () => JSON.parse(fs.readFileSync(path.join(D.brain, 'workspace.json'), 'utf8'));
  assert.ok(!(map().groups || []).some((g) => g.dir === 'kits'), 'no token changed the map');
  const add = await post('/api/workspace/group', { dir: 'kits' }, page);
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.ok(map().groups.some((g) => g.dir === 'kits'));
  const hubAdd = await post('/api/workspace/group', { dir: 'more' }, bearer(hub.token, { [OWNER_PAGE_HEADER]: '1' }));
  assert.equal(hubAdd.status, 200, 'a joined hub\'s own page may');
  const rm = await post('/api/workspace/group/remove', { dir: 'more' }, page);
  assert.equal(rm.status, 200, JSON.stringify(rm.json));
  assert.ok(!map().groups.some((g) => g.dir === 'more'));
});

test('a sync that pushes, and a new brain on GitHub: refused from a script\'s token; the dry run and the pull-only sync stay open', async () => {
  const job = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${origin}/api/workspace/job?from=0`, { headers: { Cookie: cookie } });
      const j = await r.json();
      if (!j.running) return j;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error('the job did not finish');
  };
  for (const b of [{ push: true }, { memory: true }, { push: true, memory: true }]) {
    for (const h of [bearer(script.token), bearer(hub.token), bearer(script.token, { [OWNER_PAGE_HEADER]: '1' })]) {
      const r = await post('/api/workspace/sync', b, h);
      assert.equal(r.status, 403, `${JSON.stringify(b)} ${JSON.stringify(h)} ${JSON.stringify(r.json)}`);
    }
  }
  const brain = await post('/api/workspace/git/brain', {}, bearer(script.token));
  assert.equal(brain.status, 403, JSON.stringify(brain.json));
  const dry = await post('/api/workspace/sync', { push: true, dryRun: true }, bearer(script.token));
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  await job();
  const pull = await post('/api/workspace/sync', {}, bearer(script.token));
  assert.equal(pull.status, 200, JSON.stringify(pull.json));
  await job();
});

test('Tia\'s card the owner confirmed may push (here, or through a joined hub); her door never drops', async () => {
  const { ownerPageOnly } = await import('../../src/workspace/whomay.mjs');
  const self = { caller: () => 'self' };
  assert.equal(await ownerPageOnly({ headers: {} }, self, 'a sync that pushes', { card: true }), 'card');
  await assert.rejects(ownerPageOnly({ headers: {} }, self, 'a drop'), /owner's own step/);
  const relayed = { headers: { [SELF_HEADER]: '1' } };
  const computer = { caller: () => 'computer' };
  assert.equal(await ownerPageOnly(relayed, computer, 'a sync that pushes', { card: true, tokenId: () => hub.id }), 'hub');
  await assert.rejects(ownerPageOnly(relayed, computer, 'a sync that pushes', { card: true, tokenId: () => script.id }), /comes only from your own page/);
  await assert.rejects(ownerPageOnly(relayed, computer, 'a drop', { tokenId: () => hub.id }), /owner's own step/);
});

test('a hub that added this computer by SSH or by code (its token marked hub): its own page may drop through it', async () => {
  const { pairInfo } = await import('../../src/machines/pairing.mjs');
  const bySsh = await pairInfo('box2', { createToken, hub: true });
  const plain = await pairInfo('a script', { createToken });
  const ticket = async (h) => (await post('/api/workspace/drop/check', { name: 'shop' }, h)).json.ticket;
  await reset(D); // an earlier test dropped it
  assert.equal(await ticket(bearer(plain.token, { [OWNER_PAGE_HEADER]: '1' })), undefined, 'hoprig pair --json without --hub: a script\'s token');
  const t = await ticket(bearer(bySsh.token, { [OWNER_PAGE_HEADER]: '1' }));
  const refused = await post('/api/workspace/drop', { ticket: t }, bearer(bySsh.token));
  assert.equal(refused.status, 403, 'without the page\'s mark: no');
  const ok = await post('/api/workspace/drop', { ticket: t }, bearer(bySsh.token, { [OWNER_PAGE_HEADER]: '1' }));
  assert.equal(ok.json.result, 'dropped', JSON.stringify(ok.json));
});

test('a hub that added this computer before tokens had the mark: the refusal names the step, the owner marks it, Sync with push works again', async () => {
  const job = async () => {
    for (let i = 0; i < 400; i++) {
      const j = await (await fetch(`${origin}/api/workspace/job?from=0`, { headers: { Cookie: cookie } })).json();
      if (!j.running) return j;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error('the job did not finish');
  };
  await reset(D); // an earlier test dropped it
  const old = createToken('box-hub'); // what `hoprig pair --json --name box-hub` made before --hub existed
  const hubPage = bearer(old.token, { [OWNER_PAGE_HEADER]: '1' });
  const tiaCard = bearer(old.token, { [SELF_HEADER]: '1' });
  {
    const r = await post('/api/workspace/sync', { push: true }, hubPage);
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.match(r.json.error, /mark it as your main computer on this computer's own page: Computers, Add a computer, Advanced, Who may control this computer/);
  }
  // A push is his own press: Tia's card, relayed from a hub, never pushes, marked or not.
  const tiaPush = async () => {
    const r = await post('/api/workspace/sync', { push: true }, tiaCard);
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.match(r.json.error, /a sync that pushes is the owner's own step/);
  };
  await tiaPush();
  // Only the owner's own page marks a token: not the token itself, not another one, not another site, not Tia's door.
  for (const h of [bearer(old.token), bearer(hub.token, { [OWNER_PAGE_HEADER]: '1' }), { Cookie: cookie, Origin: 'http://evil.example' }]) {
    const r = await post(`/api/tokens/${old.id}/hub`, { hub: true }, h);
    assert.ok(r.status === 401 || r.status === 403, `${JSON.stringify(h)}: ${r.status}`);
  }
  assert.throws(() => checkRoute('POST', `/api/tokens/${old.id}/hub`, {}));
  assert.equal((await post(`/api/tokens/${old.id}/hub`, { hub: 'yes' }, page)).status, 400);
  assert.equal((await post('/api/tokens/000000000000/hub', { hub: true }, page)).status, 404);
  const listed = async () => (await (await fetch(`${origin}/api/tokens`, { headers: { Cookie: cookie } })).json()).tokens.find((t) => t.id === old.id);
  assert.equal((await listed()).hub, false);
  const marked = await post(`/api/tokens/${old.id}/hub`, { hub: true }, page);
  assert.equal(marked.status, 200, JSON.stringify(marked.json));
  assert.equal((await listed()).hub, true, 'the list shows the mark');
  assert.ok(!JSON.stringify(marked.json).includes('hash'), 'never the hash');
  {
    const r = await post('/api/workspace/sync', { push: true }, hubPage);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await job();
  }
  await tiaPush();
  // A hub on Hoprig 0.3.3 relays its page's Sync with push with neither mark: marking its token does not help, and
  // the refusal says the one step that does (update Hoprig on the hub), not "open the Workspace page".
  const asOld = await post('/api/workspace/sync', { push: true }, bearer(old.token));
  assert.equal(asOld.status, 403, JSON.stringify(asOld.json));
  assert.match(asOld.json.error, /the main computer's Hoprig is older than this computer's\. Update Hoprig on the main computer, then press again/);
  assert.doesNotMatch(asOld.json.error, /open the Workspace page|mark it as your main computer/);
  // Taken away again: refused again.
  assert.equal((await post(`/api/tokens/${old.id}/hub`, { hub: false }, page)).status, 200);
  assert.equal((await post('/api/workspace/sync', { push: true }, hubPage)).status, 403);
});
