// The chat page's conversation (web/chat/timeline.js, tools.js), without a browser: the tool cards' words, an answered
// OK folded into its card, the transcript views, the blocks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

const W = await import('../../web/chat/words.js');

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

test('tool cards: an error Claude Code wraps in tool_use_error shows only its words', async () => {
  const { toolCard } = await import('../../web/chat/tools.js');
  const el = toolCard({ id: 't', name: 'Grep', toolKind: 'search', input: { pattern: 'x' } });
  el.result({ ok: false, text: '<tool_use_error>Error: No such tool available: Grep.</tool_use_error>' });
  const all = texts(el).join('');
  assert.match(all, /Error: No such tool available: Grep\./);
  assert.doesNotMatch(all, /tool_use_error/);
});

test('tool cards: a change of a file that failed (a rule refused it) is never said as written, and has no counts', async () => {
  const { toolCard } = await import('../../web/chat/tools.js');
  assert.equal(W.toolLine('Write', { file_path: '/p/a.txt', content: 'x' }, 'failed').verb, 'Could not write');
  assert.equal(W.toolLine('Edit', { file_path: '/p/a.js', old_string: 'a', new_string: 'b' }, 'failed').verb, 'Could not change');
  const w = toolCard({ id: 'w', name: 'Write', toolKind: 'edit', input: { file_path: '/p/secret.txt', content: 'x\n' } }, { cwd: '/p' });
  w.result({ ok: false, text: '<tool_use_error>Permission to write secret.txt was denied by a rule</tool_use_error>' });
  const said = texts(w).join('|');
  assert.match(said, /^Could not write\|secret\.txt/);
  assert.doesNotMatch(said, /Wrote|failed|\+1|−0/, 'not "Wrote secret.txt failed +1 −0"');
  assert.match(said, /denied by a rule/, 'why, in its words');
  assert.ok(w.classList.contains('chat-is-err'));
  // A command that failed did run: "Ran … failed · exit 2" stays.
  const b = toolCard({ id: 'b', name: 'Bash', toolKind: 'shell', input: { command: 'ls x' } }, { cwd: '/p' });
  b.result({ ok: false, text: 'Exit code 2\nls: x: No such file' });
  assert.match(texts(b).join('|'), /^Ran\|ls x\|failed · exit 2/);
});

test('an answered OK folds into the tool card it was about: the step is said once', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.requestAnimationFrame ||= () => 0;
  const { createTimeline } = await import('../../web/chat/timeline.js');
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  const cmd = { kind: 'tool', id: 't1', name: 'Bash', toolKind: 'shell', input: { command: 'npm test' } };
  const ask = { kind: 'ask', request: 'r1', type: 'permission', tool: 'Bash', toolId: 't1', input: { command: 'npm test' } };
  tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, cmd, ask], next: 3 });
  const okCard = tl.asks.get('r1');
  const tool = byClass(tl.el, 'chat-tool')[0];
  assert.match(texts(tool).join('|'), /^Wants to run\|npm test/);
  tl.apply({ events: [{ kind: 'ask-closed', request: 'r1', outcome: 'allowed' }, { kind: 'tool-result', id: 't1', ok: true, text: 'ok' }] });
  assert.ok(okCard.done, 'the OK card is done (and gone from the list)');
  assert.doesNotMatch(texts(okCard).join('|'), /You allowed this/, 'no second card that says it again');
  assert.match(texts(tool).join('|'), /^Ran\|npm test\|allowed by you/);
  // "In this session", and a no: said on the tool card too.
  tl.apply({ events: [{ ...cmd, id: 't2' }, { ...ask, request: 'r2', toolId: 't2' }, { kind: 'ask-closed', request: 'r2', outcome: 'allowed-always' }] });
  assert.match(texts(byClass(tl.el, 'chat-tool')[1]).join('|'), /allowed for this session/);
  tl.apply({ events: [{ ...cmd, id: 't3' }, { ...ask, request: 'r3', toolId: 't3' }, { kind: 'ask-closed', request: 'r3', outcome: 'denied' }] });
  assert.match(texts(byClass(tl.el, 'chat-tool')[2]).join('|'), /^Not run\|npm test\|you said no/);
  // One no longer waited for (Stop) stays a closed card in place: its tool card may never get a result.
  tl.apply({ events: [{ ...cmd, id: 't4' }, { ...ask, request: 'r4', toolId: 't4' }, { kind: 'ask-closed', request: 'r4', outcome: 'cancelled' }] });
  assert.match(texts(tl.asks.get('r4')).join('|'), /No longer waiting/);
});

test('the transcript view: Normal folds calls and hides thinking, Verbose opens everything with each turn\'s line; remembered', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.requestAnimationFrame ||= () => 0;
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, x) => kept.set(k, String(x)) };
  assert.deepEqual(W.VIEWS.map((x) => x.label), ['Normal', 'Thinking', 'Verbose'], 'the desktop app\'s words');
  assert.deepEqual(W.viewChoices('normal', false).map((x) => x.id), ['normal', 'verbose'], 'Thinking once there is thinking');
  assert.deepEqual(W.viewChoices('normal', true).map((x) => x.id), ['normal', 'thinking', 'verbose']);
  const { toolCard } = await import('../../web/chat/tools.js');
  const edit = { id: 'e', name: 'Edit', toolKind: 'edit', input: { file_path: '/p/a.js', old_string: 'a', new_string: 'b' } };
  assert.equal(toolCard(edit, { cwd: '/p', view: () => 'normal' }).open, false, 'Normal: collapsed into its summary');
  assert.equal(toolCard(edit, { cwd: '/p', view: () => 'verbose' }).open, true);
  assert.equal(toolCard({ ...edit, name: 'Read', toolKind: 'read', input: { file_path: '/p/a.js' } }, { cwd: '/p', view: () => 'verbose' }).open, true, 'every call, a read too');
  assert.equal(toolCard(edit, { cwd: '/p' }).open, true, 'an older caller without a view: as before');

  const { createTimeline } = await import('../../web/chat/timeline.js');
  const scroll = document.createElement('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  assert.equal(tl.view(), 'normal', 'the default');
  assert.equal(tl.el.dataset.view, 'normal');
  tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, { kind: 'thinking', blockId: 'b1', text: 'hmm', i: 1 }, { ...edit, kind: 'tool', i: 2 }, { kind: 'turn-end', ok: true, turnCostUsd: 0.04, usage: { input: 19000, output: 140 }, durationMs: 9000, i: 3 }], next: 4 });
  assert.equal(tl.thought(), true);
  const card = byClass(tl.el, 'chat-tool')[0];
  assert.equal(card.open, false);
  const line = byClass(tl.el, 'chat-turnend')[0];
  assert.deepEqual(texts(byClass(line, 'chat-money')[0]), ['$0.04 · '], 'the dollars apart: shown only where billed');
  assert.match(texts(line).join(''), /19k tokens in · 140 out · 9 s/);
  tl.setView('verbose');
  assert.equal(tl.el.dataset.view, 'verbose');
  assert.equal(card.open, true, 'every call opens');
  assert.equal(kept.get('chat.view'), 'verbose', 'remembered in this browser');
  const again = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  assert.equal(again.view(), 'verbose', 'every session opens in it');
  tl.setView('everything');
  assert.equal(tl.view(), 'verbose', 'an unknown view changes nothing');
  tl.billed(true);
  assert.equal(tl.el.dataset.billed, '1');
  tl.billed(false);
  assert.equal(tl.el.dataset.billed, undefined);
  // Billed by use: an API key or a gateway; a subscription, a sign-in, Auto mode or a provider not known: no dollars.
  assert.deepEqual(['api', 'openai', 'subscription', 'login', 'auto', 'unknown', undefined].map((kind) => W.billed({ profile: { kind } })), [true, true, false, false, false, false, false]);
  assert.equal(W.billed({}), false);
  delete globalThis.localStorage;
});

test('a block id that comes again with another kind is another block: thinking is never overwritten by text', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.requestAnimationFrame ||= () => 0;
  const { createTimeline } = await import('../../web/chat/timeline.js');
  const scroll = document.createElement('div');
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  tl.apply({ reset: true, events: [{ kind: 'user', text: 'a', i: 0 }, { kind: 'thinking', blockId: 'm1:0', text: 'hmm', i: 1 }, { kind: 'user', text: 'b', i: 2 }, { kind: 'text', blockId: 'm1:0', text: 'Done.', i: 3 }], next: 4 });
  assert.equal(byClass(tl.el, 'chat-think').length, 1);
  assert.match(texts(byClass(tl.el, 'chat-think')[0]).join('|'), /hmm/, 'the thinking keeps its own text');
  assert.equal(byClass(tl.el, 'chat-text').length, 1, 'the text is a block of its own');
});

test('the Thinking view opens the thinking, also of blocks drawn while it is on; Normal folds it again', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.requestAnimationFrame ||= () => 0;
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, x) => kept.set(k, String(x)) };
  try {
    const { createTimeline } = await import('../../web/chat/timeline.js');
    const scroll = document.createElement('div');
    const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
    tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, { kind: 'thinking', blockId: 'b1', text: 'hmm', i: 1 }], next: 2 });
    const first = byClass(tl.el, 'chat-think')[0];
    assert.equal(first.open, false, 'Normal');
    tl.setView('thinking');
    assert.equal(first.open, true, 'Thinking: "plus Claude\'s thinking", so it shows');
    tl.apply({ events: [{ kind: 'thinking', blockId: 'b2', text: 'more', i: 2 }] });
    assert.equal(byClass(tl.el, 'chat-think')[1].open, true, 'a block drawn while the view is on');
    tl.setView('normal');
    assert.equal(first.open, false);
  } finally {
    delete globalThis.localStorage;
  }
});

test('the Transcript view\'s choices name the session\'s own coding tool, never Claude in an OpenCode session', () => {
  const subs = (who) => W.viewChoices('normal', true, who).map((x) => x.sub).join(' | ');
  assert.match(subs('OpenCode'), /plus OpenCode's thinking/);
  assert.doesNotMatch(subs('OpenCode'), /Claude/);
  assert.match(subs('Claude'), /plus Claude's thinking/);
  assert.match(subs(), /plus Claude's thinking/, 'Claude Code by default');
});

test('an OK cancelled by Stop is said once, by its tool card ("stopped by you"), whichever comes first', async () => {
  globalThis.requestAnimationFrame ||= () => 0;
  const { createTimeline } = await import('../../web/chat/timeline.js');
  const scroll = document.createElement('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  const write = (id) => ({ kind: 'tool', id, name: 'Write', toolKind: 'edit', input: { file_path: '/p/other.md', content: 'x\n' } });
  const ask = (r, id) => ({ kind: 'ask', request: r, type: 'permission', tool: 'Write', toolId: id, input: { file_path: '/p/other.md', content: 'x\n' } });
  const gone = new Set();
  const watch = (r) => {
    const card = tl.asks.get(r);
    card.remove = () => gone.add(r);
    return card;
  };
  tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, write('t1'), ask('r1', 't1')], next: 3 });
  watch('r1');
  // The tool's end first, then the card's.
  tl.apply({ events: [{ kind: 'tool-result', id: 't1', ok: false, stopped: true, text: '' }, { kind: 'ask-closed', request: 'r1', outcome: 'cancelled' }] });
  assert.ok(gone.has('r1'), 'no second "No longer waiting" card');
  assert.match(texts(byClass(tl.el, 'chat-tool')[0]).join('|'), /^Did not write\|other\.md.*stopped by you/);
  // The card's end first: it says so for now, and goes once the tool card says it.
  tl.apply({ events: [write('t2'), ask('r2', 't2')] });
  watch('r2');
  tl.apply({ events: [{ kind: 'ask-closed', request: 'r2', outcome: 'cancelled' }] });
  assert.ok(!gone.has('r2'));
  tl.apply({ events: [{ kind: 'tool-result', id: 't2', ok: false, stopped: true, text: '' }] });
  assert.ok(gone.has('r2'));
  // Closed by the state (no longer pending), its tool card already ended: the same.
  tl.apply({ events: [write('t3'), ask('r3', 't3')] });
  watch('r3');
  tl.apply({ events: [{ kind: 'tool-result', id: 't3', ok: false, stopped: true, text: '' }] });
  tl.pending([]);
  assert.ok(gone.has('r3'));
});

test('a plan that waits when the page opens is drawn with the chat\'s modes: the first look draws its events before its state', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.requestAnimationFrame ||= () => 0;
  const { PERMISSION_MODES } = await import('../../src/config.mjs');
  const { createTimeline } = await import('../../web/chat/timeline.js');
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  // As page.js does it: the events of the look first (with what the answer says before its state), then the state.
  const look = (autoMode) => ({
    reset: true, next: 2, epoch: 1, engine: { id: 'claude' }, choices: { modes: PERMISSION_MODES }, autoMode,
    events: [{ kind: 'user', text: 'plan it', i: 0 }, { kind: 'ask', request: 'r1', type: 'plan', tool: 'ExitPlanMode', input: { plan: 'Do it' }, plan: 'Do it', i: 1 }],
  });
  for (const [autoMode, first] of [[false, 'Yes, auto-accept edits'], [true, 'Yes, and use auto mode']]) {
    let v = null;
    const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude', modes: () => W.planModes(v) });
    const r = look(autoMode);
    v = W.beforeState(v, r);
    tl.apply(r);
    assert.match(texts(tl.asks.get('r1')).join('|'), new RegExp(`1\\|${first}\\|2\\|Yes, manually approve edits`), `autoMode ${autoMode}`);
  }
  assert.equal(W.beforeState(null, { events: [] }), null, 'an answer without them (an older computer) changes nothing');
  const known = { engine: { id: 'opencode' }, choices: { modes: ['manual'] }, autoMode: false };
  assert.equal(W.beforeState(known, look(true)), known, 'the state the page has wins over the look\'s');
});

test('a part\'s card answered by keyboard: its buttons go, and the focus moves to the line that says what happened', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.requestAnimationFrame ||= () => 0;
  const { createTimeline } = await import('../../web/chat/timeline.js');
  const scroll = document.createElement('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  document.body.append(tl.el);
  try {
    tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, { kind: 'part-ask', part: 'p_0123456789', provider: 'paid', label: 'Example API key', partKind: 'running and recording', brief: 'list the TODOs', i: 1 }], next: 2 });
    const card = byClass(tl.el, 'chat-ask-part')[0];
    const no = card.querySelectorAll('button').find((b) => texts(b).join('') === 'No, the lead does it');
    no.focus();
    assert.equal(document.activeElement, no);
    // The press: a browser drops the focus of a button it disables, so it moves to the status line at once.
    const before = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (u, init = {}) => (sent.push([String(u), init.body]), { ok: true, status: 200, json: async () => ({ ok: true, started: false }) });
    try {
      no.listeners.click({ preventDefault() {} });
      assert.equal(document.activeElement, card.querySelector('.chat-ask-status'), 'the focus is on the status line from the press on');
      // An empty status line is not shown, and what is not shown cannot take the focus: it says what happens first.
      assert.match(texts(card.querySelector('.chat-ask-status')).join(''), /Telling the lead/);
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(sent, [['/api/parts/p_0123456789/answer', JSON.stringify({ allow: false })]]);
    } finally {
      globalThis.fetch = before;
    }
    tl.apply({ events: [{ kind: 'part-ask-closed', part: 'p_0123456789', outcome: 'no', i: 2 }], next: 3 });
    assert.equal(card.querySelectorAll('button').length, 0, 'its buttons are gone');
    const st = card.querySelector('.chat-ask-status');
    assert.match(texts(st).join(''), /You said no: the lead does this part itself/);
    assert.equal(document.activeElement, st, 'the focus is on what happened, not lost to the page');
  } finally {
    tl.el.remove();
  }
});

test('a turn the AI account refused: a plain line and a way on, the coding tool\'s own words folded', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.requestAnimationFrame ||= () => 0;
  assert.equal(W.turnErrorWords('Invalid API key · Please run /login').kind, 'auth');
  assert.equal(W.turnErrorWords('Your credit balance is too low to access the Anthropic API.').kind, 'billing');
  assert.equal(W.turnErrorWords('Something else broke'), null, 'an unknown error is shown as it is');
  assert.doesNotMatch(W.turnErrorWords('Invalid API key · Please run /login').line, /\/login|terminal/, 'no terminal step in the line');
  const { createTimeline } = await import('../../web/chat/timeline.js');
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude', provider: () => ({ profile: { name: 'main', kind: 'login' }, tool: 'claude' }) });
  tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, { kind: 'turn-end', ok: false, error: 'Invalid API key · Please run /login', i: 1 }], next: 2 });
  const banner = byClass(tl.el, 'error-box')[0];
  assert.match(texts(banner).join(''), /did not accept the sign-in/);
  assert.doesNotMatch(texts(banner).join(''), /\/login/, 'the tool\'s words are not the line');
  assert.match(texts(tl.el).join('|'), /Sign in again/);
  assert.match(texts(tl.el).join('|'), /Details\|Invalid API key · Please run \/login/, 'folded under Details');
  tl.apply({ events: [{ kind: 'user', text: 'again', i: 2 }, { kind: 'turn-end', ok: false, error: 'Something else broke', i: 3 }] });
  assert.match(texts(byClass(tl.el, 'error-box')[1]).join(''), /^Something else broke$/);
});

test('a refused sign-in uses the chat\'s word "provider" and offers what fixes it for that provider', async () => {
  for (const k of ['auth', 'billing']) {
    const line = W.turnErrorWords(k === 'auth' ? 'Invalid API key' : 'Your credit balance is too low').line;
    assert.match(line, /^This provider /, line);
    assert.doesNotMatch(line, /AI account|its provider/, line);
  }
  // Only the HTTP status is a sign-in error, not any 401 in a text.
  assert.equal(W.turnErrorWords('Wrote 401 lines to notes.md and then failed'), null);
  assert.equal(W.turnErrorWords('API Error: 401 Unauthorized').kind, 'auth');
  assert.equal(W.turnErrorWords('request failed with status 401').kind, 'auth');
  for (const t of ['Request failed with status code 401', 'HTTP 401: Unauthorized', 'statusCode: 401', 'HTTP/1.1 401', 'HTTP/2 401']) assert.equal((W.turnErrorWords(t) || {}).kind, 'auth', t);
  assert.equal(W.turnErrorWords('Listening on port 4010, HTTP 200'), null, 'another number near HTTP is not it');
  // Claude Code's own sign-in: signing in again fixes it. An API key, a gateway, OpenCode: the provider's page.
  assert.deepEqual(W.signInWay({ name: 'main', kind: 'login' }, 'claude'), { kind: 'claude-signin' });
  assert.deepEqual(W.signInWay({ name: 'work-key', kind: 'api' }, 'claude'), { kind: 'provider', hash: '#/providers/work-key' });
  assert.deepEqual(W.signInWay({ name: 'main', kind: 'login' }, 'opencode'), { kind: 'provider', hash: '#/providers/main' });
  assert.deepEqual(W.signInWay(null), { kind: 'provider', hash: '#/providers' });
  // The page's sign-in signs in this computer's default Claude folder only: not a provider with a folder of its own,
  // and not a chat on another computer (its Providers page, there, is the way).
  assert.deepEqual(W.signInWay({ name: 'second', kind: 'login', ownFolder: true }, 'claude'), { kind: 'provider', hash: '#/providers/second' });
  assert.deepEqual(W.signInWay({ name: 'main', kind: 'login' }, 'claude', { remote: true }), { kind: 'provider', hash: '#/providers/main' });
  const { createTimeline } = await import('../../web/chat/timeline.js');
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude', provider: () => ({ profile: { name: 'work-key', kind: 'api' }, tool: 'claude' }) });
  tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, { kind: 'turn-end', ok: false, error: 'Invalid API key · Please run /login', i: 1 }], next: 2 });
  assert.doesNotMatch(texts(tl.el).join('|'), /Sign in again/, 'a Claude sign-in does not fix an API key');
  const a = byClass(tl.el, 'btn').find((b) => b.tag === 'a');
  assert.ok(a, 'a link to the provider');
  assert.equal(a.attrs.href, '#/providers/work-key');
  assert.match(texts(a).join(''), /Open the provider/);
  // A chat on another computer, on its default Claude sign-in: the way is that computer's Providers, never this
  // computer's sign-in.
  const far = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude', provider: () => ({ profile: { name: 'main', kind: 'login' }, tool: 'claude', remote: true }) });
  far.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, { kind: 'turn-end', ok: false, error: 'Invalid API key · Please run /login', i: 1 }], next: 2 });
  assert.doesNotMatch(texts(far.el).join('|'), /Sign in again/);
  assert.ok(byClass(far.el, 'btn').some((b) => b.tag === 'a' && /#\/providers\/main$/.test(b.attrs.href)));
});
