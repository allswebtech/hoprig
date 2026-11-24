// A part of Tia's Lead session that starts by itself inside her daily limit for paid use (src/models/partdoor.mjs)
// gets what is left of that limit as its chat's budget, Claude Code's own --max-budget-usd, so one part cannot run
// far past the limit before its cost is counted. The budget comes only from inside the dashboard (openChat's second
// argument), never from a request body. Claude Code is a stand-in (test/chat/fixtures/fake-claude.mjs): no provider
// is asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'chat', 'fixtures', 'fake-claude.mjs');
const box = sandbox('partbudget');
test.after(() => box.cleanup());
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { partDoor } = await import('../../src/models/partdoor.mjs');
const { spendFile } = await import('../../src/assistant/spend.mjs');
const { chatFeature } = await import('../../src/chat/feature.mjs');
const { runsDir } = await import('../../src/paths.mjs');

// Billed by use: a key straight to the vendor (profiles.mjs isPayPerUse). Never asked: the chat is a stand-in.
writeProfile('paid', { label: 'Paid key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } });

async function door(t, cap) {
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
  const config = () => ({ assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: cap }, automation: { schedules: { atOnce: 2 } } });
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
  return { call, opened };
}

test('two parts started at the same moment under a limit of $2 with two allowed at once: their budgets sum to at most $2', async (t) => {
  const { call, opened } = await door(t, 2);
  const r = await Promise.all([call({ action: 'start', provider: 'paid', brief: 'write the tests' }), call({ action: 'start', provider: 'paid', brief: 'write the docs' })]);
  for (const x of r) assert.match(x.text, /^Started part/, x.text);
  assert.deepEqual(opened.map((x) => x.run), [{ maxBudgetUsd: 1 }, { maxBudgetUsd: 1 }], 'each its share: $1 and $1');
});

test('the budget reaches Claude Code as --max-budget-usd; a request body cannot set one', async (t) => {
  const proj = path.join(box.root, 'proj', 'shop');
  fs.mkdirSync(proj, { recursive: true });
  saveConfig({ server: { roots: [path.dirname(proj)] } });
  const argsFile = path.join(box.root, 'chat.args');
  // No terminal runs anything here (the send checks that no terminal runs the conversation).
  const f = chatFeature({ HttpError: Error, config: () => loadConfig(), readJson: async () => ({}), backend: { list: async () => [] } }, {
    file: path.join(box.root, 'chats.json'), command: { command: process.execPath, args: [FAKE] },
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }),
  });
  t.after(() => f.close());
  const starts = () => fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray);
  const until = async (n) => {
    for (let i = 0; i < 200 && !(fs.existsSync(argsFile) && starts().length >= n); i++) await new Promise((r) => setTimeout(r, 25));
    return starts();
  };
  const a = await f.open({ dir: proj, tool: 'claude', profile: 'paid', text: 'write the tests', defaults: true }, { maxBudgetUsd: 1.5 });
  assert.equal(a.sent, true);
  const first = (await until(1))[0];
  assert.equal(first[first.indexOf('--max-budget-usd') + 1], '1.5', JSON.stringify(first));
  // As the route passes it: the body alone, whatever it says.
  const b = await f.open({ dir: proj, tool: 'claude', profile: 'paid', text: 'and the docs', defaults: true, maxBudgetUsd: 0.01 });
  assert.equal(b.sent, true);
  const second = (await until(2))[1];
  assert.equal(second.includes('--max-budget-usd'), false, JSON.stringify(second));
});

// A chat feature on the stand-in Claude Code, with a short idle stop; `body`: what the provider route reads.
function chatFeatureFor(name, { body = {} } = {}) {
  const argsFile = path.join(box.root, `${name}.args`);
  const make = () => chatFeature({ HttpError: Error, config: () => loadConfig(), readJson: async () => body, backend: { list: async () => [] } }, {
    file: path.join(box.root, `${name}-chats.json`), command: { command: process.execPath, args: [FAKE] }, idleMs: 50,
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }),
  });
  const starts = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray) : []);
  return { make, starts };
}
const until = async (what, ok) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(ok(), what);
};
const budgetOf = (args) => (args.includes('--max-budget-usd') ? args[args.indexOf('--max-budget-usd') + 1] : null);
// The chat's process holds a run record while it runs (runs.mjs): none left means its idle timer stopped it.
const running = (id) => fs.existsSync(runsDir()) && fs.readdirSync(runsDir()).some((n) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir(), n), 'utf8')).chat === id;
  } catch {
    return false;
  }
});
const ledgerLines = () => (fs.existsSync(spendFile()) ? fs.readFileSync(spendFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** A route of feature `f` by its method and an address it answers. */
const routeOf = (f, method, url) => {
  const [, re, go] = f.routes.find(([m, r]) => m === method && r.test(url));
  return (req = {}) => go(req, re.exec(url), new URLSearchParams(), {});
};
const open = (f, dir, text, budget) => f.open({ dir, tool: 'claude', profile: 'paid', text, defaults: true }, { maxBudgetUsd: budget });

test('a part\'s process that starts again takes a new share and its old hold is settled, also after a restart of the dashboard', async (t) => {
  const { ledger } = await import('../../src/operator/money.mjs');
  fs.rmSync(spendFile(), { force: true });
  const proj = path.join(box.root, 'proj', 'cart');
  fs.mkdirSync(proj, { recursive: true });
  saveConfig({ server: { roots: [path.dirname(proj)] }, assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: 2 }, automation: { schedules: { atOnce: 1 } } });
  const { make, starts } = chatFeatureFor('restart');
  let f = make();
  t.after(() => f.close());
  const a = await open(f, proj, 'the tests first', 2);
  assert.equal(a.sent, true);
  await until('the first start', () => starts().length === 1);
  assert.equal(budgetOf(starts()[0]), '2', 'its first start: what its opener gave');
  await until('its idle stop', () => f.peek(a.id) && !f.peek(a.id).busy && !running(a.id));
  ledger().spent(0.7, 'her own turn');
  await f.send(a.id, 'and the docs');
  await until('the start after its idle stop', () => starts().length === 2);
  assert.ok(starts()[1].includes('--resume'), JSON.stringify(starts()[1]));
  assert.equal(budgetOf(starts()[1]), '1.3', 'a new share: $2 less the $0.70 spent');
  const held = ledgerLines().filter((e) => e.kind === 'hold' && e.usd);
  assert.deepEqual(held.map((e) => e.usd), [1.3]);
  assert.equal(ledgerLines().find((e) => e.kind === 'bind' && e.hold === held[0].id).session, `this|chat:${a.id}`, 'bound to its chat');
  await until('its idle stop', () => !f.peek(a.id).busy && !running(a.id));
  assert.ok(ledgerLines().some((e) => e.kind === 'spent' && e.hold === held[0].id), 'its process ended: its hold is settled');
  // What its second turn cost (the stand-in reports a cent a turn) is measured and counts in the hold's place.
  assert.deepEqual(ledger().today(), { spent: 0.71, held: 0 });
  await f.close();
  ledger().spent(0.5, 'her own turn');
  f = make(); // the dashboard started again: the chat comes back from its file
  await f.send(a.id, 'and the changelog');
  await until('the start after the restart', () => starts().length === 3);
  assert.equal(budgetOf(starts()[2]), '0.79', 'restored with a new share: $2 less the $1.21 counted');
  await until('its idle stop', () => !f.peek(a.id).busy && !running(a.id));
  assert.equal(ledger().detail().parts, undefined, 'no hold left running');
});

test('a later start with a share under a cent, or no limit any more: the coding tool is not started, the chat says it could not start and why, nothing is held, the message stays', async (t) => {
  const { ledger } = await import('../../src/operator/money.mjs');
  fs.rmSync(spendFile(), { force: true });
  const proj = path.join(box.root, 'proj', 'notice');
  fs.mkdirSync(proj, { recursive: true });
  const conf = (cap) => ({ server: { roots: [path.dirname(proj)] }, assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: cap }, automation: { schedules: { atOnce: 1 } } });
  saveConfig(conf(1));
  const { make, starts } = chatFeatureFor('notice');
  const f = make();
  t.after(() => f.close());
  const a = await open(f, proj, 'first', 0.5);
  await until('the first start', () => starts().length === 1);
  await until('its idle stop', () => f.peek(a.id) && !f.peek(a.id).busy && !running(a.id));
  ledger().spent(0.995, 'her own turn');
  const events = async () => (await routeOf(f, 'GET', `/api/chats/${a.id}`)()).events;
  const before = ledgerLines();
  await f.send(a.id, 'second');
  assert.equal(starts().length, 1, 'no process was started for it');
  assert.equal(running(a.id), false, 'and no run record is left');
  let ev = await events();
  const ends = () => ev.filter((e) => e.kind === 'turn-end' && e.subtype === 'start');
  t.diagnostic(`FIG refused end=${JSON.stringify(ends().at(-1))} ledger before=${before.length} after=${ledgerLines().length}`);
  assert.equal(ends().length, 1);
  assert.match(ends()[0].error, /^Claude Code could not start: today's daily limit for paid use of \$1\.00 has too little left for another part \(.*\); raise the limit in Settings → Tia, or wait for tomorrow$/);
  assert.deepEqual(ledgerLines(), before, 'nothing held, nothing written');
  assert.ok(ev.some((e) => e.kind === 'user' && e.text === 'second'), 'the message stays in the chat');
  assert.equal(ev.some((e) => e.kind === 'notice' && /budget of \$0\.01/.test(e.text)), false, 'no run with a cent');
  saveConfig(conf(null));
  await f.send(a.id, 'third');
  assert.equal(starts().length, 1, 'no limit: no process either');
  ev = await events();
  assert.match(ends().at(-1).error, /^Claude Code could not start: no daily limit for paid use is set \(Settings → Tia\)$/);
  assert.deepEqual(ledgerLines(), before);
  // Room again: the next start runs, with its share held.
  saveConfig(conf(3));
  await f.send(a.id, 'fourth');
  await until('the start with room', () => starts().length === 2);
  const held = ledgerLines().filter((e) => e.kind === 'hold' && e.usd && !before.some((b) => b.id === e.id));
  t.diagnostic(`FIG room budget=${budgetOf(starts()[1])} held=${JSON.stringify(held.map((e) => e.usd))}`);
  assert.equal(held.length, 1);
  assert.equal(budgetOf(starts()[1]), String(held[0].usd));
  await until('its idle stop', () => !f.peek(a.id).busy && !running(a.id));
});

test('two parts\' processes that start again at the same moment hold at most what is left together', async (t) => {
  fs.rmSync(spendFile(), { force: true });
  const proj = path.join(box.root, 'proj', 'pair');
  fs.mkdirSync(proj, { recursive: true });
  saveConfig({ server: { roots: [path.dirname(proj)] }, assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: 2 }, automation: { schedules: { atOnce: 2 } } });
  const { make, starts } = chatFeatureFor('pair');
  const f = make();
  t.after(() => f.close());
  const a = await open(f, proj, 'one', 1);
  const b = await open(f, proj, 'two', 1);
  await until('two first starts', () => starts().length === 2);
  await until('their idle stops', () => [a, b].every((x) => f.peek(x.id) && !f.peek(x.id).busy && !running(x.id)));
  const { ledger } = await import('../../src/operator/money.mjs');
  ledger().spent(0.5, 'her own turn');
  await Promise.all([f.send(a.id, 'again'), f.send(b.id, 'again')]);
  await until('two later starts', () => starts().length === 4);
  const budgets = starts().slice(2).map((x) => Number(budgetOf(x)));
  assert.ok(budgets.every((x) => x > 0), JSON.stringify(budgets));
  assert.ok(budgets[0] + budgets[1] <= 1.5 + 1e-9, `$1.50 was left: ${budgets}`);
});

test('a part\'s chat moved to a subscription starts with no --max-budget-usd, and its hold is settled', async (t) => {
  writeProfile('sub', { label: 'Made-up subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-oauth-token-0123456789' } });
  const { ledger } = await import('../../src/operator/money.mjs');
  fs.rmSync(spendFile(), { force: true });
  const proj = path.join(box.root, 'proj', 'moved');
  fs.mkdirSync(proj, { recursive: true });
  saveConfig({ server: { roots: [path.dirname(proj)] }, assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: 2 }, automation: { schedules: { atOnce: 1 } } });
  const body = {};
  const { make, starts } = chatFeatureFor('moved', { body });
  const f = make();
  t.after(() => f.close());
  const a = await open(f, proj, 'first', 1);
  await until('the first start', () => starts().length === 1);
  await until('its idle stop', () => f.peek(a.id) && !f.peek(a.id).busy && !running(a.id));
  // A hold of its own that nothing settled yet (as one an earlier run of the dashboard left behind).
  assert.equal(ledger().take(2, { id: 'part-left', amount: 1 }), null);
  ledger().bind('part-left', `this|chat:${a.id}`, 0, true);
  body.profile = 'sub';
  await routeOf(f, 'POST', `/api/chats/${a.id}/provider`)();
  await f.send(a.id, 'on the subscription now');
  await until('its next start', () => starts().length === 2);
  assert.equal(starts()[1].includes('--max-budget-usd'), false, JSON.stringify(starts()[1]));
  assert.ok(ledgerLines().some((e) => e.kind === 'spent' && e.hold === 'part-left'), 'its hold is settled');
  assert.equal(ledgerLines().filter((e) => e.kind === 'hold' && e.usd).length, 1, 'no new hold');
  // That hold was left behind (its process end never seen): the rest of its budget counts for the day as not measured.
  const d = ledger().detail();
  assert.equal(d.parts, undefined, 'nothing held for it as running any more');
  assert.deepEqual([d.spent, d.held, d.unseen, d.unseenHeld, d.cuts], [0.01, 0.99, 1, 0.99, undefined], 'its turn\'s $0.01 spent, the rest of its $1 counted as a part whose end was not seen');
});

test('the dashboard\'s start settles nothing: a hold an earlier run left counts for the day until its chat starts again', async (t) => {
  const { ledger } = await import('../../src/operator/money.mjs');
  fs.rmSync(spendFile(), { force: true });
  assert.equal(ledger().take(2, { id: 'part-older', amount: 1 }), null);
  ledger().bind('part-older', 'this|chat:made-up-chat', 0, true);
  const { make } = chatFeatureFor('boot');
  const f = make();
  t.after(() => f.close());
  f.start();
  assert.deepEqual(ledger().today(), { spent: 0, held: 1 }, 'still held: its process may still run');
});

test('a dashboard killed inside a part\'s turn: at the chat\'s next start the rest of that budget counts, and the new share is what is left beside it', async (t) => {
  const { ledger } = await import('../../src/operator/money.mjs');
  fs.rmSync(spendFile(), { force: true });
  const proj = path.join(box.root, 'proj', 'killed');
  fs.mkdirSync(proj, { recursive: true });
  saveConfig({ server: { roots: [path.dirname(proj)] }, assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: 3 }, automation: { schedules: { atOnce: 1 } } });
  const { make, starts } = chatFeatureFor('killed');
  const f1 = make();
  const a = await open(f1, proj, 'first', 1);
  await until('the first start', () => starts().length === 1);
  await until('its idle stop', () => f1.peek(a.id) && !f1.peek(a.id).busy && !running(a.id));
  await f1.close();
  // An earlier run of the dashboard: a later process of this chat held $2 and was inside a turn at the last look (no
  // cost reported yet); then that dashboard was killed, so the end of the process was never seen.
  const key = `this|chat:${a.id}`;
  assert.equal(ledger().take(3, { id: 'part-killed', amount: 2 }), null);
  ledger().bind('part-killed', key, 0.01, true);
  ledger().measure(key, 0, true);
  const f2 = make();
  t.after(() => f2.close());
  f2.start();
  assert.deepEqual(ledger().today(), { spent: 0, held: 2 }, 'the dashboard\'s start settles nothing');
  await f2.send(a.id, 'after the restart');
  await until('the start after the restart', () => starts().length === 2);
  assert.equal(budgetOf(starts()[1]), '1', 'what is left beside a turn of up to $2 whose cost was never reported');
  const t2 = ledger().today();
  assert.equal(Math.round((t2.spent + t2.held) * 100) / 100, 3, 'the killed turn\'s $2 and the new $1: the whole $3 limit, never more');
  // Settled with a reason of its own: its end was not seen, never "stopped before it reported".
  const settled = ledgerLines().find((e) => e.kind === 'spent' && e.hold === 'part-killed');
  t.diagnostic(`FIG killed settled=${JSON.stringify(settled)} detail=${JSON.stringify(ledger().detail())}`);
  assert.equal(settled.why, 'unseen');
  assert.equal(settled.cut, 2);
  const d = ledger().detail();
  assert.deepEqual([d.unseen, d.unseenHeld, d.cuts], [1, 2, undefined]);
  await until('its idle stop', () => !f2.peek(a.id).busy && !running(a.id));
});

test('a later start refused for room starts no process and holds nothing; once the other part ended, the next start runs', async (t) => {
  const { ledger } = await import('../../src/operator/money.mjs');
  fs.rmSync(spendFile(), { force: true });
  const proj = path.join(box.root, 'proj', 'cent');
  fs.mkdirSync(proj, { recursive: true });
  saveConfig({ server: { roots: [path.dirname(proj)] }, assistant: { enabled: true, level: 'handsoff', accounts: ['paid'], dailyCapUsd: 1 }, automation: { schedules: { atOnce: 2 } } });
  const { make, starts } = chatFeatureFor('cent');
  const f = make();
  t.after(() => f.close());
  const a = await open(f, proj, 'first', 0.5);
  await until('the first start', () => starts().length === 1);
  await until('its idle stop', () => f.peek(a.id) && !f.peek(a.id).busy && !running(a.id));
  // Another part runs now and holds all that is left.
  const t0 = ledger().today();
  const free = Math.round((1 - t0.spent - t0.held) * 100) / 100;
  assert.equal(ledger().take(1, { id: 'part-other', amount: free }), null);
  ledger().bind('part-other', 'this|chat:made-up-other', 0, true);
  const before = ledgerLines();
  const d0 = ledger().detail();
  await f.send(a.id, 'again');
  assert.equal(starts().length, 1, 'no process was started: the stand-in ran once only');
  assert.equal(running(a.id), false);
  const ev = (await routeOf(f, 'GET', `/api/chats/${a.id}`)()).events;
  const end = ev.filter((e) => e.kind === 'turn-end' && e.subtype === 'start').at(-1);
  t.diagnostic(`FIG refused free=${free} detail=${JSON.stringify(d0)} end=${JSON.stringify(end && end.error)}`);
  assert.match(end.error, /^Claude Code could not start: today's daily limit for paid use of \$1\.00 has too little left for another part \(.*held by a part that runs now\); raise the limit in Settings → Tia, or wait until a part ends$/);
  assert.deepEqual(ledgerLines(), before, 'the ledger is unchanged: nothing held for it');
  assert.deepEqual(ledger().detail(), d0);
  assert.ok(ev.some((e) => e.kind === 'user' && e.text === 'again'), 'the message stays in the chat');
  // The other part ends at $0.10: room again, and the next start runs with its share held.
  ledger().measure('this|chat:made-up-other', 0.1, false);
  ledger().settleParts('this|chat:made-up-other');
  await f.send(a.id, 'again, with room');
  await until('the start with room', () => starts().length === 2);
  const held = ledgerLines().filter((e) => e.kind === 'hold' && e.usd && !before.some((b) => b.id === e.id));
  const d = ledger().detail();
  t.diagnostic(`FIG room budget=${budgetOf(starts()[1])} held=${JSON.stringify(held.map((e) => e.usd))} detail=${JSON.stringify(d)}`);
  assert.equal(held.length, 1);
  assert.equal(budgetOf(starts()[1]), String(held[0].usd));
  assert.ok(d.spent + d.held <= 1 + 1e-9, `never past the $1 limit: ${JSON.stringify(d)}`);
  await until('its idle stop', () => !f.peek(a.id).busy && !running(a.id));
});
