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
const { activityRows, activityWords, sessionWords, stamp, startWords, KIT_TITLES, WORDED } = await import('../../web/tiaactivity.js');

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
    'Every day at 08:30, start a session in the Terminal in api-server on Auto mode.');
  assert.equal(whatText({ type: 'start', dir: 'C:\\work\\shop', profile: 'max' }, label), 'start a session in the Terminal in shop on Claude Max');
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
  assert.equal(activityLine(chat).sub, 'Schedule · a session in the App');
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
  assert.equal(start.question, 'Start Claude Code in the Terminal in landing-page on Claude Max?', 'a terminal says which coding tool starts in it');
  assert.equal(start.quote, 'Add a toggle');
  assert.match(start.why, /you chose "Ask me"/);

  // The chat tools say the same in plain words; the terminal's key now goes through send_to_session.
  const chat = plainCard({ tool: 'start_chat', input: { folder: '/p/landing-page', account: 'max', message: 'Add a toggle' }, lines: [] }, { accounts: ACCOUNTS });
  assert.equal(chat.question, 'Start a session in the App in landing-page on Claude Max?', 'Claude Code alone: a chat is its chat');
  assert.equal(chat.quote, 'Add a toggle');
  const C = 'chat:44444444-4444-4444-8444-444444444444';
  assert.equal(plainCard({ tool: 'send_to_chat', input: { session: C, text: 'run the tests' }, lines: [] }).question, 'Send this to a session in the App?', 'never its id');
  const chats = [{ name: C, kind: 'chat', title: 'Fix the login', cwd: '/w/shop' }];
  const named = (n) => sessionWords(n, chats);
  assert.equal(plainCard({ tool: 'send_to_chat', input: { session: C, text: 'run the tests' }, lines: [] }, { chat: named }).question, 'Send this to the App session "Fix the login"?');
  assert.equal(plainCard({ tool: 'send_to_chat', input: { session: C, answer: 'allow' }, lines: [`The session asks: Allow Bash: npm test?`] }, { chat: named }).question, 'Allow what the App session "Fix the login" asks?');
  assert.equal(sessionWords(C, [{ ...chats[0], title: '' }]), 'the App session in shop', 'no title yet: its folder');
  assert.deepEqual(plainCard({ tool: 'send_to_chat', input: { session: C, answer: 'allow' }, lines: ['The session asks: Allow Bash: npm test?'] }).notes, ['The session asks: Allow Bash: npm test?']);
  assert.equal(plainCard({ tool: 'send_to_session', input: { session: 'web', key: '1' }, lines: [] }).question, 'Press 1 in the session web?');
  assert.equal(plainCard({ tool: 'send_to_session', input: { session: 'web', text: 'yes' }, lines: [] }).question, 'Type this into the session web?');
  const lbl = (n) => (n === 'max' ? 'Claude Max' : n);
  assert.equal(whatText({ type: 'start', in: 'chat', dir: '/w/shop', profile: 'max' }, lbl), 'start a session in the App in shop on Claude Max');
  assert.equal(whatText({ type: 'send', session: C, text: 'go' }), 'send a message to a session in the App');
  assert.equal(whatText({ type: 'send', session: C, text: 'go' }, lbl, () => 'the chat "Fix it"'), 'send a message to the chat "Fix it"');
  // Where more than one coding tool is offered, the sentence names the tool: a terminal is Claude Code's.
  assert.equal(whatText({ type: 'start', in: 'chat', tool: 'opencode', dir: '/w/shop', profile: 'max' }, lbl), 'start a session in the App with OpenCode in shop on Claude Max');
  assert.equal(whatText({ type: 'start', dir: '/w/shop', profile: 'max' }, lbl, undefined, { named: true }), 'start Claude Code in the Terminal in shop on Claude Max');
  assert.equal(whatText({ type: 'start', in: 'chat', dir: '/w/shop', profile: 'max' }, lbl, undefined, { named: true }), 'start a session in the App with Claude Code in shop on Claude Max');

  const other = plainCard({ tool: 'kill_process', input: { pid: 42 }, lines: ['Why a card: risky', 'End process 42 on this', 'Command: node x'] });
  assert.equal(other.question, 'End process 42?');
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
  // True with any coding tool on: the memory is the AI brain they all share, not one coding tool's.
  for (const x of EXAMPLES) assert.doesNotMatch(x, /Claude|OpenCode|Codex/, x);
  assert.ok(EXAMPLES.some((x) => /the AI brain remember/.test(x)));
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
  // A chat by its folder (as the job's log names it) and its title; never by its id.
  assert.equal(jobLabel({ session: `chat:${id}`, folder: 'shop' }, 'Fix the login'), 'App session in shop: Fix the login');
  assert.equal(jobLabel({ session: `chat:${id}` }, 'Fix the login'), 'App session: Fix the login');
  assert.equal(jobLabel({ session: `chat:${id}`, folder: 'shop' }), 'App session in shop');
  assert.equal(jobLabel({ session: `chat:${id}` }), 'A session in the App');
  assert.equal(jobLabel({ session: 'web-ui' }, 'ignored'), 'web-ui');
  const chip = jobChip({ computer: 'this', session: `chat:${id}`, folder: 'shop' }, 'Fix the login');
  const last = chip.children.at(-1);
  assert.equal(last.tag, 'span', 'the label in its own element, cut with "…" by the stylesheet');
  assert.equal(last.children.map((c) => c.text ?? c).join(''), 'App session in shop: Fix the login');
  assert.equal(chip.attrs.title, 'App session in shop: Fix the login', 'the whole label as its tooltip');
  // The smoke on a phone: a long title ran out of the card, and the line under the goal lost the count behind "…".
  const css = fs.readFileSync(path.join(WEB, 'page-automations.css'), 'utf8');
  assert.match(css, /\.tia-jobchip \{ flex: 0 1 auto; min-width: 0; max-width: 100%; \}/);
  assert.match(css, /\.tia-jobchip > span \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.match(src, /h\('span\.row-sub', `\$\{stamp\(j\.createdAt\)\} · \$\{j\.sessions\.length \? '' : 'no session yet · '\}\$\{j\.steps\} of \$\{j\.maxSteps\} answers used`\)/, 'the sessions are the chips; the line keeps the count');
});

test('Tia\'s words: manage_computer says what each action does; no words for a tool she no longer has', async () => {
  const { DID, DOING, TOOL_WORDS, wordFor } = await import('../../web/tiawords.js');
  assert.equal(wordFor(TOOL_WORDS, 'manage_computer', 'update'), 'update or install on a computer');
  assert.equal(wordFor(DOING, 'manage_computer', 'check_updates'), 'checking for updates');
  assert.equal(wordFor(DID, 'manage_computer', 'coding_tool'), 'turned a coding tool on or off');
  assert.equal(wordFor(TOOL_WORDS, 'manage_computer', 'rename'), 'change a computer', 'any other action: the tool\'s own words');
  assert.equal(wordFor(DID, 'start_chat'), 'started a session in the App');
  for (const m of [TOOL_WORDS, DOING, DID]) assert.equal(m.update_claude_code, undefined, 'folded into manage_computer update');
});

test('her card for a start says what starts: a chat or a terminal, and the coding tool where it matters', () => {
  const ask = (tool, input, tools) => plainCard({ tool, input: { folder: '/w/projects/blog', account: 'gw', ...input }, lines: [] }, { accounts: [{ name: 'gw', label: 'Gateway', kind: 'api' }], tools }).question;
  // The two the smoke found: an OpenCode chat and an OpenCode terminal, each said by name.
  assert.equal(ask('start_chat', { coding_tool: 'opencode' }, 2), 'Start a session in the App with OpenCode in blog on Gateway?');
  assert.equal(ask('start_session', { coding_tool: 'opencode' }, 2), 'Start OpenCode in the Terminal in blog on Gateway?');
  // Claude Code's chat: named while another coding tool is on, not while it is the only one.
  assert.equal(ask('start_chat', {}, 2), 'Start a session in the App with Claude Code in blog on Gateway?');
  assert.equal(ask('start_chat', {}, 1), 'Start a session in the App in blog on Gateway?');
  assert.equal(ask('start_chat', { coding_tool: 'opencode' }, 1), 'Start a session in the App with OpenCode in blog on Gateway?', 'another coding tool always');
  assert.equal(ask('start_session', {}, 1), 'Start Claude Code in the Terminal in blog on Gateway?');
  // Another computer: the provider and the computer each said so, and the same words as the row in Activity.
  const there = { tool: 'start_chat', input: { folder: '/w/projects/blog', account: 'gw', coding_tool: 'opencode', computer: 'laptop' }, lines: [] };
  assert.equal(plainCard(there, { accounts: [{ name: 'gw', label: 'Gateway' }], computerLabel: 'Laptop', tools: 2 }).question, 'Start a session in the App with OpenCode in blog on Gateway, on the computer Laptop?');
  assert.equal(activityWords(there, { ...PLACE, computer: () => 'Laptop' }).what, 'start a session in the App with OpenCode in blog on Gateway, on the computer Laptop');
  // The other tools' cards too: Auto mode reads as what is done to it, as in Activity.
  assert.equal(plainCard({ tool: 'set_auto_mode', input: { enabled: true }, lines: [] }).question, 'Turn Auto mode on?');
  assert.equal(plainCard({ tool: 'change_setting', input: { key: 'upload_max_mb', value: 50 }, lines: [] }).question, 'Change the setting "Largest upload" to 50 MB?');
  assert.equal(plainCard({ tool: 'some_new_tool', input: {}, lines: [] }).question, 'Make a change?', 'never a tool\'s name');
  assert.equal(startWords({ kind: 'chat', tool: 'opencode', folder: 'C:\\work\\shop' }), 'start a session in the App with OpenCode in shop');
});

test('a start on an earlier conversation says so, on its card and in Activity, and that its OKs stay the owner\'s', () => {
  const ID = '33333333-3333-4333-8333-333333333333';
  const accounts = [{ name: 'gw', label: 'Gateway', kind: 'api' }];
  const card = (tool, input, lines = []) => plainCard({ tool, input: { folder: '/w/projects/shop', account: 'gw', ...input }, lines }, { accounts, tools: 1 });
  const row = (tool, input) => activityWords({ tool, input: { folder: '/w/projects/shop', account: 'gw', ...input } }, { ...PLACE, tools: 1 }).what;
  const resume = card('start_session', { mode: 'resume', conversation: ID }, ['Start Claude Code session in a terminal in /w/projects/shop on this under gw (paid API provider)', `Continuing conversation ${ID}`]);
  assert.equal(resume.question, 'Continue an earlier Claude Code conversation in the Terminal in shop on Gateway?');
  assert.ok(resume.notes.some((n) => /that conversation's history, so every OK it asks for comes to you/.test(n)), 'its OKs are the owner\'s');
  assert.ok(resume.notes.some((n) => /paid per use/.test(n)), 'and it still says it costs money');
  assert.deepEqual(resume.details, [`Continuing conversation ${ID}`], 'the id in Details, nothing else of the lines');
  assert.equal(row('start_session', { mode: 'resume', conversation: ID }), 'continue an earlier Claude Code conversation in the Terminal in shop on Gateway');
  const newest = card('start_session', { mode: 'continue', coding_tool: 'opencode' }, ['Continuing the folder\'s newest conversation']);
  assert.equal(newest.question, 'Continue the newest OpenCode conversation in the Terminal in shop on Gateway?');
  assert.deepEqual(newest.details, []);
  assert.equal(row('start_session', { mode: 'continue', coding_tool: 'opencode' }), 'continue the newest OpenCode conversation in the Terminal in shop on Gateway');
  const chat = card('start_chat', { conversation: ID }, [`Continuing conversation ${ID}`]);
  assert.equal(chat.question, 'Continue an earlier conversation in the App in shop on Gateway?');
  assert.ok(chat.notes.some((n) => /every OK it asks for comes to you/.test(n)));
  assert.equal(row('start_chat', { conversation: ID }), 'continue an earlier conversation in the App in shop on Gateway');
  // A new one says nothing of the kind.
  const fresh = card('start_session', { mode: 'new' });
  assert.equal(fresh.question, 'Start Claude Code in the Terminal in shop on Gateway?');
  assert.ok(!fresh.notes.some((n) => /that conversation/.test(n)));
});

// The page's view of a computer, as tia.js hands it to activityWords.
const PLACE = {
  provider: (n) => ({ sub: 'Main', sub2: 'Work', gw: 'Gateway', auto: 'Auto mode' })[n] || n,
  computer: (n) => (n === 'laptop' ? 'Laptop' : n),
  chat: (n) => sessionWords(n, [{ name: 'chat:44444444-4444-4444-8444-444444444444', title: 'Fix the login', cwd: '/w/shop' }]),
  tools: 2,
};
const KEY_NAME = /\b(coding_tool|account|accounts|runsOn|maxSteps|maxMinutes|tia_settings|null|undefined|\[object|chat:[0-9a-f]|NaN)\b|[a-z]+_[a-z_]+:|"\w+":/;

test('Activity: the two rows the smoke found read as plain sentences', () => {
  const set = activityWords({ actor: 'owner', tool: 'tia_settings', input: { level: 'work', accounts: ['sub', 'sub2', 'gw'], runsOn: null, model: null, maxSteps: 20, maxMinutes: 240 } }, PLACE);
  assert.equal(set.what, 'change Tia\'s settings');
  assert.equal(set.detail, 'how far she may go: Do the work · providers she may use: Main, Work, Gateway · she runs on: Automatic · her model: the provider\'s default · 20 answers per job · 240 minutes per job');
  const tool = activityWords({ actor: 'assistant', tool: 'manage_computer', input: { action: 'coding_tool', coding_tool: 'opencode', turn: 'on' } }, PLACE);
  assert.equal(tool.what, 'turn OpenCode on');
  const chat = activityWords({ actor: 'assistant', tool: 'start_chat', input: { folder: '/w/projects/blog', coding_tool: 'opencode', account: 'gw', message: 'hello', goal: 'it answered', computer: 'laptop' } }, PLACE);
  assert.deepEqual(chat, { what: 'start a session in the App with OpenCode in blog on Gateway, on the computer Laptop', detail: 'done when: it answered', quote: 'hello' });
  const send = activityWords({ actor: 'assistant', tool: 'send_to_chat', input: { session: 'chat:44444444-4444-4444-8444-444444444444', answer: 'allow' } }, PLACE);
  assert.equal(send.what, 'allow what the App session "Fix the login" asks', 'a chat by its title, never its id');
  for (const r of [set, tool, chat, send]) assert.doesNotMatch(`${r.what} ${r.detail}`, KEY_NAME);
});

test('Activity: every tool and action she has reads in words, with no key name and no null', async () => {
  const { MCP_TOOLS } = await import('../../src/assistant/tools.mjs');
  // A value for each input key, by its schema: an enum's first, else one of its type (null where it may be null).
  const sample = (k, p) => (p.enum ? p.enum[0] : p.type === 'array' ? (k === 'order' ? ['sub', 'gw'] : ['x-1']) : p.type === 'boolean' ? true : p.type === 'integer' || p.type === 'number' ? 3
    : k === 'folder' ? '/w/projects/shop' : k === 'session' ? 'chat:44444444-4444-4444-8444-444444444444' : k === 'account' ? 'gw' : k === 'computer' ? 'laptop' : p.type === 'string' ? 'x-1' : null);
  for (const t of MCP_TOOLS.filter((x) => !x.annotations.readOnlyHint)) {
    const props = t.inputSchema.properties || {};
    const actions = props.action ? props.action.enum : [undefined];
    if (props.action) assert.deepEqual([...WORDED.actions[t.name]].sort(), [...actions].sort(), `${t.name}: words for each action`);
    else assert.ok(WORDED.tools.includes(t.name), `${t.name} has words`);
    for (const action of actions) {
      const input = Object.fromEntries(Object.entries(props).map(([k, p]) => [k, sample(k, p)]));
      if (action) input.action = action;
      const r = activityWords({ actor: 'assistant', tool: t.name, input }, PLACE);
      const all = `${r.what} ${r.detail}`;
      assert.doesNotMatch(all, KEY_NAME, `${t.name} ${action || ''}: ${all}`);
      assert.doesNotMatch(r.what, /^make a change/, `${t.name} ${action || ''} has its own words`);
      assert.doesNotMatch(all, /\b(sub|gw)\b/, `${t.name} ${action || ''}: providers by their labels: ${all}`);
    }
  }
  // Her own settings and the owner's other steps there; nulls say what they mean.
  for (const input of [{ enabled: false }, { accounts: null }, { accounts: [] }, { runsOn: 'gw', model: 'haiku' }, { runsOn: null, model: '' }]) {
    const r = activityWords({ actor: 'owner', tool: 'tia_settings', input }, PLACE);
    assert.doesNotMatch(`${r.what} ${r.detail}`, KEY_NAME, JSON.stringify(input));
    assert.ok(r.detail, JSON.stringify(input));
  }
  assert.equal(activityWords({ actor: 'owner', tool: 'client_token', input: {} }, PLACE).what, 'make a token for your own Claude Code');
  assert.equal(activityWords({ actor: 'owner', tool: 'stop_job', input: { job: 'j_0123456789' } }, PLACE).what, 'stop a job');
  assert.equal(activityWords({ actor: 'assistant', tool: 'change_setting', input: { key: 'new_session_model', value: null } }, PLACE).what, 'change the setting "Model of new sessions" to the default');
  // Units and names where the input has them; the kits by the titles of Set up this computer.
  assert.equal(activityWords({ actor: 'assistant', tool: 'change_setting', input: { key: 'upload_max_mb', value: 50 } }, PLACE).what, 'change the setting "Largest upload" to 50 MB');
  assert.equal(activityWords({ actor: 'assistant', tool: 'manage_computer', input: { action: 'set_up', kits: ['node', 'extras'] } }, PLACE).what, 'set up Node.js, Terminal extras');
  const { KITS } = await import('../../src/pcsetup/kits.mjs');
  assert.deepEqual(KIT_TITLES, Object.fromEntries(KITS.map((k) => [k.id, k.title])), 'the same titles as Set up this computer');
  // A tool of a later version: a plain sentence, never its name.
  assert.equal(activityWords({ actor: 'assistant', tool: 'some_new_tool', input: { some_key: 1 } }, PLACE).what, 'make a change');
});

test('her box: Escape closes it and gives the focus back; Tab stays inside only where it covers the page', async () => {
  const { keepTabIn } = await import('../../web/tabwrap.js');
  const handlers = [];
  const [a, b] = [{ tabIndex: 0, getClientRects: () => [1], focus() { globalThis.document.activeElement = this; } }, { tabIndex: 0, getClientRects: () => [1], focus() { globalThis.document.activeElement = this; } }];
  const panel = { addEventListener: (t, f) => handlers.push(f), querySelectorAll: () => [a, b] };
  let wide = true;
  keepTabIn(panel, { when: () => !wide });
  const tab = () => {
    let stopped = false;
    handlers[0]({ key: 'Tab', shiftKey: false, defaultPrevented: false, preventDefault: () => (stopped = true) });
    return stopped;
  };
  globalThis.document.activeElement = b;
  assert.equal(tab(), false, 'a desktop: the box floats beside the page, Tab goes on to it');
  wide = false;
  assert.equal(tab(), true, 'a phone: the box covers the page like a sheet, Tab goes round inside');
  assert.equal(globalThis.document.activeElement, a);
  delete globalThis.document.activeElement;
  // How tia.js wires it (the rest is proven in a browser: the screenshots of this change).
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.match(src, /keepTabIn\(box\.panel, \{ when: covers \}\)/);
  assert.match(src, /const COVERS = '\(max-width: 899px\)';\nconst covers = \(\) => typeof matchMedia === 'function' && matchMedia\(COVERS\)\.matches;/);
  assert.match(src, /matchMedia\(COVERS\)\.addEventListener\('change', \(\) => box\.panel\.setAttribute\('aria-modal', String\(covers\(\)\)\)\)/, 'aria-modal follows the width while it is open');
  assert.match(src, /if \(e\.key !== 'Escape' \|\| e\.defaultPrevented\) return;\s+e\.preventDefault\(\);\s+closeBox\(\);/);
  assert.match(src, /onclick: closeBox/, 'its own close button gives the focus back too');
  const css = fs.readFileSync(path.join(WEB, 'page-automations.css'), 'utf8');
  assert.match(css, /@media \(max-width: 899px\) \{\s+\.tia-launch \{ display: none; \}\s+\.tia-box \{ position: fixed; inset: 0;/, 'the same width at which the box covers the page');
});

test('Activity: a card\'s entries are one row, and her proposal never says it waits once it was answered', () => {
  const t = (m) => Date.UTC(2026, 10, 17, 7, m);
  const start = { tool: 'start_chat', input: { folder: '/w/projects/blog', account: 'gw' } };
  // Newest first, as the server gives them: confirmed and done (the owner), staged (her), and a step without a card.
  const rows = activityRows([
    { ...start, actor: 'owner', outcome: 'done', card: 'k1', at: t(3) },
    { actor: 'owner', tool: 'tia_settings', input: { level: 'work' }, outcome: 'done', at: t(2) },
    { ...start, actor: 'owner', outcome: 'confirmed', card: 'k1', at: t(2) },
    { ...start, actor: 'assistant', outcome: 'staged', card: 'k1', at: t(1) },
    { ...start, actor: 'assistant', outcome: 'staged', card: 'k2', at: t(0) },
  ]);
  assert.deepEqual(rows.map((r) => [r.e.actor, r.e.tool, r.steps.join(' · '), r.at]), [
    ['assistant', 'start_chat', 'Asked for your OK · You confirmed · Done', t(3)],
    ['owner', 'tia_settings', 'Done', t(2)],
    ['assistant', 'start_chat', 'Asked for your OK', t(0)],
  ]);
  const declined = activityRows([{ ...start, actor: 'owner', outcome: 'declined', card: 'k3', at: t(5) }, { ...start, actor: 'assistant', outcome: 'staged', card: 'k3', at: t(4) }]);
  assert.deepEqual(declined.map((r) => r.steps), [['Asked for your OK', 'You declined']]);
  const failed = activityRows([{ ...start, actor: 'owner', outcome: 'failed', card: 'k4', error: 'no such folder', at: t(6) }, { ...start, actor: 'owner', outcome: 'confirmed', card: 'k4', at: t(6) }]);
  assert.deepEqual(failed.map((r) => [r.e.actor, r.steps.join(' · '), r.error]), [['owner', 'You confirmed · Failed', 'no such folder']], 'her proposal out of the window: the row is his');
  for (const r of [...rows, ...declined]) assert.doesNotMatch(r.steps.join(' '), /Waiting/);
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.match(src, /activityRows\(r\.entries\)\.map\(\(\{ e, at, steps, error \}\)/, 'the page draws the rows');
});

test('the Tia page\'s times: the time alone today, with the day before that, the same on Jobs and Activity', () => {
  const now = new Date(2026, 10, 17, 9, 0).getTime();
  const today = stamp(new Date(2026, 10, 17, 7, 14).getTime(), now);
  assert.doesNotMatch(today, /2026|Nov/);
  assert.match(today, /07:14|7:14/);
  const before = stamp(new Date(2026, 10, 16, 7, 14).getTime(), now);
  assert.match(before, /Nov 16|16 Nov/);
  assert.doesNotMatch(before, /2026|:37/);
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.doesNotMatch(src, /new Date\(e\.at\)\.toLocaleString\(\)/);
});

test('her chips and cards name every tool she has in words, and a decided card keeps the keyboard\'s place', async () => {
  const { DID, DOING, TOOL_WORDS } = await import('../../web/tiawords.js');
  const { MCP_TOOLS } = await import('../../src/assistant/tools.mjs');
  for (const t of MCP_TOOLS) {
    assert.ok(TOOL_WORDS[t.name], `${t.name}: words for a chip`);
    assert.ok(DOING[t.name], `${t.name}: words while she does it`);
    assert.ok(DID[t.name], `${t.name}: words once done`);
  }
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  // After Confirm or Decline from the keys, the card is drawn again: the focus goes to what came of it.
  assert.match(src, /refreshCards\(\{ focus: hadFocus \? card\.id : null \}\)/);
  assert.match(src, /\.find\(\(x\) => x\.dataset\.card === had\) \|\| cardsBox\.querySelector\('\.tia-card:not\(\.decided\) button'\) \|\| input;/);
  // What came of a card reads as a statement; her question follows it as hers.
  assert.match(src, /done: `You confirmed, and it is done\.\$\{asked\}`/);
  assert.doesNotMatch(src, /it is done: \$\{q\}/);
});
