// The Automations and Tia pages (web/automation.js, web/tia.js): their words are plain sentences, a confirm card
// speaks with the accounts' display names (never ids or monospace lines), and both pages keep to the shared rules
// (styles in their own prefixed file, the product name never typed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// Just enough of a browser for the modules to load (the same stand-in as web.test.mjs).
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => ({ text: t }),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const { whenText, whatText, scheduleSentence, activityLine, foldActivity, queueChoices } = await import('../../web/automation.js');
const { until } = await import('../../web/lib.js');
const { plainCard, EXAMPLES, boldText } = await import('../../web/tia.js');

test('a schedule reads as one sentence', () => {
  assert.equal(whenText({ kind: 'daily', time: '08:30' }), 'Every day at 08:30');
  assert.equal(whenText({ kind: 'weekly', time: '18:00', days: [5, 1, 2, 3, 4] }), 'Weekdays at 18:00');
  assert.equal(whenText({ kind: 'weekly', time: '10:00', days: [0, 6] }), 'Weekends at 10:00');
  assert.equal(whenText({ kind: 'weekly', time: '10:00', days: [3] }), 'Every Wednesday at 10:00');
  assert.equal(whenText({ kind: 'weekly', time: '10:00', days: [1, 3] }), 'Mon, Wed at 10:00');
  assert.match(whenText({ kind: 'once', time: '10:00', date: '2026-11-21' }), /^Once, .+ at 10:00$/);
  assert.equal(whenText({ kind: 'once', time: '10:00', date: '' }), 'Once, a day to pick at 10:00', 'a half-filled form still reads');
  const label = (n) => ({ auto: 'Auto mode', max: 'Claude Max' })[n] || n;
  assert.equal(scheduleSentence({ when: { kind: 'daily', time: '08:30' }, action: { type: 'start', dir: '/home/x/projects/api-server', profile: 'auto' } }, label),
    'Every day at 08:30, start a session in api-server on Auto mode.');
  assert.equal(whatText({ type: 'start', dir: 'C:\\work\\shop', profile: 'max' }, label), 'start a session in shop on Claude Max');
  assert.equal(whatText({ type: 'send', session: 'data-pipeline', text: 'go' }), 'send a message to data-pipeline');
  assert.equal(whatText({ type: 'send', session: '' }), 'send a message to a session');
});

test('Next run uses the same 24-hour clock as the rule', () => {
  const far = new Date(Date.now() + 3 * 86400_000);
  far.setHours(18, 0, 0, 0);
  assert.match(until(far.getTime()), /^\S+ 18:00$/, 'never "06:00 PM" next to "at 18:00"');
  assert.match(until(Date.now() + 2 * 3600_000), /^in 2 h \d+ min$/);
});

test('Queue a message: Claude sessions only, the ones that need you first, with what waits', () => {
  const s = (name, extra = {}) => ({ name, kind: 'claude', status: 'idle', ...extra });
  const items = queueChoices([s('docs'), { name: 'sh', kind: 'shell' }, s('app', { status: 'attention' })], { docs: { count: 2 } });
  assert.deepEqual(items.map((x) => x.value), ['app', 'docs'], 'a plain terminal is not offered; the one that needs you first');
  assert.match(items.find((x) => x.value === 'docs').sub, /2 queued$/);
});

test('Activity: one sentence per entry, and what went wrong said plainly', () => {
  const ok = activityLine({ automation: 'schedules', session: 'api-server', did: 'started "Morning check"', outcome: 'ok' });
  assert.deepEqual(ok, { title: 'Started "Morning check".', sub: 'Schedule · api-server', problem: null });
  const bad = activityLine({ automation: 'queue', session: 'docs', did: 'could not send: hi', outcome: 'failed: the session is gone' });
  assert.equal(bad.problem, 'It did not work: the session is gone.');
  assert.equal(activityLine({ automation: 'retry', did: 'stopped retrying after 3 tries', outcome: 'gave up' }).problem, 'It gave up; open the session to see why.');
  assert.equal(activityLine({ automation: 'updates', did: 'looked for new versions', outcome: 'nothing new' }).sub, 'Updates · Nothing new');
  assert.match(activityLine({ automation: 'schedules', did: 'skipped "x"', outcome: 'missed: 3 hours late, more than allowed' }).problem, /^Missed: 3 hours late/);
  // A chat is never named by its id: by its title where the page knows it, else "a chat".
  const chat = { automation: 'schedules', session: 'chat:55555555-5555-4555-8555-555555555555', did: 'started "start a chat in blog on Gateway"', outcome: 'ok' };
  assert.equal(activityLine(chat).sub, 'Schedule · a chat');
  assert.equal(activityLine(chat, (n) => (n === chat.session ? 'the chat "Fix the build"' : n)).sub, 'Schedule · the chat "Fix the build"');
});

const ACCOUNTS = [{ name: 'max', label: 'Claude Max', kind: 'subscription' }, { name: 'api', label: 'API (pay as you go)', kind: 'api' }];

test('a confirm card asks in plain words with the accounts\' display names, the cost and why', () => {
  // The card exactly as src/assistant stages it for a move to a paid account of a session Tia did not start.
  const card = {
    tool: 'switch_account',
    input: { session: 'docs-site', account: 'api' },
    lines: ['Why a card: Tia did not start this session', 'Move session docs-site on this from max to api', 'api is an API provider: it is paid per token'],
  };
  const p = plainCard(card, { accounts: ACCOUNTS });
  assert.equal(p.question, 'Move the session docs-site from Claude Max to API (pay as you go)?');
  assert.ok(p.notes.some((n) => n === 'API (pay as you go) is paid per use, so the work from here on costs money.'));
  assert.equal(p.why, 'Tia asks because she did not start this session.');
  assert.deepEqual(p.details, [], 'nothing left in "Details" that the sentences already say');
  const all = [p.question, ...p.notes, p.why].join(' ');
  assert.doesNotMatch(all, /\bmax\b|\bapi\b|Why a card|per token/, 'no account ids, no raw lines');

  const paidWhy = plainCard({ ...card, lines: ['Why a card: api is an API provider: it is paid per token', 'Move session docs-site on laptop from null to api'], input: { ...card.input, computer: 'laptop' } },
    { accounts: ACCOUNTS, computerLabel: 'Laptop' });
  assert.equal(paidWhy.question, 'Move the session docs-site on Laptop to API (pay as you go)?');
  assert.equal(paidWhy.why, 'Tia asks because it costs money.');

  const start = plainCard({ tool: 'start_session', input: { folder: '/p/landing-page', account: 'max', message: 'Add a toggle', goal: 'it works' }, lines: ['Why a card: the owner set "Ask me"'] }, { accounts: ACCOUNTS });
  assert.equal(start.question, 'Start a session in landing-page on Claude Max?');
  assert.equal(start.quote, 'Add a toggle');
  assert.match(start.why, /you chose "Ask me"/);

  // The chat tools say the same in plain words; the terminal's key now goes through send_to_session.
  const chat = plainCard({ tool: 'start_chat', input: { folder: '/p/landing-page', account: 'max', message: 'Add a toggle' }, lines: [] }, { accounts: ACCOUNTS });
  assert.equal(chat.question, 'Start a chat in landing-page on Claude Max?');
  assert.equal(chat.quote, 'Add a toggle');
  const C = 'chat:44444444-4444-4444-8444-444444444444';
  assert.equal(plainCard({ tool: 'send_to_chat', input: { session: C, text: 'run the tests' }, lines: [] }).question, `Send this to the chat ${C}?`);
  assert.equal(plainCard({ tool: 'send_to_chat', input: { session: C, answer: 'allow' }, lines: [`The session asks: Allow Bash: npm test?`] }).question, `Allow what the chat ${C} asks?`);
  assert.deepEqual(plainCard({ tool: 'send_to_chat', input: { session: C, answer: 'allow' }, lines: ['The session asks: Allow Bash: npm test?'] }).notes, ['The session asks: Allow Bash: npm test?']);
  assert.equal(plainCard({ tool: 'send_to_session', input: { session: 'web', key: '1' }, lines: [] }).question, 'Press 1 in the session web?');
  assert.equal(plainCard({ tool: 'send_to_session', input: { session: 'web', text: 'yes' }, lines: [] }).question, 'Type this into the session web?');
  const lbl = (n) => (n === 'max' ? 'Claude Max' : n);
  assert.equal(whatText({ type: 'start', in: 'chat', dir: '/w/shop', profile: 'max' }, lbl), 'start a chat in shop on Claude Max');
  assert.equal(whatText({ type: 'send', session: C, text: 'go' }), 'send a message to a chat');
  assert.equal(whatText({ type: 'send', session: C, text: 'go' }, lbl, () => 'the chat "Fix it"'), 'send a message to the chat "Fix it"');
  // Where more than one coding tool is offered, the sentence names the tool: a terminal is Claude Code's.
  assert.equal(whatText({ type: 'start', in: 'chat', tool: 'opencode', dir: '/w/shop', profile: 'max' }, lbl), 'start a chat with OpenCode in shop on Claude Max');
  assert.equal(whatText({ type: 'start', dir: '/w/shop', profile: 'max' }, lbl, undefined, { named: true }), 'start Claude Code in a terminal in shop on Claude Max');
  assert.equal(whatText({ type: 'start', in: 'chat', dir: '/w/shop', profile: 'max' }, lbl, undefined, { named: true }), 'start a chat with Claude Code in shop on Claude Max');

  const other = plainCard({ tool: 'kill_process', input: { pid: 42 }, lines: ['Why a card: risky', 'End process 42 on this', 'Command: node x'] });
  assert.equal(other.question, 'End a process?');
  assert.deepEqual(other.details, ['End process 42 on this', 'Command: node x'], 'other tools keep their own lines under Details');
  assert.equal(other.why, 'Tia asks because risky.');
});

test('her **bold** words become bold elements; nothing becomes HTML', () => {
  const parts = boldText('Three need you: **mobile-app** and **<b>x</b>**, rest **open');
  assert.equal(parts[0], 'Three need you: ');
  assert.equal(parts[1].tag, 'strong');
  assert.equal(parts[1].children.map((c) => c.text ?? c).join(''), 'mobile-app');
  assert.equal(parts[3].children.map((c) => c.text ?? c).join(''), '<b>x</b>', 'set as text, never parsed');
  assert.equal(parts[4], ', rest **open');
});

test('the empty chat offers three requests to tap', () => {
  assert.equal(EXAMPLES.length, 3);
  for (const x of EXAMPLES) assert.ok(x.length < 120, x);
});

test('both pages: styles in their own prefixed file, the shared words, no typed product name', () => {
  for (const f of ['automation.js', 'tia.js']) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /'[^']*\bhoprig\b[^']*'/, `${f}: the name comes from brand.js`);
    assert.doesNotMatch(code, /h\('style'|<style/, `${f}: styles live in page-automations.css`);
    // Words a person reads: "computer", "session", "account" — never "PC" or "profile".
    for (const m of code.matchAll(/(?:label|title|text|intro|desc|placeholder):\s*[`'"]([^`'"]+)[`'"]/g)) {
      assert.doesNotMatch(m[1], /\bPC\b|\bprofile\b/i, `${f}: "${m[1]}"`);
    }
  }
  const css = fs.readFileSync(path.join(WEB, 'page-automations.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of css.split('}').map((r) => r.split('{')[0].trim()).filter((s) => s && !s.startsWith('@') && !/^\d|^(from|to)$/.test(s))) {
    assert.match(rule, /\.(au|tia)-/, `every rule names an au- or tia- class: ${rule}`);
  }
});

test('Activity: no setting key reaches the page, and the same entry in a row is one row with a count', async () => {
  const rule = await import('../../src/automation/workspacesync.mjs');
  const records = [];
  const ctx = { record: (e) => records.push(e), notify: () => {}, data: {}, save: () => {}, workspaceMap: async () => ({ changed: true, lines: ['The map gained api-server'], needs: [] }) };
  await rule.apply([{ type: 'map', commit: false, push: false }], ctx);
  const line = activityLine(records[0]);
  assert.doesNotMatch(`${line.title} ${line.sub}`, /commitMap/);
  assert.match(line.sub, /not saved in the AI brain's history \(Settings → Workspace: "Save a change of the map" is off\)/);
  // An entry written by an older version still reads plainly.
  const old = activityLine({ automation: 'workspace', did: 'The map gained x', outcome: 'written (not saved in the brain\'s history: the commitMap switch is off)' });
  assert.doesNotMatch(old.sub, /commitMap/);
  const e = (did, time) => ({ automation: 'workspace', did, outcome: 'written', time });
  const t = (s) => new Date(Date.UTC(2026, 10, 15, 10, 0, s)).toISOString();
  const run = ['mobile-app', 'landing-page', 'docs-site'].map((x, i) => e(`The map gained ${x}`, t(30 - i)));
  const one = foldActivity([...run, { automation: 'queue', did: 'sent x', outcome: 'ok', time: t(0) }]);
  assert.deepEqual(one.map((x) => [x.e.did, x.n]), [['The map gained docs-site, landing-page and mobile-app', 1], ['sent x', 1]], 'one round is one sentence');
  assert.equal(one[0].e.time, t(30), 'the newest time');
  const same = foldActivity([e('stopped x', t(9)), e('stopped x', t(8)), e('stopped x', t(7)), e('stopped y', t(6))]);
  assert.deepEqual(same.map((x) => [x.e.did, x.n]), [['stopped x', 3], ['stopped y', 1]], 'the same sentence again: one row with a count');
  const apart = foldActivity([e('The map gained a', t(0)), e('The map gained b', new Date(Date.UTC(2026, 10, 15, 4)).toISOString())]);
  assert.equal(apart.length, 2, 'two rounds hours apart stay two rows');
});

test('a job\'s sessions: a chat opens its chat page by its id, a terminal its session page, on its own computer', async () => {
  const { jobChip, jobLabel } = await import('../../web/tiawords.js');
  const id = '77777777-7777-4777-8777-777777777777';
  const href = (el) => el.attrs.href ?? el.href;
  assert.equal(href(jobChip({ computer: 'this', session: `chat:${id}` })), `#/chat/${id}`);
  assert.equal(href(jobChip({ computer: 'box2', session: `chat:${id}` })), `#/m/box2/chat/${id}`);
  assert.equal(href(jobChip({ computer: 'this', session: 'web-ui' })), '#/s/web-ui');
  assert.equal(href(jobChip({ computer: 'box2', session: 'web-ui' })), '#/m/box2/s/web-ui');
  assert.equal(jobLabel({ session: `chat:${id}` }), 'Chat 77777777');
  assert.equal(jobLabel({ session: 'web-ui' }), 'web-ui');
});

test('Tia\'s words: manage_computer says what each action does; no words for a tool she no longer has', async () => {
  const { DID, DOING, TOOL_WORDS, wordFor } = await import('../../web/tiawords.js');
  assert.equal(wordFor(TOOL_WORDS, 'manage_computer', 'update'), 'update or install on a computer');
  assert.equal(wordFor(DOING, 'manage_computer', 'check_updates'), 'checking for updates');
  assert.equal(wordFor(DID, 'manage_computer', 'coding_tool'), 'turned a coding tool on or off');
  assert.equal(wordFor(TOOL_WORDS, 'manage_computer', 'rename'), 'change a computer', 'any other action: the tool\'s own words');
  assert.equal(wordFor(DID, 'start_chat'), 'started a chat');
  for (const m of [TOOL_WORDS, DOING, DID]) assert.equal(m.update_claude_code, undefined, 'folded into manage_computer update');
});
