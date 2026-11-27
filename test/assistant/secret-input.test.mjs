// A key in the owner's own message goes no further than the chat route: the engine, the stored conversation and the
// title only see a mark, and she says one line about it. A spoken message says so in the turn's facts. Every key and
// token here is made up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { KEY_MARK, KEY_NOTE, maskInput } from '../../src/assistant/secrets.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { byName } from '../../src/assistant/tools.mjs';
import { sandbox } from '../server/helpers.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_TIA = path.join(HERE, 'fixtures', 'fake-tia.mjs');
const FAKE_SESSION = path.join(HERE, 'fixtures', 'fake-session.mjs');
const KEY = 'sk-ant-api03-' + 'MADEUPKEYabcdefgh1234';
const GH = 'ghp_' + 'madeupmadeupmadeupmadeup0123';

test('maskInput: shapes become the mark, a plain number after a secret-sounding name stays', () => {
  const r = maskInput(`use ${KEY} and ${GH} please, MAX_TOKENS=200000`);
  assert.equal(r.found, true);
  assert.equal(r.text, `use ${KEY_MARK} and ${KEY_MARK} please, MAX_TOKENS=200000`);
  const n = maskInput('API_TOKEN=abc123def456ghi789jk');
  assert.equal(n.found, true);
  assert.ok(!n.text.includes('abc123def456ghi789jk'));
  assert.deepEqual(maskInput('nothing secret here'), { text: 'nothing secret here', found: false });
});

test('the chat route: the engine, the stored events, the title and the files hold the mark, never the key', { timeout: 120_000, skip: process.platform === 'win32' && 'the fake launcher is POSIX' }, async (t) => {
  const box = sandbox('secret-input');
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [path.join(box.root, 'work')], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'work' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: true, assistant: { engine: { command: { command: process.execPath, args: [FAKE_TIA] }, resolveEnv: async () => ({ ...process.env }) } } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  const login = await req('POST', '/api/login', { password: 'pw-for-tests' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const sent = await req('POST', '/api/assistant/chat', { text: `say the key is ${KEY} and the other ${GH} ok` }, { Cookie: cookie });
  assert.equal(sent.status, 200);
  const conv = sent.json.conversation;
  let events = [];
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    events = (await req('GET', `/api/assistant/chat/${conv}?from=0`, undefined, { Cookie: cookie })).json.events;
    if (events.some((e) => e.kind === 'done')) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const all = JSON.stringify(events);
  assert.ok(events.some((e) => e.kind === 'done'), all);
  assert.ok(!all.includes('MADEUPKEY') && !all.includes('madeupmadeup'), 'the events hold no key');
  assert.equal(events.find((e) => e.kind === 'owner').text, `say the key is ${KEY_MARK} and the other ${KEY_MARK} ok`);
  assert.ok(events.some((e) => e.kind === 'notice' && e.text === KEY_NOTE), 'she says one line about it');
  // the stand-in engine got only the mark: it answers with the words it was given
  assert.ok(events.some((e) => e.kind === 'text' && e.text.includes(KEY_MARK)), all);
  const list = (await req('GET', '/api/assistant', undefined, { Cookie: cookie })).json;
  assert.ok(!JSON.stringify(list).includes('MADEUPKEY'), 'the title and the list hold no key');
  // every file of the dashboard's state folder
  const hits = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.isFile() && /MADEUPKEY|madeupmadeup/.test(fs.readFileSync(p, 'latin1'))) hits.push(p);
    }
  };
  walk(stateDir());
  assert.deepEqual(hits, []);
  // a message with no key says no line
  const plain = await req('POST', '/api/assistant/chat', { text: 'say hello', conversation: conv }, { Cookie: cookie });
  assert.equal(plain.status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  const after = (await req('GET', `/api/assistant/chat/${conv}?from=0`, undefined, { Cookie: cookie })).json.events;
  assert.equal(after.filter((e) => e.kind === 'notice' && e.text === KEY_NOTE).length, 1);
});

test('spoken: true arrives in the turn facts, and only for that turn', async () => {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'work' };
  const core = createAssistantCore({
    ops: new FakeOps(s), now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [{ dir: path.join(HERE, '..', '..', 'skills'), source: 'built-in' }] }),
  });
  const tool = byName.get('start_chat');
  const real = tool.facts;
  const seen = [];
  tool.facts = async (ops, a, ctx) => (seen.push(ctx.spoken), null);
  try {
    const call = () => core.call('start_chat', { folder: '/home/owner/projects/api', message: 'x' }, { conversation: 'c1' });
    core.beginTurn('c1', { origin: 'owner', text: 'start it', spoken: true });
    await call();
    core.endTurn('c1');
    core.beginTurn('c1', { origin: 'owner', text: 'start it' });
    await call();
    core.endTurn('c1');
    assert.deepEqual(seen, [true, false]);
  } finally {
    tool.facts = real;
  }
});
