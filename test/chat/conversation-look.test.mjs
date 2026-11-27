// The conversation's look and its small behaviours (web/chat/timeline.js, tools.js, asks.js, chat-cards.css, chat.css):
// one Copy under a turn, tool lines without a box, thinking in the same family, the permission card made neutral with
// Do not allow first and the wider allows in a menu, the to-do row, code on the well, the column and the gaps; the
// restart sentence only where a part was handed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.requestAnimationFrame ||= () => 0;
const given = [];
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => given.push(t) } }, configurable: true });
const { createTimeline } = await import('../../web/chat/timeline.js');
const { askCard } = await import('../../web/chat/asks.js');
const css = (f) => fs.readFileSync(new URL(`../../web/chat/${f}`, import.meta.url), 'utf8');
const rule = (src, sel) => {
  const i = src.indexOf(`\n${sel} {`);
  assert.ok(i >= 0, `a rule for ${sel}`);
  return src.slice(i, src.indexOf('}', i));
};

const draw = (events) => {
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  tl.apply({ reset: true, events: events.map((e, i) => ({ i, ...e })), next: events.length });
  return tl;
};

test('one Copy under the last reply of a turn, not one beside every block; it copies the turn\'s replies', async () => {
  given.length = 0;
  const tl = draw([
    { kind: 'user', text: 'go', messageId: 'm1' },
    { kind: 'text', blockId: 'a', text: 'First part' },
    { kind: 'tool', id: 't1', name: 'Bash', toolKind: 'shell', input: { command: 'ls' } },
    { kind: 'text', blockId: 'b', text: 'Second part' },
  ]);
  const rows = byClass(tl.el, 'chat-copyturn');
  assert.equal(rows.length, 1, 'one per turn');
  const turn = rows[0].parentNode;
  const kids = turn.children;
  assert.equal(kids.indexOf(rows[0]), kids.length - 1, 'under the turn\'s last block');
  assert.ok(byClass(kids[kids.length - 2], 'chat-text').length || kids[kids.length - 2].className.includes('chat-text'), 'right after the last reply');
  const btn = byClass(rows[0], 'chat-copyreply')[0];
  assert.equal(btn.attrs['aria-label'], 'Copy the reply');
  await btn.listeners.click();
  assert.deepEqual(given, ['First part\n\nSecond part']);
  for (const t of byClass(tl.el, 'chat-text')) assert.equal(byClass(t, 'chat-copyreply').length, 0, 'nothing inside a block');
});

test('the hint of a restart: said only where a part was handed (its card, or a call of the parts tool), and once', () => {
  const note = { kind: 'notice', topic: 'parts-restart', level: 'info', text: 'Hoprig restarted. Parts this chat handed to other models before that are no longer shown here; their sessions are on Home.' };
  const plain = draw([note, { kind: 'user', text: 'go' }, { kind: 'text', blockId: 'a', text: 'Done' }]);
  assert.doesNotMatch(texts(plain.el).join('|'), /Hoprig restarted/, 'a chat that handed nothing hears nothing');
  const card = draw([note, { kind: 'user', text: 'go' }, { kind: 'part-ask', part: 'p_1', label: 'Other model', partKind: 'review', brief: 'check it' }]);
  const said = texts(card.el).join('|');
  assert.match(said, /Hoprig restarted\. Parts this chat handed to other models before that are no longer shown here/);
  const turn = byClass(card.el, 'chat-ask-part')[0].parentNode;
  assert.ok(turn.children.findIndex((c) => texts(c).join('').startsWith('Hoprig restarted')) < turn.children.findIndex((c) => c.className.includes('chat-ask-part')), 'before the card');
  const tool = draw([note, { kind: 'user', text: 'go' }, { kind: 'tool', id: 't2', name: 'mcp__hoprig-parts__start', toolKind: 'other', input: {} }, { kind: 'tool', id: 't3', name: 'mcp__hoprig-parts__result', toolKind: 'other', input: {} }]);
  assert.equal(texts(tool.el).join('|').split('Hoprig restarted').length - 1, 1, 'once');
});

test('a tool line is one muted line: its kind\'s picture, the words, a chevron; no box and no coloured circle', async () => {
  const { toolCard } = await import('../../web/chat/tools.js');
  const el = toolCard({ id: 'b', name: 'Bash', toolKind: 'shell', input: { command: 'npm test' } }, { cwd: '/p' });
  assert.equal(byClass(el, 'chat-tool-state').length, 1);
  assert.ok(el.querySelector('summary .chat-tool-chev'), 'a chevron at the end of the line');
  el.result({ ok: true, text: 'ok' });
  assert.equal(byClass(el, 'chat-tool-state')[0].children.length, 1, 'the kind\'s picture stays: the state is the colour and the words, not a circle with a check');
  const c = css('chat-cards.css');
  assert.match(rule(c, '.chat-tool'), /border: 0[^}]*background: none/);
  assert.match(rule(c, '.chat-tool-state'), /width: 16px/);
  assert.match(rule(c, '.chat-tool-verb'), /font-weight: 500/);
  assert.match(rule(c, '.chat-tool-detail.mono'), /12\.5px var\(--mono\)/);
  assert.match(rule(c, '.chat-cmd, .chat-out'), /background: var\(--chat-well\)[^}]*border: 1px solid var\(--border\)/, 'a command and its output on the well');
  assert.match(c, /\.chat-tool\.chat-is-err \.chat-tool-verb[^{]*\{[^}]*var\(--danger\)/);
  assert.match(rule(c, '.chat-tool-body'), /border-left: 1px solid var\(--border\)/);
});

test('thinking is a line of the same family: its picture, its words, a chevron, no peek, not italic', () => {
  const tl = draw([{ kind: 'thinking', blockId: 'k', text: 'Let me look', durationMs: 12_000 }]);
  const think = tl.el.querySelector('details.chat-think');
  assert.ok(think.querySelector('summary .chat-tool-chev'));
  assert.equal(byClass(think, 'chat-think-peek').length, 0);
  assert.equal(texts(byClass(think, 'chat-think-head')[0]).join(''), 'Thought for 12 s');
  const c = css('chat.css');
  assert.doesNotMatch(rule(c, '.chat-think-body'), /italic/);
  assert.doesNotMatch(c, /chat-think-head \{[^}]*italic/);
  assert.match(rule(c, '.chat-think-body'), /border-left: 1px solid var\(--border\)/);
});

const ask = (extra = {}) => askCard({ request: 'r1', type: 'permission', tool: 'Bash', input: { command: 'npm test' }, canAlways: true, alwaysText: 'Bash(npm test)', canProject: true, ...extra }, { A: '/api/chats/x', cwd: '/p' });

test('the permission card asks as a question; Do not allow first, Allow in one press, the wider allows behind an arrow', () => {
  const el = ask();
  assert.match(texts(byClass(el, 'chat-ask-head')[0]).join(''), /^Allow Claude to run a command\?$/);
  const actions = byClass(el, 'chat-ask-actions')[0];
  assert.deepEqual(actions.children.map((c) => texts(c).join('')), ['Do not allow', 'Allow'], 'two things to read, the safe one first');
  const allow = byClass(el, 'chat-allow')[0];
  assert.equal(texts(allow).join(''), 'Allow');
  const arrow = byClass(el, 'chat-allow-more')[0];
  assert.equal(arrow.attrs['aria-label'], 'More ways to allow');
  assert.equal(byClass(el, 'chat-ask-scope').length, 0, 'no line explaining each button');
  assert.doesNotMatch(texts(el).join('|'), /Allow in this session|Always allow in this project/, 'those are in the menu, not on the card');
});

test('no arrow where the coding tool offers no wider allow; the number keys still answer in the old order', () => {
  const el = ask({ canAlways: false, canProject: false });
  assert.equal(byClass(el, 'chat-allow-more').length, 0);
  assert.equal(byClass(el, 'chat-allow').length, 1);
  assert.equal(el.keys(1), true, '1 allows');
});

test('the card: neutral (no warning fill), a hairline edge, the command in the well; a phone gets two equal columns of 48 px', () => {
  const c = css('chat-cards.css');
  const r = rule(c, '.chat-ask');
  assert.match(r, /border: 1px solid var\(--border-strong\)/);
  assert.match(r, /background: var\(--surface\)/);
  assert.doesNotMatch(r, /warn/);
  assert.doesNotMatch(c, /\.chat-ask\.chat-ask-(question|plan|mcp)[^{]*\{[^}]*background: var\(--accent-soft\)/, 'questions, plans and MCP cards are neutral too');
  assert.match(c, /\.chat-ask-actions:has\(> \.chat-deny\) \{ display: grid; grid-template-columns: 1fr 1fr; \}/);
  assert.match(c, /\.chat-ask-actions:has\(> \.chat-deny\) \.btn \{ min-height: 48px; \}/);
  assert.match(c, /\.chat-ask-actions:has\(> \.chat-deny\) \{ justify-content: space-between; \}/);
});

test('the to-do list is a quiet row in the bubble grey with circles and a bar; no box, no strike-through', () => {
  const c = css('chat.css');
  assert.match(rule(c, '.chat-todos'), /background: var\(--chat-bubble\)/);
  assert.doesNotMatch(rule(c, '.chat-todos'), /border:/);
  assert.match(rule(c, '.chat-todo-bar'), /width: 40px; height: 3px/);
  assert.doesNotMatch(c, /line-through/);
  assert.match(c, /\.chat-todo-list \.t-completed \.chat-todo-mark \{[^}]*background: var\(--text-2\)/);
});

test('code on the well, inline code a small chip, links in the accent with a soft underline, tables with a well head', () => {
  const c = css('chat-cards.css');
  assert.match(rule(c, '.chat-text .md-code'), /background: var\(--chat-well\)[^}]*border: 1px solid var\(--border\)[^}]*border-radius: 10px[^}]*13px\/1\.55 var\(--mono\)/);
  assert.match(rule(c, '.chat-text .md code'), /background: var\(--chat-well\)[^}]*padding: 1px 5px[^}]*border-radius: 5px[^}]*0\.9em/);
  assert.match(rule(c, '.md-link'), /var\(--accent\)[^}]*underline[^}]*40%/);
  assert.match(css('../page-tiacards.css'), /\.md-table th \{ background: var\(--chat-well, var\(--surface-3\)\)/);
  assert.match(rule(css('chat.css'), '.chat-text .md'), /font-size: var\(--fs-lg\)[^}]*line-height: 1\.6/, 'the reply at 15 px');
  assert.doesNotMatch(css('chat.css'), /chat-is-streaming \.md > :last-child::after/, 'no caret: the living line says it works');
});

test('the reading column is 760 px and the gaps are small inside a turn, close between tool lines, wide before a sent message', () => {
  const c = css('chat.css');
  assert.match(rule(c, '.chat-col'), /max-width: 760px/);
  assert.match(rule(c, '.chat-scroll'), /padding: 24px 24px 12px/);
  assert.match(c, /@media \(max-width: 599px\) \{[^@]*\.chat-scroll \{ padding: 16px 16px 8px; \}/);
  assert.match(c, /\.chat-list, \.chat-older, \.chat-chunk, \.chat-turn \{[^}]*gap: 8px/);
  assert.match(c, /\.chat-list, \.chat-chunk \{ gap: 20px; \}/);
  assert.match(c, /\.chat-tool \+ \.chat-tool[^{]*\{ margin-top: -6px; \}/);
  assert.match(c, /\.chat-turn:has\(> \.chat-userrow:first-child\) \{ margin-top: 8px; \}/);
});

test('the living line, the jump button and the Background tasks line are quiet, in the chat\'s own colours', () => {
  const c = css('chat.css');
  assert.match(rule(c, '.chat-live'), /min-height: 28px[^}]*font-size: var\(--fs-sm\)/);
  assert.match(rule(c, '.chat-live-mark'), /color: var\(--accent\)[^}]*spin 2\.4s linear infinite/);
  assert.match(c, /prefers-reduced-motion: reduce\) \{\s*\.chat-live-mark \{ animation: none; \}/);
  assert.match(rule(c, '.chat-bg'), /background: var\(--chat-bubble\)/);
  assert.doesNotMatch(rule(c, '.chat-bg'), /accent/);
  assert.match(rule(c, '.chat-down.chat-down-ask'), /var\(--warn-solid\)/);
  assert.doesNotMatch(c, /\.chat-status|\.chat-st-/, 'no status line under the box any more');
});
