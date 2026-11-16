// The Activity line for a change a linked hub made with its machine token (src/machines/tokenaudit.mjs), and the
// revoke listeners of src/machines/tokens.mjs: they run after the revoke, never awaited, and one that fails or never
// ends cannot stop a revoke.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('tokenaudit');
test.after(() => box.cleanup());

const { CHANGES, auditToken, changeOf, revokedWords } = await import('../../src/machines/tokenaudit.mjs');
const { createToken, onRevoke, revokeToken } = await import('../../src/machines/tokens.mjs');

test('each change a token may make has its plain words; anything else is not logged', () => {
  const said = (m, p) => changeOf(m, p, 'office-pc')?.did ?? null;
  assert.equal(said('POST', '/api/addons/public-link/start'), 'The hub office-pc started the public link');
  assert.equal(said('POST', '/api/addons/public-link/stop'), 'The hub office-pc stopped the public link');
  assert.equal(said('POST', '/api/addons/trouteai/install'), 'The hub office-pc installed TRouteAI');
  assert.equal(said('POST', '/api/addons/public-link/do/fixed-on'), 'The hub office-pc turned on the Custom public link');
  assert.equal(said('POST', '/api/addons/public-link/do/fixed-add-service'), 'The hub office-pc added a service to the Custom public link');
  // The page's own routes since the public link has one (the body, on or off, is never read here).
  assert.equal(said('POST', '/api/public-link'), 'The hub office-pc switched the public link on or off');
  assert.equal(said('POST', '/api/public-link/custom/create'), 'The hub office-pc set up the Custom public link');
  assert.equal(said('POST', '/api/public-link/custom/forget'), 'The hub office-pc stopped using the Custom public link');
  assert.equal(said('POST', '/api/public-link/temporary/add-service'), 'The hub office-pc gave a service on this computer a temporary address');
  assert.equal(said('POST', '/api/addons/public-link/do/quick-service-start'), 'The hub office-pc gave a service on this computer a temporary address');
  assert.equal(said('POST', '/api/addons/other/do/some-thing'), 'The hub office-pc ran "some-thing" of the add-on other');
  assert.equal(said('POST', '/api/gateways/trouteai/share'), 'The hub office-pc changed the sharing of the gateway trouteai');
  assert.equal(said('POST', '/api/gateways/trouteai/keys'), 'The hub office-pc made a key for the gateway trouteai');
  assert.equal(said('POST', '/api/gateways/keys/0123456789ab/remove'), 'The hub office-pc removed the gateway key 0123456789ab');
  assert.equal(said('POST', '/api/pcsetup/setup'), 'The hub office-pc ran Set up this computer');
  assert.equal(said('POST', '/api/pcsetup/fix'), 'The hub office-pc ran a fix from PC → Setup');
  assert.equal(said('POST', '/api/pcsetup/recipe'), 'The hub office-pc ran a setup recipe');
  assert.equal(said('POST', '/api/workspace/link'), "The hub office-pc linked Claude Code's own folder into the AI brain");
  assert.equal(said('POST', '/api/workspace/git/identity'), "The hub office-pc changed git's name and e-mail");
  assert.equal(said('POST', '/api/workspace/git/signin'), 'The hub office-pc started the GitHub sign-in');
  assert.equal(said('POST', '/api/workspace/git/brain'), "The hub office-pc created the AI brain's repository");
  assert.equal(said('POST', '/api/workspace/map/commit'), "The hub office-pc saved the workspace map in the AI brain's history");
  assert.equal(said('POST', '/api/code/file'), 'The hub office-pc saved a file in the code editor');
  assert.equal(said('POST', '/api/code/delete'), 'The hub office-pc deleted a file or folder in the code editor');
  assert.equal(said('POST', '/api/code/git/discard'), 'The hub office-pc discarded changes in the code editor');
  assert.equal(said('POST', '/api/code/git/commit'), 'The hub office-pc made a git commit in the code editor');
  for (const p of ['/api/code/create', '/api/code/rename']) assert.match(said('POST', p), /in the code editor$/);
  // Reads, other routes and odd paths: nothing.
  for (const [m, p] of [['GET', '/api/addons'], ['GET', '/api/addons/public-link/job'], ['GET', '/api/public-link'], ['GET', '/api/public-link/job'], ['POST', '/api/public-link/temporary/x'], ['GET', '/api/pcsetup/recipe'], ['POST', '/api/workspace/git/signin/cancel'],
    ['POST', '/api/state'], ['POST', '/api/addons/Public%20Link/start'], ['POST', '/api/addons/public-link/start/x'],
    ['GET', '/api/code/file'], ['POST', '/api/code/git/stage'], ['POST', '/api/code/file/x']]) assert.equal(said(m, p), null, `${m} ${p}`);
  assert.equal(CHANGES.every(([m]) => m === 'POST'), true);
});

// A stand-in route for /api/workspace/link (it comes from another lane): the gate's call, then the route's answer.
async function standIn(fn) {
  const server = http.createServer((req, res) => fn(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('recorded when the answer is finished and below 400; never the body; a Setup answer that asks first is not a change', async () => {
  const lines = [];
  const SECRET = 'body-secret-4417';
  const s = await standIn((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    auditToken(req, res, p, { id: '0123456789ab', name: 'office-pc' }, (did) => lines.push(did));
    req.resume();
    req.on('end', () => {
      const status = Number(req.headers['x-status'] || 200);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(req.headers['x-answer'] || JSON.stringify({ ok: status < 400 }));
    });
  });
  try {
    const post = (p, headers = {}) => fetch(s.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ password: SECRET }) }).then((r) => r.text());
    await post('/api/workspace/link');
    await post('/api/workspace/link', { 'x-status': '409' });
    await post('/api/workspace/link', { 'x-status': '500' });
    await post('/api/pcsetup/setup', { 'x-answer': JSON.stringify({ needsPassword: true }) });
    await post('/api/pcsetup/setup', { 'x-answer': JSON.stringify({ needsTerminal: true, why: 'x' }) });
    await post('/api/pcsetup/setup', { 'x-answer': JSON.stringify({ started: true }) });
    // A service action that only got the typed confirmation's question (SSH) did nothing yet.
    await post('/api/services/action', { 'x-answer': JSON.stringify({ needsConfirm: true, why: 'x' }) });
    await post('/api/state');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lines, ["The hub office-pc linked Claude Code's own folder into the AI brain", 'The hub office-pc ran Set up this computer']);
    assert.equal(lines.join('\n').includes(SECRET), false);
  } finally {
    await s.close();
  }
});

test('revoke listeners: called after the revoke with the id, name and number of keys; never awaited, never in the way', async () => {
  const seen = [];
  const off = [
    onRevoke(() => { throw new Error('a broken listener'); }),
    onRevoke(() => new Promise(() => {})), // never ends
    onRevoke(async () => { throw new Error('a broken async listener'); }),
    onRevoke((ev) => seen.push(ev)),
  ];
  try {
    const { id } = createToken('office-pc');
    const gone = revokeToken(id);
    assert.deepEqual(gone.map((t) => t.id), [id], 'answered at once');
    assert.deepEqual(seen, [], 'not called before revokeToken returned');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [{ id, name: 'office-pc', keys: 0 }]);
    assert.deepEqual(revokeToken(id), [], 'nothing left to revoke');
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 1, 'a revoke of nothing calls nobody');
  } finally {
    for (const f of off) f();
  }
});

test('a revoke is a line in the Activity log with the token\'s name; taking back a token never used is not', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const log = path.join(box.state, 'automation.log');
  const hub = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.automation === 'hub').map((e) => e.did) : []);
  const before = hub().length;
  revokeToken(createToken('laptop').id);
  assert.deepEqual(hub().slice(before), ['The token of the hub laptop was revoked']);
  revokeToken(createToken('a failed link').id, { log: false });
  assert.equal(hub().length, before + 1, 'a token taken back at once is not news');
  assert.equal(revokedWords('office-pc', 2), 'The token of the hub office-pc was revoked; the 2 gateway keys it made ended with it, and the sharing of the gateways stays as it is');
  assert.equal(revokedWords('office-pc', 1).includes('the gateway key it made'), true);
});
