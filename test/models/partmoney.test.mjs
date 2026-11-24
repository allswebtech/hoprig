// A part of Tia's Lead session at "Hands off" on a provider billed by use (src/models/partdoor.mjs, others.mjs
// partGate): it starts by itself only inside her daily limit for paid use, with a hold in her one ledger
// (src/assistant/spend.mjs) taken before it opens and bound to the part's chat, so the chat's reported cost settles it.
// No limit set, or no room left: one card, and nothing starts. The chat is a stand-in: no provider is asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('partmoney');
test.after(() => box.cleanup());
const { writeProfile } = await import('../../src/profiles.mjs');
const { partDoor } = await import('../../src/models/partdoor.mjs');
const { SpendLedger, spendFile } = await import('../../src/assistant/spend.mjs');

// Billed by use: a key straight to the vendor (profiles.mjs isPayPerUse). Never asked: the chat is a stand-in.
writeProfile('paid', { label: 'Paid key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } });

const entries = () => {
  try {
    return fs.readFileSync(spendFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

/** A door for one Lead chat of Tia's with "paid" ticked, at Hands off with daily limit `cap`; `sent`: the open takes it. */
async function door(t, { cap = null, sent = true, atOnce = 2 } = {}) {
  fs.rmSync(spendFile(), { force: true });
  const opened = [];
  const events = [];
  const lead = { id: 'lead-1', cwd: box.root, lead: true, others: ['paid'], byTia: true };
  const chat = {
    recordOf: (id) => (id === lead.id ? lead : null),
    peek: () => null,
    notice() {},
    event: (_id, ev) => events.push(ev),
    async open(b) {
      if (!sent) return { id: null, sent: false, why: 'it did not start' };
      opened.push(b);
      return { id: `c${opened.length}`, sent: true };
    },
  };
  const config = () => ({ assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: cap }, automation: { schedules: { atOnce } } });
  const d = partDoor({ chat, config, url: () => 'http://127.0.0.1:1', models: async () => null });
  d.configFor(lead);
  const token = fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'part-servers', 'lead-1.token'), 'utf8').trim();
  const srv = http.createServer(async (req, res) => {
    if (!(await d.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const call = (body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/api/parts', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve(JSON.parse(s)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  return { call, opened, events };
}

test('Hands off with no daily limit set: a card, nothing starts, nothing is held', async (t) => {
  const { call, opened, events } = await door(t);
  const r = await call({ action: 'start', provider: 'paid', brief: 'write the tests' });
  assert.match(r.text, /^Waiting for the owner's OK: Paid key is billed by use/);
  assert.equal(opened.length, 0, 'nothing started');
  assert.deepEqual(events.map((e) => e.kind), ['part-ask'], 'one card');
  assert.deepEqual(entries(), [], 'nothing in the ledger');
});

test('Hands off inside the limit: the part starts by itself, held first and bound to its chat', async (t) => {
  const { call, opened, events } = await door(t, { cap: 5 });
  const r = await call({ action: 'start', provider: 'paid', brief: 'write the tests' });
  assert.match(r.text, /^Started part p_[0-9a-f]{10} on paid/);
  assert.equal(opened.length, 1);
  assert.equal(events.length, 0, 'no card');
  const e = entries();
  assert.deepEqual(e.map((x) => x.kind), ['hold', 'bind']);
  assert.equal(e[1].hold, e[0].id);
  assert.equal(e[1].session, 'this|chat:c1', 'its chat\'s own cost settles it');
  assert.equal(e[0].usd, 2.5, 'its budget: its share of the $5, two parts may run at once');
  assert.deepEqual(new SpendLedger().today(), { spent: 0, held: 2.5 }, 'the ledger holds its budget');
});

test('Hands off with a share under a cent left today: the sentence, a card, nothing starts, nothing more held', async (t) => {
  const { call, opened, events } = await door(t, { cap: 1 });
  new SpendLedger().spent(0.995, 'her own turn');
  const r = await call({ action: 'start', provider: 'paid', brief: 'write the tests' });
  assert.match(r.text, /^Waiting for the owner's OK: Paid key is billed by use, and today's daily limit for paid use of \$1\.00 has too little left for another part \(\$1\.00 spent\); raise the limit in Settings → Tia, or wait for tomorrow\. Part p_/, r.text);
  assert.equal(opened.length, 0);
  assert.deepEqual(events.map((x) => x.kind), ['part-ask']);
  assert.deepEqual(new SpendLedger().today(), { spent: 0.995, held: 0 });
});

test('three parts at once under a limit of $3 with three allowed hold $1 each; a fourth is told why and is the owner\'s card', async (t) => {
  const { call, opened, events } = await door(t, { cap: 3, atOnce: 3 });
  const r = await Promise.all([1, 2, 3].map((n) => call({ action: 'start', provider: 'paid', brief: `part ${n}` })));
  for (const x of r) assert.match(x.text, /^Started part/, x.text);
  assert.deepEqual(entries().filter((e) => e.kind === 'hold').map((e) => e.usd), [1, 1, 1], 'never more than the $3 together');
  assert.deepEqual(opened.map((b) => b.text), ['part 1', 'part 2', 'part 3']);
  const fourth = await call({ action: 'start', provider: 'paid', brief: 'part 4' });
  assert.match(fourth.text, /^Waiting for the owner's OK: Paid key is billed by use, and today's daily limit for paid use of \$3\.00 has too little left for another part \(\$0\.00 spent and \$3\.00 held by 3 parts that run now\); raise the limit in Settings → Tia, or wait until a part ends\. Part p_/, fourth.text);
  assert.deepEqual(events.map((e) => e.kind), ['part-ask'], 'the owner\'s card');
  assert.equal(opened.length, 3, 'the fourth did not start');
  assert.deepEqual(new SpendLedger().today(), { spent: 0, held: 3 });
});

test('a part that does not start gives its hold back', async (t) => {
  const { call, opened } = await door(t, { cap: 5, sent: false });
  const r = await call({ action: 'start', provider: 'paid', brief: 'write the tests' });
  assert.match(r.text, /Not started: it did not start/);
  assert.equal(opened.length, 0);
  assert.deepEqual(new SpendLedger().today(), { spent: 0, held: 0 }, 'given back');
});
