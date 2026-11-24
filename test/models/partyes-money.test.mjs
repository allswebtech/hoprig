// A part of Tia's Lead session started by the owner's yes on its card (src/models/partdoor.mjs takeYes): counted in
// today's sum like every other act from his tap (spend.tapped, no budget, never checked against the limit), with its
// chat bound so its measured cost stands in the sum; a later part that starts by itself gets its share of what is left
// after it. The chat is a stand-in: no provider is asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('partyesmoney');
test.after(() => box.cleanup());
const { writeProfile } = await import('../../src/profiles.mjs');
const { partDoor } = await import('../../src/models/partdoor.mjs');
const { SpendLedger, spendFile } = await import('../../src/assistant/spend.mjs');

// Billed by use: a key straight to the vendor (profiles.mjs isPayPerUse). Never asked: the chat is a stand-in.
writeProfile('paid', { label: 'Made-up paid key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-madeupmadeup1' } });

const entries = () => (fs.existsSync(spendFile()) ? fs.readFileSync(spendFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function door(t, conf) {
  fs.rmSync(spendFile(), { force: true });
  const opened = [];
  const lead = { id: 'lead-1', cwd: box.root, lead: true, others: ['paid'], byTia: true };
  const chat = {
    recordOf: (id) => (id === lead.id ? lead : null),
    peek: () => null,
    notice() {},
    event() {},
    async open(b, run) {
      opened.push({ b, run });
      return { id: `c${opened.length}`, sent: true };
    },
  };
  const d = partDoor({ chat, config: () => conf.now, url: () => 'http://127.0.0.1:1', models: async () => null, readJson: async () => ({ allow: true }) });
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
  const yes = (part) => {
    const [, re, go] = d.routes.find(([m, r]) => m === 'POST' && r.test(`/api/parts/${part}/answer`));
    return go({}, re.exec(`/api/parts/${part}/answer`));
  };
  return { call, yes, opened };
}

test('a part started by his yes is counted in today\'s sum, and a later part that starts by itself gets its share of what is left after it', async (t) => {
  // "Work": a part on a provider billed by use is his card; then he sets Hands off with a $3 limit, two at once.
  const conf = { now: { assistant: { enabled: true, level: 'work', accounts: ['paid'], dailyCapUsd: 3 }, automation: { schedules: { atOnce: 2 } } } };
  const { call, yes, opened } = await door(t, conf);
  const asked = await call({ action: 'start', provider: 'paid', brief: 'write the tests' });
  const part = /Part (p_[0-9a-f]{10}) starts there only when he says yes/.exec(asked.text)[1];
  assert.deepEqual((await yes(part)).kept, true, 'kept until the lead\'s result takes it');
  await call({ action: 'result', part });
  assert.equal(opened.length, 1, 'his yes started it');
  assert.deepEqual(opened[0].run, {}, 'no budget: his yes is his decision');
  const l = new SpendLedger();
  const tap = entries().find((e) => e.kind === 'hold' && e.owner);
  assert.ok(tap, 'a tapped entry');
  assert.deepEqual(entries().find((e) => e.kind === 'bind' && e.hold === tap.id), { at: entries().find((e) => e.kind === 'bind').at, kind: 'bind', hold: tap.id, session: 'this|chat:c1', base: 0, fresh: true }, 'its chat is bound');
  const afterYes = l.detail();
  t.diagnostic(`FIG yes today=${JSON.stringify(afterYes)}`);
  assert.deepEqual(afterYes, { spent: 0, held: 0.5, unmeasured: 1, tapped: 1 }, 'today\'s sum holds it');
  conf.now = { ...conf.now, assistant: { ...conf.now.assistant, level: 'handsoff' } };
  const later = await call({ action: 'start', provider: 'paid', brief: 'write the docs' });
  assert.match(later.text, /^Started part/, later.text);
  const share = entries().filter((e) => e.kind === 'hold' && Number.isFinite(e.usd)).map((e) => e.usd);
  t.diagnostic(`FIG later share=${JSON.stringify(share)} run=${JSON.stringify(opened[1].run)}`);
  assert.deepEqual(share, [1.25], 'half of the $2.50 left after his part\'s $0.50');
  // His part's first turn ended and reported $0.20: that cost stands in its place.
  l.measure('this|chat:c1', 0.2, false);
  const measured = l.detail();
  t.diagnostic(`FIG measured today=${JSON.stringify(measured)}`);
  assert.equal(measured.spent, 0.2);
  assert.equal(measured.held, 1.25, 'only the later part\'s budget is held now');
});

test('a part started by his yes whose turn ended without a reported cost (its coding tool crashed) stays counted at $0.50 until the day ends', async (t) => {
  const conf = { now: { assistant: { enabled: true, level: 'work', accounts: ['paid'], dailyCapUsd: 3 }, automation: { schedules: { atOnce: 2 } } } };
  const { call, yes, opened } = await door(t, conf);
  const asked = await call({ action: 'start', provider: 'paid', brief: 'write the tests' });
  const part = /Part (p_[0-9a-f]{10}) starts there only when he says yes/.exec(asked.text)[1];
  await yes(part);
  await call({ action: 'result', part });
  assert.equal(opened.length, 1, 'his yes started it');
  const l = new SpendLedger();
  // Its turn was seen running, then its chat went idle at the same figure: the coding tool crashed, nothing reported.
  l.measure('this|chat:c1', 0, true);
  l.measure('this|chat:c1', 0, false);
  const crashed = l.detail();
  t.diagnostic(`FIG crashed today=${JSON.stringify(crashed)}`);
  assert.deepEqual(crashed, { spent: 0, held: 0.5, unmeasured: 1, tapped: 1 }, 'counted like every act from his tap whose cost was not measured');
  // A later turn that did report: its figure rose, and that cost stands in the $0.50's place.
  l.measure('this|chat:c1', 0.05, true);
  l.measure('this|chat:c1', 0.12, false);
  const reported = l.detail();
  t.diagnostic(`FIG reported today=${JSON.stringify(reported)}`);
  assert.deepEqual(reported, { spent: 0.12, held: 0, unmeasured: 0, tapped: 1 });
});
