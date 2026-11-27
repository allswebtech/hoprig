// Health's "Open a terminal with this line" (POST /api/health/line, src/machines/healthline.mjs): the page sends only a
// check's id; this computer finds its own doctor's check of that id, opens a NEW terminal session in the home folder,
// types the check's line and never presses Enter. Only the owner's own page may ask (here, or a hub's page relayed with
// its mark): never Tia, never a request that holds another key. A line with a control character is never typed.
// The lines here are a made-up program's (test/fixtures/healthline-checks.json): a stand-in deck records what was
// typed and whether Enter went; no shell receives anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('healthline');
test.after(() => box.cleanup());
const { healthChecks, healthFeature, pickHealth } = await import('../../src/machines/health.mjs');
const { defaultHubLabel } = await import('../../src/machines/hub.mjs');
const { OWNER_PAGE_HEADER, SELF_HEADER } = await import('../../src/machines/relay.mjs');

const CHECKS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'healthline-checks.json'), 'utf8'));
const NAME = defaultHubLabel();

// A hub's token (marked as the owner's hub) and a paired script's (not a hub's), in the sandbox's own token list.
const { createToken } = await import('../../src/machines/tokens.mjs');
const HUB = createToken('made-up-hub', { hub: true });
const SCRIPT = createToken('made-up-script');

function stage({ caller = 'page', taken = [], tokenId = null } = {}) {
  const made = [];
  const typed = [];
  const marked = [];
  const deck = {
    terminal: async (o) => (made.push(o), { name: o.name, id: `t${made.length}` }),
    send: async (id, text, o = {}) => typed.push({ id, text, enter: o.enter !== false }),
    markLineReady: (id) => marked.push(id),
  };
  const ctx = { deck, backend: { list: async () => taken.map((session) => ({ session })) }, caller: () => caller, readJson: async (req) => req.body };
  const f = healthFeature(ctx, { parts: { checks: async () => CHECKS }, tokenId: () => tokenId });
  const route = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/health/line'));
  assert.ok(route, 'the route is there');
  const call = (body, headers = {}) => route[2]({ body, headers });
  return { made, typed, marked, call };
}

test('a check\'s line is typed into a new terminal session in the home folder, and Enter is never pressed', async () => {
  const s = stage({ taken: ['health-line'] });
  const r = await s.call({ id: 'made-up.admin', confirm: NAME });
  assert.equal(s.made.length, 1, 'one new session');
  assert.equal(s.made[0].dir, os.homedir());
  assert.ok(!s.made[0].argv, 'a plain shell: no command started in it');
  assert.equal(r.session, s.made[0].name);
  assert.notEqual(r.session, 'health-line', 'a new session, never one that is there');
  assert.deepEqual(s.typed, [{ id: 't1', text: 'sudo made-up-admin-tool --fix', enter: false }]);
  assert.deepEqual(s.marked, ['t1'], 'the session is marked before anything else may type into it');
});

test('a line with a newline, a carriage return or another control character is refused, never typed', async () => {
  const s = stage();
  for (const id of ['made-up.newline', 'made-up.return', 'made-up.escape']) {
    await assert.rejects(s.call({ id, confirm: NAME }), (e) => e.status === 400 && e.details.code === 'control', id);
  }
  assert.deepEqual([s.made, s.typed], [[], []]);
});

test('only a check whose line needs administrator rights: not a plain line, one with a Fix, a part of Setup, a sign-in, or one that is fine', async () => {
  const s = stage();
  for (const id of ['made-up.plain', 'made-up.kit', 'identity', 'login', 'made-up.fine', 'no-such-check']) {
    await assert.rejects(s.call({ id, confirm: NAME }), (e) => e.status === 400 && e.details.code === 'no-line', id);
  }
  assert.deepEqual([s.made, s.typed], [[], []]);
});

test('the body holds the check\'s id and the computer\'s name, nothing else: a line from the request is never taken', async () => {
  const s = stage();
  await assert.rejects(s.call({ id: 'made-up.admin', confirm: NAME, line: 'made-up-admin-tool --other' }), (e) => e.status === 400 && e.details.code === 'key');
  await assert.rejects(s.call({ id: 'made-up.admin', confirm: NAME, enter: true }), (e) => e.status === 400 && e.details.code === 'key');
  await assert.rejects(s.call({ id: 'made-up.admin' }), (e) => e.status === 400 && e.details.code === 'confirm');
  await assert.rejects(s.call({ id: 'made-up.admin', confirm: 'another-box' }), (e) => e.status === 400 && e.details.code === 'confirm');
  await assert.rejects(s.call({ id: ['made-up.admin'], confirm: NAME }), (e) => e.status === 400);
  await assert.rejects(s.call(['made-up.admin']), (e) => e.status === 400);
  assert.deepEqual([s.made, s.typed], [[], []]);
});

test('Tia is refused, also with a card; a token without the hub page\'s mark, or with Tia\'s, is refused', async () => {
  const body = { id: 'made-up.admin', confirm: NAME };
  const self = stage({ caller: 'self' });
  await assert.rejects(self.call(body), (e) => e.status === 403);
  const tia = stage();
  await assert.rejects(tia.call(body, { authorization: 'Bearer tia_made-up' }), (e) => e.status === 403);
  const hub = stage({ caller: 'computer', tokenId: HUB.id });
  await assert.rejects(hub.call(body), (e) => e.status === 403, 'a plain token');
  await assert.rejects(hub.call(body, { [SELF_HEADER]: '1' }), (e) => e.status === 403, 'Tia through a hub');
  await assert.rejects(hub.call(body, { [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' }), (e) => e.status === 403, 'both marks');
  for (const s of [self, tia, hub]) assert.deepEqual([s.made, s.typed], [[], []]);
  // A hub's own signed-in page, relayed: this computer recomputes its own check and types its own line.
  await hub.call(body, { [OWNER_PAGE_HEADER]: '1' });
  assert.deepEqual(hub.typed, [{ id: 't1', text: 'sudo made-up-admin-tool --fix', enter: false }]);
});

test('the page\'s mark counts only from a hub of the owner\'s: a paired script that sets it itself is refused', async () => {
  const body = { id: 'made-up.admin', confirm: NAME };
  for (const tokenId of [SCRIPT.id, null, 'made-up-unknown-id']) {
    const s = stage({ caller: 'computer', tokenId });
    await assert.rejects(s.call(body, { [OWNER_PAGE_HEADER]: '1' }), (e) => e.status === 403 && e.details.code === 'owner-page', String(tokenId));
    assert.deepEqual([s.made, s.typed, s.marked], [[], [], []], String(tokenId));
  }
});

test('a check that a part of the page does links there, the sign-in is a press, and only an administrator line gets the terminal', () => {
  const rows = healthChecks([
    { id: 'root', status: 'warn', fix: 'hoprig move-to-user' },
    { id: 'profiles', status: 'warn', fix: 'hoprig setup' },
    { id: 'skill:made-up', status: 'warn', fix: 'hoprig skills add made-up --user' },
    { id: 'skill-update:made-up', status: 'warn', fix: 'hoprig skills update made-up' },
    ...CHECKS,
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.root.where, 'Settings → Runs as root');
  assert.equal(by.profiles.where, 'Providers');
  assert.equal(by['skill:made-up'].where, 'Skills');
  assert.equal(by['skill-update:made-up'].where, 'Skills');
  assert.equal(by.login.action, 'claude-login', 'the page signs in: no line to type');
  assert.equal(healthChecks([{ id: 'x', status: 'warn', fix: 'x', action: 'made-up-press' }])[0].action, null, 'only a press the page has');
  assert.equal(by['made-up.admin'].admin, true);
  assert.equal(by['made-up.plain'].admin, false);
  // Another computer's answer: its press is offered only when it says it has the route (an older Hoprig does not).
  assert.equal(pickHealth({ checks: [], line: true }).line, true);
  assert.equal(pickHealth({ checks: [] }).line, false);
  assert.equal(pickHealth({ checks: [], line: 'yes' }).line, false);
});

test('the page sends only the id and the name, says why, and never presses Enter', () => {
  const web = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'health.js'), 'utf8');
  assert.match(web, /api\('\/api\/health\/line', \{ id: c\.id, confirm: computerName \}\)/);
  assert.match(web, /export const ADMIN_WHY = 'It needs administrator rights, so the computer asks for your password, which only you type\.';/);
  assert.match(web, /export const ENTER_HINT = 'Press Enter in the terminal to run it\.';/);
  assert.match(web, /label: 'Open a terminal with this line'/);
  assert.match(web, /Open a terminal on \$\{ctx\.label\(\)\} and type this line:/, 'no press where that computer cannot open one');
  assert.doesNotMatch(web, /health\/line[^\n]*(enter|owner)/i);
});

test('the README and the changelog say what Setup does with a line that needs administrator rights', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const flat = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\s+/g, ' ');
  const readme = flat('README.md');
  assert.match(readme, /On \*\*Setup\*\*, each problem has its press under it: \*\*Fix\*\* where Hoprig can do it, a link to the page that does it, or \*\*Sign in\*\* for Claude Code\./);
  assert.match(readme, /\*\*Open a terminal with this line\*\* opens a new terminal session with the line typed: you press Enter yourself/);
  const log = flat('site/content/changelog.md');
  const at = log.indexOf('### Easier when you are not a programmer');
  const block = log.slice(at, log.indexOf('### ', at + 5));
  assert.match(block, /- \*\*Health: a press under each problem\.\*\*/);
  assert.match(block, /with the line typed and not sent: you press Enter yourself\. Only your own page types into that session/);
});
