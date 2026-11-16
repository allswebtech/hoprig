// The chat page's own logic (web/chat/), without a browser: its words, the diff with line numbers, the agents' lines
// and the strip, the status line, the limit card's list of actions, the provider usage words. The page itself is
// proven in a real browser against Claude Code (see the step's notes); here the parts that decide what it says.
import assert from 'node:assert/strict';
import test from 'node:test';

// A small stand-in for the browser DOM: what lib.js's h/fill/add and the views use.
class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: { setProperty() {} }, attrs: {}, children: [], listeners: {} });
    this.classList = { add: (c) => (this.className += ` ${c}`), remove: () => {}, toggle: () => {}, contains: (c) => this.className.split(' ').includes(c) };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const byClass = (n, c) => (n instanceof FakeText ? [] : [...(n.className.split(' ').includes(c) ? [n] : []), ...n.children.flatMap((x) => byClass(x, c))]);

const W = await import('../../web/chat/words.js');
const D = await import('../../web/chat/diff.js');
const Ag = await import('../../web/chat/agents.js');
const St = await import('../../web/chat/statusline.js');
const L = await import('../../web/chat/limit.js');

test('chat page words: the mode chip, Shift+Tab order, model and effort, paths, limits, context, exit codes', () => {
  assert.equal(W.modeChip('bypassPermissions'), 'Bypass');
  assert.equal(W.modeChip(null), 'Ask first');
  assert.ok(W.MODE.bypassPermissions.danger);
  // Shift+Tab: ask first → accept edits → plan → auto → bypass → ask first; never-ask only in the menu
  const ring = [];
  let m = 'manual';
  for (let i = 0; i < 5; i++) ring.push((m = W.nextMode(m)));
  assert.deepEqual(ring, ['acceptEdits', 'plan', 'auto', 'bypassPermissions', 'manual']);
  assert.equal(W.nextMode('dontAsk'), 'manual');
  assert.equal(W.nextMode('acceptEdits', ['manual', 'acceptEdits']), 'manual'); // only the modes the server offers
  // What the process says wins over what is set; Claude Code's "default" is the dashboard's "manual".
  assert.equal(W.modeOf({ liveMode: 'default', permissionMode: 'plan' }), 'manual');
  assert.equal(W.modeOf({ liveMode: null, permissionMode: 'plan' }), 'plan');
  assert.equal(W.modelName('sonnet'), 'Sonnet');
  assert.equal(W.modelName(null), 'Auto');
  assert.equal(W.modelName('claude-opus-5-5'), 'opus-5-5');
  assert.equal(W.effortName('xhigh'), 'Extra high');
  assert.equal(W.inFolder('/p/shop/src/a.js', '/p/shop'), 'src/a.js');
  assert.equal(W.inFolder('/elsewhere/a.js', '/p/shop'), '/elsewhere/a.js');
  assert.equal(W.limitsLine({ five_hour: { percent: 42.4 }, seven_day: { percent: 10 }, other: { status: 'allowed' } }), '5 h 42% · week 10%');
  assert.equal(W.contextPercent({ contextUsed: 50_000, contextWindow: 200_000 }), 25);
  assert.equal(W.contextPercent({ contextPercent: 41.6, contextUsed: 1, contextWindow: 2 }), 42);
  assert.equal(W.contextPercent({}), null);
  assert.equal(W.exitCode('Exit code 2\nls: cannot access'), 2);
  assert.equal(W.exitCode('all fine'), null);
  assert.equal(W.took(400), 'less than 1 s');
  assert.equal(W.took(65_000), '1 min 5 s');
  // A last newline ends the last line: one line, not two.
  assert.equal(W.lineCount('one\n'), 1);
  assert.equal(W.toolLine('Write', { file_path: '/p/a.txt', content: 'one\n' }).detail, 'a.txt · 1 line');
  // Never in the past before it ran: running, waiting for the OK, refused.
  assert.deepEqual(['running', 'asking', 'refused', 'done'].map((s) => W.toolLine('Write', { file_path: '/p/a.txt', content: 'x' }, s).verb), ['Writing', 'Wants to write', 'Not written', 'Wrote']);
  assert.deepEqual(['running', 'asking', 'done'].map((s) => W.toolLine('Bash', { command: 'sleep 8' }, s).verb), ['Running', 'Wants to run', 'Ran']);
  assert.equal(W.toolLine('ExitPlanMode', {}, 'running').verb, 'Has a plan');
  assert.equal(W.toolLine('AskUserQuestion', {}, 'running').verb, 'Asks you');
  // What "Allow in this chat" covers, in words (it may be a part of the command only).
  assert.equal(W.ruleWords('Bash(exit 2)'), 'the command “exit 2”');
  assert.equal(W.alwaysWords({ tool: 'Bash', input: { command: 'ls nosuchdir; exit 2' }, alwaysText: 'Bash(exit 2)' }), '“Allow in this chat” also lets Claude do this again in this chat without asking: the command “exit 2”. That is only part of this command.');
  assert.doesNotMatch(W.alwaysWords({ tool: 'Bash', input: { command: 'npm test' }, alwaysText: 'Bash(npm test)' }), /only part/, 'the whole command');
  assert.doesNotMatch(W.alwaysWords({ tool: 'Bash', input: { command: 'npm view x' }, alwaysText: 'Bash(npm view *)' }), /only part/, 'a prefix of a simple command');
  assert.equal(W.ruleWords('Bash(npm view *), WebFetch(domain:example.org)'), 'commands that start with “npm view”, pages on example.org');
  // The rule is the whole command, and the grant adds a folder or all edits too: not "only part" (one splitter for both).
  const chain = 'ls src; touch made2.txt';
  for (const more of [', the folder /w/p, all edits', ', all edits', ', the folder /w/p', ', Read(//w/p/**)', '']) {
    const w = W.alwaysWords({ tool: 'Bash', input: { command: chain }, alwaysText: `Bash(${chain})${more}` });
    assert.doesNotMatch(w, /only part/, more);
    assert.match(w, /without asking: the command “ls src; touch made2.txt”/, more);
  }
  assert.equal(W.ruleWords(`Bash(${chain}), all edits`), 'the command “ls src; touch made2.txt”, every edit of a file');
  assert.equal(W.ruleWords('all edits, the folder /w/a, b, Bash(echo a, b)'), 'every edit of a file, the folder /w/a, b, the command “echo a, b”', 'a comma inside a rule or a path stays');
  assert.match(W.alwaysWords({ tool: 'Bash', input: { command: 'ls x; exit 2' }, alwaysText: 'Bash(exit 2), the folder /w/p, all edits' }), /That is only part of this command\.$/, 'a rule for one part, with a folder and all edits');
  assert.equal(W.turnRuns({ working: true, turn: false }), false, 'background work alone is no turn (no Stop, no queue)');
  assert.equal(W.turnRuns({ working: true }), true, 'an older computer says only "working"');
  assert.equal(W.turnLine({ turnCostUsd: 0.02, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 1200 }), '$0.02 · 1 s', 'a turn that used no tokens (a compact) says no "0 tokens"');
  assert.equal(W.toolLine('Bash', { command: 'sleep 9', run_in_background: true }).verb, 'Started');
  assert.equal(W.toolLine('Agent', { description: 'x', run_in_background: true }).verb, 'Started a background agent');
});

test('the diff: the longest common lines, hunks with old and new numbers, context around each change', () => {
  assert.deepEqual(D.diffLines('a\nb\nc', 'a\nB\nc\nd'), [[' ', 'a'], ['-', 'b'], ['+', 'B'], [' ', 'c'], ['+', 'd']]);
  // Unlike the plain prefix/suffix diff, a line moved past an insertion stays context.
  const rows = D.diffLines('x\n1\n2\n3\ny', 'x\nnew\n1\n2\n3\ny');
  assert.deepEqual(rows.filter((r) => r[0] !== ' '), [['+', 'new']]);
  const before = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n');
  const after = before.replace('l5', 'L5').replace('l25', 'L25');
  const hunks = D.hunksOf(before, after);
  assert.equal(hunks.length, 2); // two changes far apart: two hunks
  assert.deepEqual([hunks[0].oldStart, hunks[0].newStart, hunks[0].oldLines, hunks[0].newLines], [2, 2, 7, 7]);
  assert.deepEqual(hunks[0].lines, [' l2', ' l3', ' l4', '-l5', '+L5', ' l6', ' l7', ' l8']);
  assert.deepEqual(D.hunkCounts(hunks), { added: 2, removed: 2 });
  assert.deepEqual(D.hunksOf('same', 'same'), []);
  // The view: numbers per side, a sign (and words for a screen reader) per changed line, all text as text.
  const view = D.diffView([{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [' keep', '-<b>old</b>', '+new'] }]);
  const t = texts(view);
  assert.ok(t.includes('Line 10'), 'a hunk past the start says where it is');
  assert.ok(t.includes('<b>old</b>'), 'set as text, never as HTML');
  const rowsEl = byClass(view, 'cd-row');
  assert.deepEqual(rowsEl.map((r) => r.children.map((c) => texts(c).join('')).join('|')), ['10|10| |keep', '11||−|<b>old</b>', '|11|+|new']);
  assert.equal(byClass(rowsEl[1], 'cd-m')[0].attrs['aria-label'], 'removed');
  // A long diff shows its first rows and a "Show all".
  const long = D.diffView([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 300, lines: Array.from({ length: 300 }, (_, i) => `+${i}`) }]);
  assert.equal(byClass(long, 'cd-row').length, 80);
  assert.match(texts(byClass(long, 'chat-showall')[0]).join(''), /Show all 300 lines/);
});

test('agents: the strip counts what runs, a task line names its model and effort, a workflow its phases', () => {
  const tasks = [
    { taskId: 'a', type: 'agent', status: 'running', title: 'Find tests', now: 'Reading src', model: 'sonnet', effort: 'low', usage: { tools: 3, tokens: 12_300, ms: 41_000 } },
    { taskId: 'b', type: 'shell', status: 'running', background: true, title: 'npm test' },
    { taskId: 'c', type: 'agent', status: 'completed', title: 'done one', summary: 'its whole report …' },
  ];
  assert.equal(Ag.runningWords(tasks), '1 agent · 1 shell running');
  assert.equal(Ag.runningWords([tasks[2]]), '');
  assert.equal(Ag.taskLine(tasks[0]), 'running · Reading src · Sonnet · effort low · 3 tools · 12k tokens · 41 s');
  assert.equal(Ag.taskLine(tasks[2]), 'done', 'an ended task does not repeat its report');
  const wf = Ag.workflowView({ phases: [{ index: 0, title: 'Ask' }], agents: [{ phase: 0, label: 'one', state: 'done', model: 'claude-sonnet-5-5', tokens: 6500 }, { phase: 3, label: 'stray', state: 'running' }] });
  const t = texts(wf);
  assert.ok(t.includes('Ask') && t.includes('one') && t.includes('Other') && t.includes('stray'));
  assert.ok(t.some((x) => /done · sonnet-5-5 · 6\.5k tokens/.test(x)));
});

test('status line: what Claude does now (the tool that runs, for how long), then branch, cost, context and the plan limits', () => {
  const base = { status: 'working', turn: true, model: null, liveModel: 'claude-opus-5-5', effort: 'high', permissionMode: 'bypassPermissions', liveMode: null, costTotal: 0.5, usage: { contextUsed: 20_000, contextWindow: 200_000 }, limits: { five_hour: { percent: 63 } }, tasks: [], live: [], branch: 'main' };
  assert.equal(St.stateWords(base), 'Working…');
  assert.equal(St.stateWords({ ...base, activity: 'compacting' }), 'Compacting the conversation…');
  assert.equal(St.stateWords({ ...base, activity: 'requesting' }), 'Claude is thinking…');
  // A tool that runs comes first, even where "requesting" was left set: its command and its seconds.
  const runAt = Date.now() - 4200;
  assert.equal(St.stateWords({ ...base, activity: 'requesting', live: [{ kind: 'tool', written: true, title: 'mock bash', command: 'sleep 6', runAt }] }), 'Running: sleep 6 · 4 s');
  assert.equal(St.stateWords({ ...base, live: [{ kind: 'tool', written: true, title: 'npm test', runAt, agent: 'x' }] }), 'Working…', 'a subagent\'s tool is in its card');
  assert.equal(St.stateWords({ ...base, live: [{ kind: 'text', text: 'Hel' }] }), 'Claude is writing…');
  assert.equal(St.stateWords({ ...base, turn: false, tasks: [{ status: 'running', background: true }] }), 'Working in the background: 1 task');
  assert.equal(St.stateWords({ ...base, status: 'attention' }), 'Needs your OK');
  assert.equal(St.stateWords({ ...base, status: 'attention', asking: 'question' }), 'Claude asks you a question');
  assert.equal(St.stateWords({ ...base, status: 'waiting', terminal: { name: 'x' } }), 'Runs in a terminal');
  // The dot: the limit's colour at the limit, never Ready's green.
  assert.equal(St.statusKey({ status: 'waiting', lastEnd: 'limit' }), 'limit');
  assert.equal(St.statusKey({ status: 'waiting', limit: { at: 1 } }), 'limit');
  assert.equal(St.statusKey({ status: 'waiting', lastEnd: 'ok' }), 'waiting');
  assert.equal(St.statusKey({ status: 'waiting', lastEnd: 'stopped' }), 'stopped');
  assert.equal(St.statusKey({ status: 'waiting', lastError: 'boom', lastEnd: 'error' }), 'error');
  assert.equal(St.statusKey({ status: 'working', lastEnd: 'limit' }), 'working');
  assert.equal(St.statusKey({ status: 'waiting', terminal: { name: 'x' } }), 'terminal');
  assert.equal(St.statusKey({ status: 'waiting', toolOff: 'OpenCode is off on this computer.' }), 'stopped');
  assert.equal(St.stateWords({ ...base, status: 'waiting', lastEnd: 'stopped' }), 'Stopped', 'the owner\'s Stop is no error');
  assert.equal(St.stateWords({ ...base, status: 'waiting', lastEnd: 'limit', limit: { text: 'x' } }), 'Stopped at the usage limit');
  assert.equal(St.stateWords({ ...base, status: 'waiting', lastEnd: 'error', lastError: 'boom' }), 'Stopped with an error');
  // The model, effort and mode are the chips right above: not said twice.
  assert.deepEqual(St.statusParts(base).map((x) => x[1]), ['main', '$0.50 so far', 'context 10%', '5 h 63%']);
  // The plan's limits are a Claude subscription's: a chat on a gateway, an API key or Auto mode shows none.
  assert.deepEqual(St.statusParts({ ...base, profile: { name: 'sub', kind: 'subscription' } }).map((x) => x[0]), ['Git branch', 'Cost so far', 'Context', 'Plan limits']);
  for (const kind of ['api', 'auto']) assert.ok(!St.statusParts({ ...base, profile: { name: 'x', kind } }).some((x) => x[0] === 'Plan limits'), kind);
});

test('the limit card: its actions are a list, so another part adds one line; none while a terminal runs it', () => {
  const v = { limit: { text: 'You\'ve hit your usage limit' }, profile: { label: 'Max' }, limits: { five_hour: { status: 'rejected', resetsAt: Date.now() + 2 * 3600_000 } } };
  let moved = 0;
  const card = L.limitCard(v, { moveProvider: () => moved++ });
  assert.match(texts(card).join(''), /Max cannot answer now: You've hit your usage limit It is free again in (1 h 59|2 h 0) min\./);
  assert.deepEqual(byClass(card, 'btn').map((b) => texts(b).join('')), ['Move to another provider']);
  byClass(card, 'btn')[0].listeners.click();
  assert.equal(moved, 1);
  L.LIMIT_ACTIONS.push((ctx) => (ctx.v.profile ? { label: 'Sign in with another account', icon: 'user', run: () => {} } : null));
  try {
    assert.deepEqual(byClass(L.limitCard(v, { moveProvider() {} }), 'btn').map((b) => texts(b).join('')), ['Move to another provider', 'Sign in with another account']);
  } finally {
    L.LIMIT_ACTIONS.pop();
  }
  assert.doesNotMatch(texts(L.limitCard({ ...v, profile: { label: 'Gateway', kind: 'api' } }, { moveProvider() {} })).join(''), /free again/, 'no plan window on a gateway');
  assert.equal(L.limitCard({ ...v, terminal: { name: 'x' } }, {}), null);
  assert.equal(L.limitCard({ ...v, limit: null }, {}), null);
});

test('the limit card on Claude Code\'s stored sign-in: another Claude account, and going on once one signed in', async () => {
  const v = { limit: { text: 'You\'ve hit your 5-hour limit', at: 2000 }, profile: { name: 'sub', label: 'Claude Max', kind: 'login' } };
  const shown = (profiles) => {
    const card = L.limitCard(v, { id: '11111111-2222-4333-8444-555555555555', moveProvider() {}, profiles });
    return byClass(card, 'btn').map((b) => [/(^|\s)primary(\s|$)/.test(b.className), texts(b).join('')]);
  };
  const sub = { name: 'sub', label: 'Claude Max', kind: 'login', signedIn: true, accountAt: null };
  assert.deepEqual(shown([sub]), [[true, 'Move to another provider'], [false, 'Sign in with another Claude account']]);
  // another account signed in after the limit: going on here leads, the move steps back
  assert.deepEqual(shown([{ ...sub, accountAt: 3000 }]), [[true, 'Continue with the new account'], [false, 'Sign in with another Claude account'], [false, 'Move to another provider']]);
  // a provider with its own token or an API key has no stored sign-in to change
  assert.deepEqual(shown([{ ...sub, kind: 'subscription' }]), [[true, 'Move to another provider']]);
});

test('the provider sheet: each provider with its plan usage', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const { usageWords, editorLink } = await import('../../web/chat/header.js');
  assert.equal(usageWords({ usage: { fiveHour: { pct: 42.2 }, week: { pct: 9 } } }), '5-hour 42% · weekly 9%');
  assert.equal(usageWords({}), '');
  assert.equal(editorLink('/p/my shop', 'changes'), '#/code?dir=%2Fp%2Fmy%20shop&view=changes');
});

test('tool cards: a search, a web page and a skill say what they did; a stopped task shows it in words and by its icon', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const { toolCard } = await import('../../web/chat/tools.js');
  const card = (name, toolKind, input, result) => {
    const el = toolCard({ id: 't', name, toolKind, input }, { cwd: '/p' });
    if (result) el.result(result);
    return el;
  };
  const grep = card('Grep', 'search', { pattern: 'line t', path: '/p/src' }, { ok: true, text: 'notes.txt:2:line two' });
  assert.equal(grep.dataset.kind, 'search');
  assert.ok(grep.classList.contains('chat-is-ok'));
  assert.match(texts(grep).join(''), /^Searched forline tin src.*notes\.txt:2:line two/s);
  const web = card('WebFetch', 'web', { url: 'http://example.test/page', prompt: 'what' }, { ok: false, text: 'fetch failed' });
  assert.ok(web.classList.contains('chat-is-err'));
  assert.match(texts(web).join(''), /Read the pagehttp:\/\/example\.test\/pagefailed/);
  const skill = card('Skill', 'other', { skill: 'tidy-notes' }, { ok: true, text: 'Launching skill: tidy-notes' });
  assert.match(texts(skill).join(''), /^Used the skilltidy-notes/);
  // A background shell: the call started it (ok); it was stopped later, and a late result does not hide that.
  const bg = card('Bash', 'shell', { command: 'sleep 3', run_in_background: true });
  bg.task({ taskId: 'b1', type: 'shell', status: 'stopped', title: 'sleep 3' });
  bg.result({ ok: true, text: 'Command running in background with ID: b1' });
  assert.ok(bg.classList.contains('chat-is-taskstop'));
  assert.match(texts(bg).join(''), /stopped/);
});

test('tool cards: never in the past before they ran; Stop and a no are the owner\'s act, in grey, with no words written for Claude', async () => {
  const { toolCard } = await import('../../web/chat/tools.js');
  const w = toolCard({ id: 'w', name: 'Write', toolKind: 'edit', input: { file_path: '/p/made.txt', content: 'x\n' } }, { cwd: '/p' });
  assert.match(texts(w).join(''), /^Writingmade\.txt\+1/);
  w.quiet(); // its OK card opened below
  assert.match(texts(w).join(''), /^Wants to writemade\.txt/);
  w.answered(false);
  w.result({ ok: false, denied: true, text: 'Use notes.txt instead' });
  const said = texts(w).join('');
  assert.match(said, /^Not writtenmade\.txt/);
  assert.doesNotMatch(said, /\+1|−0/, 'nothing was written: no counts');
  assert.match(said, /you said no.*Your reason: “Use notes\.txt instead”/s);
  assert.ok(w.classList.contains('chat-is-stopped') && !w.classList.contains('chat-is-err'), 'grey, not a failure');
  const b = toolCard({ id: 'b', name: 'Bash', toolKind: 'shell', input: { command: 'sleep 20' } }, { cwd: '/p' });
  assert.match(texts(b).join(''), /^Runningsleep 20/);
  assert.doesNotMatch(texts(b).join(''), /\$ sleep 20/, 'a short command is said once, in the head');
  b.result({ ok: false, stopped: true, text: '' });
  assert.match(texts(b).join(''), /^Ransleep 20stopped by you/);
  assert.ok(b.classList.contains('chat-is-stopped'));
  const long = toolCard({ id: 'l', name: 'Bash', toolKind: 'shell', input: { command: 'cd sub &&\nnpm test' } }, { cwd: '/p' });
  assert.match(texts(long).join(''), /\$ cd sub &&\nnpm test/, 'a command of several lines is shown whole');
});

test('tool cards: Stop while the OK card is open is never said in the past, and has no counts', async () => {
  const { toolCard } = await import('../../web/chat/tools.js');
  assert.equal(W.toolLine('Write', { file_path: '/p/a.txt', content: 'x' }, 'stopped').verb, 'Did not write');
  assert.equal(W.toolLine('Bash', { command: 'ls' }, 'stopped').verb, 'Did not run');
  assert.equal(W.toolLine('AskUserQuestion', {}, 'stopped').verb, 'Not answered', 'a verb without "Wants to" says it as refused');
  const w = toolCard({ id: 'w', name: 'Write', toolKind: 'edit', input: { file_path: '/p/out.txt', content: 'x\n' } }, { cwd: '/p' });
  w.quiet(); // its OK card opened
  w.result({ ok: false, stopped: true, text: '' }); // Stop: the card was cancelled ("No longer waiting"), nothing written
  const said = texts(w).join('');
  assert.match(said, /^Did not writeout\.txtstopped by you/);
  assert.doesNotMatch(said, /Wrote|\+1|−0/);
  // An edit read back without its OK card (a reload after a restart): one step, stopped means not written.
  const e = toolCard({ id: 'e', name: 'Edit', toolKind: 'edit', input: { file_path: '/p/a.js', old_string: 'a', new_string: 'b' } }, { cwd: '/p' });
  e.result({ ok: false, stopped: true, text: '' });
  assert.match(texts(e).join(''), /^Did not changea\.jsstopped by you$/);
  // A command that ran until Stop ran.
  const b = toolCard({ id: 'b', name: 'Bash', toolKind: 'shell', input: { command: 'sleep 20' } }, { cwd: '/p' });
  b.result({ ok: false, stopped: true, text: '' });
  assert.match(texts(b).join(''), /^Ransleep 20stopped by you/);
});

test('a failed action says the dashboard\'s sentence, never a script\'s own message', async () => {
  const { ApiError } = await import('../../web/lib.js');
  assert.equal(W.failText(new ApiError('This chat is not open', 404)), 'This chat is not open');
  assert.equal(W.failText(new TypeError("Cannot read properties of null (reading 'cwd')")), 'That did not work. Reload the page and try again.');
  assert.equal(W.failText(null), 'That did not work. Reload the page and try again.');
});

test('one money formatter: a cent that a sum of floats made 0.0099999 reads $0.01', () => {
  assert.equal(W.money(0.03 - 0.02), '$0.01');
  assert.equal(W.money(0.01), '$0.01');
  assert.equal(W.money(1.234), '$1.23');
  assert.equal(W.money(0.0042), '$0.0042', 'below a cent: four places');
  assert.equal(W.money(0), '$0');
  assert.match(W.turnLine({ ok: true, turnCostUsd: 0.03 - 0.02, usage: { input: 10, output: 5 } }), /^\$0\.01 · /);
});

test('tool cards: an error Claude Code wraps in tool_use_error shows only its words', async () => {
  const { toolCard } = await import('../../web/chat/tools.js');
  const el = toolCard({ id: 't', name: 'Grep', toolKind: 'search', input: { pattern: 'x' } });
  el.result({ ok: false, text: '<tool_use_error>Error: No such tool available: Grep.</tool_use_error>' });
  const all = texts(el).join('');
  assert.match(all, /Error: No such tool available: Grep\./);
  assert.doesNotMatch(all, /tool_use_error/);
});

test('the composer\'s menus: "/" at the start of the box, "@" anywhere, filtered as you type', async () => {
  const { menuAt, filterCommands, toolCommands, mention } = await import('../../web/chat/popovers.js');
  assert.deepEqual(menuAt('/', 1), { type: '/', q: '', from: 0 });
  assert.deepEqual(menuAt('/comp', 5), { type: '/', q: 'comp', from: 0 });
  assert.equal(menuAt('/compact now', 12), null, 'a command with its argument typed: the menu is gone');
  assert.equal(menuAt('see a/b', 7), null, 'a slash inside the text is no command');
  assert.deepEqual(menuAt('look at @src/th', 15), { type: '@', q: 'src/th', from: 8 });
  assert.deepEqual(menuAt('@', 1), { type: '@', q: '', from: 0 });
  assert.equal(menuAt('mail me@example', 15), null, 'an @ inside a word is no file');
  assert.equal(menuAt('look at @src/a.js and', 21), null);
  const list = [{ name: 'review', description: 'Review the changes' }, { name: 'compact', description: 'Summary' }, { name: 'security-review', description: 'Check' }, { name: 'init', description: 'Write a review file' }];
  assert.deepEqual(filterCommands(list, 'rev').map((c) => c.name), ['review', 'security-review', 'init'], 'the name first, then the words');
  assert.deepEqual(filterCommands(list, 'comp').map((c) => c.name), ['compact']);
  assert.deepEqual(filterCommands(list, 'wr').map((c) => c.name), [], 'two letters look at the names only');
  assert.equal(filterCommands(list, '').length, 4);
  const tool = toolCommands([{ name: 'clear', builtin: true }, { name: 'compact', builtin: true }, { name: 'cost', description: 'Show the cost', builtin: true }, { name: 'tidy-notes', description: 'Tidy', argumentHint: '[file]', builtin: false }, { name: '' }, null]);
  assert.deepEqual(tool, [{ name: 'cost', description: 'Show the cost', hint: '', skill: false }, { name: 'tidy-notes', description: 'Tidy', hint: '[file]', skill: true }], 'what the page does itself is left out');
  assert.equal(mention('src/a.js'), '@src/a.js ');
  assert.equal(mention('docs/my notes.md'), '@"docs/my notes.md" ', 'Claude Code reads a quoted path');
});

test('Up and Down in an empty box go through the messages sent from this chat', async () => {
  const { recall, SHORTCUTS } = await import('../../web/chat/keys.js');
  let kept = ['first'];
  const r = recall({ get: () => kept, set: (l) => (kept = l) });
  r.push('second');
  r.push('third');
  assert.deepEqual(kept, ['first', 'second', 'third']);
  assert.equal(r.up(''), 'third');
  assert.equal(r.up('third'), 'second');
  assert.equal(r.up('second'), 'first');
  assert.equal(r.up('first'), null, 'nothing older');
  assert.equal(r.down('first'), 'second');
  assert.equal(r.down('second'), 'third');
  assert.equal(r.down('third'), '', 'past the newest: the empty box again');
  assert.equal(r.up('something typed'), null, 'text of its own is never replaced');
  r.push('first');
  assert.deepEqual(kept, ['second', 'third', 'first'], 'sent again: it moves to the end, once');
  for (const k of ['Esc', 'Shift+Tab', '/', '@']) assert.ok(SHORTCUTS.some(([key]) => key === k), k);
});

test('a command Claude Code answered by itself has no cost line; a message\'s picture is a thumbnail of this chat', async () => {
  assert.equal(W.turnLine({ ok: true, turnCostUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 18 }), '');
  assert.match(W.turnLine({ ok: true, turnCostUsd: 0.01, usage: { input: 10, output: 2 }, durationMs: 1000 }), /^\$0\.01/);
  const { messageFiles } = await import('../../web/chat/attach.js');
  assert.equal(messageFiles([], '/api/chats/x'), null);
  const box = messageFiles([{ type: 'image', name: 'shot 1.png', mime: 'image/png' }, { type: 'file', name: 'b.log' }, { type: 'image', name: '' }], '/api/chats/x');
  const img = byClass(box, 'chat-thumb')[0];
  assert.ok(img, 'a picture with a name is drawn');
  assert.equal(img.getAttribute('src'), '/api/chats/x/attachment?name=shot%201.png');
  assert.equal(img.getAttribute('alt'), 'Picture shot 1.png');
  assert.deepEqual(texts(box).filter(Boolean), ['b.log', 'picture'], 'a file, and a picture without a name, as chips');
});

test('Home\'s card of a chat that waits for an OK: Allow, Allow in this chat and Do not allow; a question leads into the chat', async () => {
  const { permissionActions } = await import('../../web/lib.js');
  const s = { kind: 'chat', name: 'chat:c1', chatId: '11111111-2222-4333-8444-555555555555', machine: null, status: 'attention', ask: { request: 'r1', type: 'permission', canAlways: true, alwaysText: 'Bash(npm test:*)' } };
  const words = (n) => byClass(n, 'btn').map((b) => texts(b).join(''));
  assert.deepEqual(words(permissionActions(s)), ['Allow', 'Allow in this chat', 'Do not allow']);
  assert.deepEqual(words(permissionActions({ ...s, ask: { ...s.ask, canAlways: false } })), ['Allow', 'Do not allow']);
  const q = permissionActions({ ...s, ask: { request: 'r2', type: 'question' } });
  assert.deepEqual(words(q), ['Answer']);
  assert.equal(byClass(q, 'btn')[0].attrs.href || byClass(q, 'btn')[0].href, '#/chat/11111111-2222-4333-8444-555555555555');
  assert.deepEqual(words(permissionActions({ ...s, ask: { request: 'r3', type: 'plan' } })), ['Read the plan']);
  assert.equal(permissionActions({ ...s, status: 'waiting' }), null, 'nothing waits');
  assert.equal(permissionActions({ ...s, ask: null }), null, 'an older computer that does not say what it waits for');
});

test('the chat\'s toasts sit under its head at every width: no rule gives their box a bottom edge as well', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/chat/chat.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/body\.chat-mode \.toasts\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rules.length >= 1, 'a rule places them');
  // A top and a bottom together stretch the box between them, and a toast in it draws as a tall block.
  for (const r of rules) assert.match(r, /bottom:\s*auto/, r);
});
