// The conversation as it happens: the numbered events of the chat (src/chat/events.mjs) drawn once each, in turns
// (a message of the owner, or a turn Claude starts by itself, and everything up to its end); text that streams and
// is replaced by its final block (same block id); thinking folded with its time; tool cards (tools.js) with a
// subagent's steps inside the call that started it; cards that wait for the owner (asks.js); "Show earlier"; and the
// view stays at the bottom unless the owner scrolled up. A screen reader hears only what is new and whole (a reply,
// a card), never the list as it streams.
import { icon } from '../icons.js';
import { add, api, copyText, fill, h, link, toast } from '../lib.js';
import { mdView } from '../mdtext.js';
import { messageFiles } from './attach.js';
import { OUTCOME, askCard } from './asks.js';
import { pathButton } from './pathmenu.js';
import { answerLine, waitWords } from '../handsoff.js';
import { outputView, rePaths, toolCard } from './tools.js';
import { thinkingOpen, transcriptView } from './transcript.js';
import { askTitle, failText, ownMessageView, signInWay, startFold, took, turnErrorWords, turnParts } from './words.js';

const NEAR_PX = 120;

const copyDone = async (text) => toast((await copyText(text)) ? 'Copied' : 'Select it and copy it by hand');
/** A code block of a reply, with its Copy at the top right. */
const codeBlock = (code) => h('div.chat-codewrap', h('pre.md-code', code),
  h('button.btn.icon.ghost.chat-codecopy', { type: 'button', title: 'Copy', 'aria-label': 'Copy this code', onclick: () => copyDone(code) }, icon('copy', { size: 14 })));

const FOLD_LINES = 8;
/** The words of a sent message; one that runs past 8 lines is folded, with Show more (and Show less) under it. */
function userBubble(text, files) {
  const body = h('div.chat-usertext', text);
  const bubble = h('div.chat-user', body);
  const lines = String(text).replace(/\s+$/, '').split('\n').length;
  let more = null;
  const set = (open) => {
    body.dataset.fold = open ? 'open' : 'closed';
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
    fill(more, open ? 'Show less' : 'Show more');
  };
  const need = () => {
    if (more) return;
    more = h('button.chat-more', { type: 'button', 'aria-expanded': 'false', onclick: () => set(body.dataset.fold !== 'open') });
    bubble.insertBefore(more, body.nextSibling);
    set(false);
  };
  if (lines > FOLD_LINES) need();
  else if (String(text).length > 120 && typeof requestAnimationFrame === 'function') {
    // Lines that wrap: measured once the bubble is on the page, again when its width changes.
    let width = -1;
    const measure = () => {
      if (more || !body.clientWidth || body.clientWidth === width) return;
      width = body.clientWidth;
      body.dataset.fold = 'closed';
      if (body.scrollHeight > body.clientHeight + 1) need();
      else delete body.dataset.fold;
    };
    requestAnimationFrame(measure);
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(body);
  }
  if (files) add(bubble, files);
  return bubble;
}
/** Hoprig's own set-up message: the same bubble, its full text one press away. */
function setupBubble(fold, name, files) {
  return h('div.chat-user.chat-startfold', h('p.chat-startsaid', `Hoprig asked the AI to set up ${name} from your brief`),
    h('details.chat-startfull', h('summary', 'Show the full message'), h('div.chat-startfulltext', fold.full)),
    fold.brief ? h('div.chat-startbrief', fold.brief) : null, files);
}
/**
 * o: { scroll (the scrolling element), A (the chat's API path), cwd(), stopTask(id), after(), canRewind(), rewind({ messageId, text }),
 *      who() (the coding tool as a sentence names it: "Claude", "OpenCode"), canStopTask(), modes() (the chat's
 *      permission modes, or null), provider() (the chat's { profile: { name, kind, ownFolder? }, tool, remote }, or null) }
 */
/**
 * A turn that ended in an error: a plain line for a known kind (the tool's own text folded), else the text. `who`:
 * the chat's provider and coding tool ({ profile, tool }), so a refused sign-in offers what fixes it for that provider.
 */
function errorView(error, who = {}) {
  const known = turnErrorWords(error);
  if (!known) return h('div.chat-item.banner.error-box', { role: 'alert' }, icon('alert', { size: 18 }), h('span', error || 'The reply ended with an error.'));
  const way = known.kind === 'auth' ? signInWay(who.profile, who.tool, { remote: who.remote === true }) : null;
  // The sign-in sheet loads on the press only: the timeline stays free of the settings parts.
  const signIn = !way ? null : way.kind === 'claude-signin'
    ? h('button.btn.small.secondary', { type: 'button', onclick: () => import('../claudelogin.js').then((m) => m.claudeSignIn()) }, 'Sign in again')
    : h('a.btn.small.secondary', { href: link(way.hash) }, 'Open the provider');
  return h('div.chat-item.chat-error',
    h('div.banner.error-box', { role: 'alert' }, icon('alert', { size: 18 }), h('span', known.line)),
    signIn,
    h('details.adv', h('summary', 'Details'), h('pre.output', String(error))));
}

export function createTimeline(o) {
  const who = () => (o.who ? o.who() : 'Claude');
  // One task's Stop only where the coding tool can stop one task (else the turn's Stop is the way).
  const canStop = () => (o.canStopTask ? o.canStopTask() : true);
  const moreSlot = h('div.chat-moreslot');
  const olderBox = h('div.chat-older');
  const list = h('div.chat-list');
  const downBtn = h('button.btn.small.primary.chat-down.hidden', { type: 'button', onclick: () => toBottom(true) }, icon('down', { size: 16 }), h('span', 'New messages'));
  const tools = new Map(); // tool call id → its card
  const asks = new Map(); // request id → its card
  const partAsks = new Map(); // a part's card for the owner, by part id (part-ask)
  const blocks = new Map(); // block id → its element (live while it streams, then final)
  const orphans = new Map(); // agent id → where its steps go when its call is not drawn (an earlier window)
  const said = h('div.chat-sr', { role: 'status', 'aria-live': 'polite' }); // what a screen reader hears
  // The end of the conversation: the living line while a turn runs, then the messages waiting to be read (page.js puts them here).
  const tail = h('div.chat-tail');
  let main = { root: list, group: null }; // where new events go
  let first = 0; // the number of the first event drawn
  let stick = true;
  let asked = false; // a card that waits for the owner came while the view was scrolled up
  let view = null; // the transcript view (transcript.js), made with the root below
  // On a touch screen the row of actions shows under the newest sent message and under one that was tapped.
  let marking = false;
  function markNewest() {
    if (marking) return;
    marking = true;
    queueMicrotask(() => {
      marking = false;
      const rows = o.scroll.querySelectorAll ? [...o.scroll.querySelectorAll('.chat-userrow')] : [];
      rows.forEach((r, i) => r.classList.toggle('chat-newest', i === rows.length - 1));
    });
  }
  list.addEventListener('click', (e) => {
    const t = e.target;
    const row = t && t.closest ? t.closest('.chat-userrow') : null;
    const keep = row && t.closest('.chat-user') && !t.closest('button, a, summary') ? row : null;
    for (const r of list.querySelectorAll('.chat-userrow.chat-acts-on')) if (r !== keep) r.classList.remove('chat-acts-on');
    if (keep) keep.classList.toggle('chat-acts-on');
  });
  // One Copy under the last reply of a turn (not one beside every block): it copies the turn's replies. On a wide screen
  // it shows when the turn is pointed at; on a touch screen only under the last reply of the conversation, once it ended.
  const after = (el, node) => {
    const kids = [...el.parentNode.children];
    el.parentNode.insertBefore(node, kids[kids.indexOf(el) + 1] || null);
  };
  let markingCopy = false;
  function markLastCopy() {
    if (markingCopy) return;
    markingCopy = true;
    queueMicrotask(() => {
      markingCopy = false;
      const rows = list.querySelectorAll ? [...list.querySelectorAll('.chat-copyturn')] : [];
      rows.forEach((r, i) => r.classList.toggle('chat-copy-last', i === rows.length - 1));
    });
  }
  function copyUnder(el) {
    const g = el.parentNode;
    if (!g || !el.text.trim()) return;
    if (!g.replies) g.replies = [];
    if (!g.replies.includes(el)) g.replies.push(el);
    if (!g.copyRow) {
      g.copyRow = h('div.chat-copyturn', h('button.btn.ghost.chat-copyreply', { type: 'button', title: 'Copy the reply', 'aria-label': 'Copy the reply', onclick: () => copyDone(g.replies.map((x) => x.text.trim()).filter(Boolean).join('\n\n')) }, icon('copy', { size: 16 }), h('span.chat-actword', 'Copy')));
    }
    after(el, g.copyRow);
    markLastCopy();
  }
  // "Hoprig restarted ..." (src/models/partdoor.mjs) is shown only in a chat that really handed a part: it comes before
  // the first card of a part, or the first call of the parts tool.
  let restartNote = null;
  function showRestart(el) {
    if (!restartNote || !el.parentNode) return;
    el.parentNode.insertBefore(h('p.chat-item.chat-note', restartNote), el);
    restartNote = null;
  }
  const cardOpts = () => ({ cwd: o.cwd(), stopTask: canStop() ? o.stopTask : null, view: view.now });

  // ---------- where an event goes ----------
  function group(at, { auto = false } = {}) {
    at.group = h('section.chat-turn', auto ? h('p.chat-auto', icon('refresh', { size: 13 }), h('span', `${who()} went on by itself: a background task ended`)) : null);
    add(at.root, at.group);
    return at.group;
  }
  const groupOf = (at) => at.group || group(at);
  function container(ev, at) {
    if (!ev.agent) return groupOf(at);
    const card = tools.get(ev.agent);
    if (card) return card.steps;
    let box = orphans.get(ev.agent);
    if (!box) {
      box = h('div.chat-steps', h('p.chat-hint', 'Steps of an agent started earlier'));
      orphans.set(ev.agent, box);
      add(groupOf(at), box);
    }
    return box;
  }

  // ---------- blocks ----------
  const thinkHead = (b) => (b.final ? (Number.isFinite(b.ms) && b.ms > 0 ? `Thought for ${took(b.ms)}` : 'Thought') : 'Thinking…');
  function thinkingEl(blockId, agent) {
    const head = h('span.chat-think-head');
    const body = h('div.chat-think-body');
    const el = h('details.chat-item.chat-think', h('summary', h('span.chat-tool-state', { 'aria-hidden': 'true' }, icon('brain', { size: 16 })), head, h('span.chat-tool-chev', { 'aria-hidden': 'true' }, icon('chevronRight', { size: 14 }))), body);
    Object.assign(el, { head, body, kind: 'thinking', agent });
    fill(head, 'Thinking…');
    el.open = thinkingOpen(view.now());
    return el;
  }
  // A reply's text as Markdown: links, a code block with Copy, a `path` of the folder as a button to the editor.
  const reply = (text) => mdView(text, { rich: true, code: codeBlock, onCode: (t) => pathButton(t, { cwd: o.cwd() }) });
  function textEl() {
    const el = h('div.chat-item.chat-text');
    el.kind = 'text';
    return el;
  }
  // Streaming text is drawn as Markdown at most once a frame.
  const pending = new Set();
  let frame = 0;
  function paintBlock(el) {
    pending.add(el);
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const b of pending) {
          if (b.kind === 'text') fill(b, reply(b.text));
          else fill(b.body, b.text);
        }
        pending.clear();
        follow();
      });
    }
  }
  function liveBlock(blockId, kind, agent, at = main) {
    let el = blocks.get(blockId);
    if (el && el.kind !== kind) el = null; // see draw: the same id again with another kind is another block
    if (!el) {
      el = kind === 'thinking' ? thinkingEl(blockId, agent) : textEl();
      el.text = '';
      el.streamedAt = Date.now();
      el.classList.add('chat-is-streaming');
      blocks.set(blockId, el);
      add(container({ agent }, at), el);
    }
    return el;
  }

  // ---------- one event ----------
  function draw(ev, at) {
    switch (ev.kind) {
      case 'user': {
        const g = group(at);
        const { text, files } = ownMessageView(ev.text, Array.isArray(ev.attachments) ? ev.attachments : []);
        const fold = startFold(text);
        const name = (fold && fold.name) || String(o.cwd() || '').split('/').filter(Boolean).pop() || 'the project';
        const shown = messageFiles(files, o.A);
        const bubble = fold ? setupBubble(fold, name, shown) : userBubble(text, shown);
        const acts = h('div.chat-useracts',
          h('button.btn.ghost.chat-copybtn', { type: 'button', title: 'Copy', 'aria-label': 'Copy this message', onclick: () => copyDone(text) },
            icon('copy', { size: 16 }), h('span.chat-actword', 'Copy')),
          // Rewind (the files, the conversation or both, to before this message). It puts the message back in the box, so it
          // is also the way to edit it: no third button.
          ev.messageId && o.canRewind() ? h('button.btn.ghost.chat-rewindbtn', {
            type: 'button', title: 'Rewind to here: go back to before this message', 'aria-label': 'Rewind to here',
            onclick: () => o.rewind({ messageId: ev.messageId, text: ev.text }),
          }, icon('undo', { size: 16 }), h('span.chat-actword', 'Rewind to here')) : null);
        const row = h('div.chat-item.chat-userrow', { dataset: { message: ev.messageId || '' } }, bubble, acts);
        row.said = text;
        markNewest();
        return add(g, row);
      }
      case 'turn-start':
        if (ev.auto) group(at, { auto: true });
        else groupOf(at);
        return null;
      case 'text':
      case 'thinking': {
        let el = blocks.get(ev.blockId);
        // A block id is the coding tool's message id and the block's place in it; one that comes again with another
        // kind (a stand-in whose numbering started over) is another block, never written into the old one.
        if (el && el.kind !== ev.kind) el = null;
        if (!el) {
          el = ev.kind === 'thinking' ? thinkingEl(ev.blockId, ev.agent) : textEl();
          blocks.set(ev.blockId, el);
          add(container(ev, at), el);
        }
        el.classList.remove('chat-is-streaming');
        el.final = true;
        el.text = ev.text || '';
        if (ev.kind === 'thinking') {
          el.ms = Number.isFinite(ev.durationMs) ? ev.durationMs : el.streamedAt ? Date.now() - el.streamedAt : null;
          fill(el.head, thinkHead(el));
          fill(el.body, el.text || h('span.chat-hint', `${who()} did not show what it thought.`));
        } else {
          fill(el, reply(el.text));
          if (!ev.agent) copyUnder(el);
        }
        return el;
      }
      case 'tool': {
        let card = tools.get(ev.id);
        if (card) card.finish(ev);
        else {
          card = toolCard(ev, cardOpts());
          tools.set(ev.id, card);
          add(container(ev, at), card);
          if (/^mcp__hoprig-parts__/.test(ev.name || '')) showRestart(card);
        }
        return card;
      }
      case 'tool-result': {
        const card = tools.get(ev.id);
        if (!card) return null;
        card.result(ev);
        if (card.cancelledAsk) foldCancelled(card.cancelledAsk); // closed and waiting for this: said by the card now
        return null;
      }
      case 'ask': {
        // Always in the main conversation, where it is seen, even when an agent asks.
        const card = askCard(ev, { A: o.A, cwd: o.cwd(), after: o.after, who: who(), modes: o.modes ? o.modes() : null });
        card.toolId = ev.toolId || null;
        asks.set(ev.request, card);
        if (ev.toolId) tools.get(ev.toolId)?.quiet(); // the card shows what it would do: not twice
        asked = true;
        if (ev.agent) add(card, h('p.chat-hint', 'An agent asks this.'));
        return add(groupOf(at), card);
      }
      case 'ask-closed': {
        const card = asks.get(ev.request);
        if (!card) return null;
        const [text, ok] = OUTCOME[ev.outcome] || ['Answered', true];
        const plan = card.classList.contains('chat-ask-plan');
        const question = card.classList.contains('chat-ask-question');
        // An answered OK folds into the tool card it was about (one step, said once: "Ran npm test · allowed by
        // you"). One no longer waited for (Stop, the turn ended) folds once its tool card says how the call ended
        // (foldCancelled); until then, and without a tool card, it stays closed in place.
        const tool = !plan && !question && card.toolId && OUTCOME[ev.outcome] && ev.outcome !== 'cancelled' ? tools.get(card.toolId) : null;
        if (tool) {
          card.done = true;
          card.remove();
          tool.answered(ok, ev.outcome);
          return null;
        }
        if (ev.outcome === 'cancelled' && !plan && !question && foldCancelled(card)) return null;
        card.closed(ev.outcome === 'handsoff' ? text : plan ? (ok ? 'You approved the plan' : ev.outcome === 'denied' ? `${who()} keeps planning` : text) : question && ok ? 'You answered' : text, ok);
        if (card.toolId && ev.outcome !== 'cancelled') tools.get(card.toolId)?.answered(ok); // "Wants to write" → "Writing"
        return null;
      }
      case 'turn-end': {
        const g = groupOf(at);
        if (ev.ok) {
          // Shown in the Verbose view; its dollars only on a provider billed by use (the root's classes decide).
          const { cost, rest } = turnParts(ev);
          if (cost || rest) {
            add(g, h(`p.chat-item.chat-turnend${rest ? '' : '.chat-moneyonly'}`, icon('check', { size: 13 }),
              h('span', cost ? h('span.chat-money', rest ? `${cost} · ` : cost) : null, rest)));
          }
        } else if (ev.stopped || ev.subtype === 'stopped' || ev.error === 'stopped') add(g, h('p.chat-item.chat-note', `You stopped ${who()}.`));
        // A usage limit is said once, by the limit card at the top with what to do next.
        else if (ev.limited) add(g, h('p.chat-item.chat-note', 'Stopped at the provider\'s usage limit (see above).'));
        else add(g, errorView(ev.error, (o.provider && o.provider()) || {}));
        at.group = null;
        return null;
      }
      case 'handsoff': {
        // Hands-off (src/chat/handsoff.mjs): what it answered for the owner and why, or why it left the ask to him.
        if (ev.text) {
          const line = [h('strong', 'Answered by Hoprig: '), answerLine({ text: ev.text, because: ev.because })];
          // Said once, on the card it answered (closed just before by ask-closed); a line of its own only without one.
          const card = asks.get(ev.request);
          const st = card && card.done ? card.querySelector('.chat-ask-status') : null;
          if (st) return (fill(st, icon('check', { size: 14 }), h('span', ...line)), null);
          return add(groupOf(at), h('p.chat-item.chat-note.ho-done', { role: 'status' }, ev.question ? `${ev.question} → ` : '', ...line));
        }
        const words = ev.stopped ? waitWords(ev.stopped) : waitWords(ev.waits);
        return words ? add(groupOf(at), h('p.chat-item.chat-note.ho-wait', { role: 'status' }, words)) : null;
      }
      case 'allowed':
        // Allowed by Hoprig itself in bypass mode (a plain delete: src/chat/asks.mjs), in the words of a terminal's page.
        // The command itself for the shell (no tool name), and where it ran when not in the chat's folder; read out.
        {
          const lead = ev.by === 'all' ? 'Allowed without asking (Allow everything): ' : 'Allowed by Hoprig in bypass mode: ';
          const what = `${ev.tool && ev.tool !== 'Bash' ? `${ev.tool}: ` : ''}${ev.what || ev.tool}${ev.folder ? ` · in ${ev.folder}` : ''}`;
          return add(groupOf(at), h('p.chat-item.chat-note.chat-allowed', { role: 'status', title: `${lead}${what}` }, h('strong', lead), what));
        }
      case 'session-changed':
        at.group = null;
        return add(at.root, h('div.chat-item.chat-divider', h('span', ev.reason === 'compact' ? `Conversation compacted: ${who()} goes on from a summary` : ev.reason === 'clear' ? 'Conversation cleared' : ev.reason === 'fork' ? 'Rewound to here' : 'A new conversation')));
      case 'part-ask': {
        // "Use other providers": a part on a provider billed by use waits for the owner's yes (src/models/partdoor.mjs).
        // The status line can take the focus: after a press its buttons go, and the focus goes there, not to the page.
        const status = h('p.chat-ask-status', { role: 'status', tabindex: '-1' });
        const say = async (allow) => {
          // A browser drops the focus of a button it disables: the focus moves to the status line first, at the press.
          // An empty status line is not shown (chat-cards.css), and what is not shown cannot take the focus: it says
          // what is happening before it takes it.
          const pressed = card.contains(document.activeElement) ? document.activeElement : null;
          fill(status, allow ? 'Handing it over…' : 'Telling the lead…');
          if (pressed) status.focus();
          for (const b of card.querySelectorAll('button')) b.disabled = true;
          try {
            await api(`/api/parts/${ev.part}/answer`, { allow });
          } catch (e) {
            for (const b of card.querySelectorAll('button')) b.disabled = false;
            fill(status);
            if (pressed) pressed.focus();
            toast(failText(e), { from: e, kind: 'error' });
          }
        };
        const card = h('section.chat-item.chat-ask.chat-ask-part', { 'aria-label': `Hand a part to ${ev.label}?`, tabindex: '-1' },
          h('div.chat-ask-head', icon('alert', { size: 18 }), h('strong', `Hand a part to ${ev.label}?`)),
          h('p.chat-hint', `${ev.label} is billed by use: this part costs money there. The part: ${ev.partKind}.`),
          ev.brief ? h('p.chat-hint', `What it would do: ${ev.brief}`) : null,
          h('div.chat-ask-actions',
            h('button.btn.small.primary', { type: 'button', onclick: () => say(true) }, 'Yes, hand it over'),
            h('button.btn.small.secondary', { type: 'button', onclick: () => say(false) }, 'No, the lead does it')),
          status);
        partAsks.set(ev.part, card);
        add(groupOf(at), card);
        showRestart(card);
        return card;
      }
      case 'part-ask-kept': {
        // His yes is kept: nothing starts until the lead asks for the part (src/models/partdoor.mjs).
        const card = partAsks.get(ev.part);
        const text = 'Your yes is kept: the part starts when the lead asks for it. If the lead goes on without it, nothing starts.';
        if (!card) return add(groupOf(at), h('p.chat-item.chat-note', text));
        const had = card.contains(document.activeElement);
        for (const b of card.querySelectorAll('button')) b.remove();
        const st = card.querySelector('.chat-ask-status');
        fill(st, text);
        if (had && st) st.focus();
        return null;
      }
      case 'part-ask-closed': {
        const card = partAsks.get(ev.part);
        const text = ev.outcome === 'yes' ? 'You said yes: the part started there.' : ev.outcome === 'no' ? 'You said no: the lead does this part itself.' : ev.outcome === 'lead' ? 'No answer in time: the lead does this part itself. Nothing was started.' : ev.outcome === 'gone' ? 'The lead went on without it. Nothing was started.' : `It could not start: ${ev.why || 'refused'}. The lead does this part itself.`;
        if (!card) return add(groupOf(at), h('p.chat-item.chat-note', text));
        // Answered by keyboard: the focus was on one of its buttons, which go now; it moves to the line that says what
        // happened, so the next Tab goes on from this card and a screen reader reads the answer.
        const had = card.contains(document.activeElement);
        for (const b of card.querySelectorAll('button')) b.remove();
        const st = card.querySelector('.chat-ask-status');
        fill(st, text);
        if (had && st) st.focus();
        return null;
      }
      case 'notice':
        if (ev.topic === 'parts-restart') {
          restartNote = ev.text || null; // said later, and only if a part was handed
          return null;
        }
        // "Compacted" after /compact: the divider says it already.
        if (ev.local && /^\s*Compacted\.?\s*$/i.test(ev.text)) return null;
        // What Claude Code answered by itself (/cost, /context): its text as it wrote it, in a box.
        if (ev.local) return add(groupOf(at), h('div.chat-item.chat-local', h('p.chat-local-head', icon('terminal', { size: 13 }), h('span', 'Claude Code')), outputView(ev.text, { cls: 'chat-local-text' })));
        return add(groupOf(at), h(`p.chat-item.chat-note${ev.level === 'error' ? '.chat-is-err' : ''}`, ev.text));
      default:
        return null;
    }
  }
  // An OK no longer waited for (Stop, the turn ended): once its tool card says how the call ended ("Did not write …
  // stopped by you") the card goes, so the step is said once; until then it stays, closed (that tool card may never
  // get a result). → whether it went
  function foldCancelled(card) {
    const tool = card.toolId ? tools.get(card.toolId) : null;
    if (!tool) return false;
    if (!tool.ended()) {
      tool.cancelledAsk = card;
      return false;
    }
    tool.cancelledAsk = null;
    card.done = true;
    card.remove();
    return true;
  }
  const drawAll = (events, at) => {
    for (const ev of events) draw(ev, at);
  };

  // ---------- what a screen reader hears: a whole reply, a card, an error; once each ----------
  function announce(events) {
    const words = [];
    for (const ev of events) {
      if (ev.agent) continue;
      if (ev.kind === 'text') words.push(`${who()}: ${ev.text.slice(0, 400)}`);
      else if (ev.kind === 'ask') words.push(ev.type === 'permission' ? `${askTitle(ev.tool, ev.input || {}, who())}: it needs your OK` : `${who()} needs your answer: ${ev.title || 'a question'}`);
      else if (ev.kind === 'notice' && (ev.local || ev.level === 'error')) words.push(ev.text.slice(0, 300));
      else if (ev.kind === 'turn-end' && !ev.ok && !ev.stopped) words.push(ev.error || 'The reply ended with an error.');
    }
    if (!words.length) return;
    said.textContent = '';
    requestAnimationFrame(() => (said.textContent = words.slice(-3).join('. ')));
  }

  // ---------- scrolling ----------
  const nearBottom = () => o.scroll.scrollHeight - o.scroll.scrollTop - o.scroll.clientHeight < NEAR_PX;
  const downText = downBtn.querySelector('span');
  function toBottom(force = false) {
    if (force) stick = true;
    requestAnimationFrame(() => (o.scroll.scrollTop = o.scroll.scrollHeight));
    downBtn.classList.add('hidden');
    asked = false;
  }
  /** Something was added: stay at the bottom when the owner was there, else say there is news. */
  function follow() {
    if (stick) return toBottom();
    paintDown();
    downBtn.classList.remove('hidden');
  }
  // While a turn runs the button says the step (Thinking, Writing, Running, Needs your OK), else that there is news.
  function paintDown() {
    const s = o.down ? o.down() : null;
    const ask = !!(s && s.attention) || (!s && asked);
    fill(downText, s ? s.text : asked ? `${who()} needs your OK` : 'New messages');
    downBtn.classList.toggle('chat-down-ask', ask);
  }
  o.scroll.addEventListener('scroll', () => {
    stick = nearBottom();
    if (stick) {
      downBtn.classList.add('hidden');
      asked = false;
    }
  }, { passive: true });

  // ---------- earlier events ----------
  const paintMore = (more) => fill(moreSlot, more ? h('button.btn.small.secondary.chat-more', { type: 'button', onclick: (e) => older(e.currentTarget) }, 'Show earlier messages') : null);
  async function older(btn) {
    btn.disabled = true;
    try {
      const r = await api(`${o.A}/older?before=${first}`);
      const h0 = o.scroll.scrollHeight;
      if (r.events.length) {
        // Earlier events go above what is shown: a chunk of their own, first in the box.
        const chunk = h('div.chat-chunk');
        drawAll(r.events, { root: chunk, group: null });
        fill(olderBox, chunk, [...olderBox.children]);
        first = r.events[0].i;
      }
      paintMore((r.events.length > 0 && first > r.base) || !!r.more);
      o.scroll.scrollTop += o.scroll.scrollHeight - h0; // what was on screen stays where it was
    } catch (e) {
      btn.disabled = false;
      toast(failText(e), { from: e, kind: 'error' });
    }
  }

  const empty = () => h('div.chat-empty', icon('text', { size: 26 }), h('p', `Write what you want, in your own words. ${who()} reads and changes the files of this project, and asks you before anything that needs your OK.`));

  const root = h('div.chat-col.chat-timeline', moreSlot, olderBox, list, tail, said);
  view = transcriptView(root, () => ({ cards: tools.values(), blocks: blocks.values() }));
  return {
    el: root,
    /** The transcript view now (normal, thinking or verbose), another one (the session menu's), and the dollars. */
    view: view.now,
    setView: view.set,
    billed: view.billed,
    /** Whether the conversation has thinking to show (the menu offers the Thinking view then). */
    thought: () => [...blocks.values()].some((b) => b.kind === 'thinking'),
    /** The owner's messages drawn (for the more menu's Rewind): [{ messageId, text }], oldest first. */
    messages: () => [...o.scroll.querySelectorAll('.chat-userrow')].map((e) => ({ messageId: e.dataset.message, text: e.said || '' })),
    downBtn,
    /** The end of the conversation: the living line, then the messages waiting to be read. */
    tail,
    /** The tail grew or shrank: stay at the bottom where the owner was. A step changed: the jump button says it. */
    settle() {
      if (stick) toBottom();
    },
    status() {
      if (!downBtn.classList.contains('hidden')) paintDown();
    },
    /** Whether tool call `id` runs: false while its OK waits, after a no, and for a start in the background. */
    runs(id) {
      const card = tools.get(id);
      return card ? card.runs() : true;
    },
    asks,
    /** Numbered events: { reset, events, first?, older? } */
    apply(r) {
      if (r.reset) {
        for (const m of [tools, asks, blocks, orphans]) m.clear();
        restartNote = null;
        fill(olderBox);
        fill(list);
        main = { root: list, group: null };
        first = r.events.length ? r.events[0].i : r.next || 0;
        paintMore(r.older ?? first > 0);
        if (!r.events.length && !(r.older ?? first > 0)) add(list, empty());
      } else if (r.events.length) list.querySelector('.chat-empty')?.remove();
      drawAll(r.events, main);
      if (!r.reset) announce(r.events);
      if (r.reset) toBottom(true);
      else if (r.events.length) follow();
    },
    /** The folder became known (the first state): paths drawn before it are said relative to it. */
    folder(cwd) {
      rePaths(list.parentNode || list, cwd);
    },
    /** Live deltas (never numbered). */
    live(evs) {
      for (const ev of evs) {
        if (ev.kind === 'text-delta' || ev.kind === 'thinking-delta') {
          const was = blocks.get(ev.blockId);
          if (was && was.final && was.kind === (ev.kind === 'text-delta' ? 'text' : 'thinking')) continue;
          list.querySelector('.chat-empty')?.remove();
          const el = liveBlock(ev.blockId, ev.kind === 'text-delta' ? 'text' : 'thinking', ev.agent);
          el.text += ev.text || '';
          if (ev.tokens) el.tokens = ev.tokens;
          paintBlock(el);
        } else if (ev.kind === 'tool-start') {
          let card = tools.get(ev.id);
          if (!card) {
            card = toolCard(ev, cardOpts());
            tools.set(ev.id, card);
            add(container(ev, main), card);
            follow();
          }
        } else if (ev.kind === 'tool-progress') tools.get(ev.id)?.progress(ev.elapsedS);
      }
    },
    /** What still streams, from the state (a page that came in the middle of a reply): the whole text so far. */
    liveState(items) {
      for (const b of items || []) {
        if (b.kind === 'text' || b.kind === 'thinking') {
          const el = blocks.get(b.blockId);
          if (el && el.final) continue;
          const live = liveBlock(b.blockId, b.kind, b.agent);
          if ((b.text || '').length >= live.text.length) {
            live.text = b.text || '';
            paintBlock(live);
          }
        } else if (b.kind === 'tool' && !tools.has(b.id)) this.live([{ kind: 'tool-start', id: b.id, name: b.name, title: b.title, toolKind: b.toolKind, agent: b.agent }]);
        if (b.kind === 'tool' && Number.isFinite(b.elapsedS)) tools.get(b.id)?.progress(b.elapsedS);
      }
    },
    /** The task table: each task on the card of the call that started it. */
    tasks(list2) {
      for (const t of list2 || []) if (t.toolId) tools.get(t.toolId)?.task(t);
    },
    /** Cards that no longer wait (answered elsewhere, or the turn ended) close. */
    pending(ids) {
      for (const [r, card] of asks) {
        if (ids.includes(r) || card.done) continue;
        const kind = card.classList.contains('chat-ask-plan') || card.classList.contains('chat-ask-question');
        if (!(!kind && foldCancelled(card))) card.closed('No longer waiting', false);
      }
    },
    /** The newest open card (number keys answer it). */
    openAsk() {
      return [...asks.values()].reverse().find((c) => !c.done) || null;
    },
    jump(toolId) {
      const card = tools.get(toolId);
      if (!card) return;
      card.open = true;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('chat-is-flash');
      setTimeout(() => card.classList.remove('chat-is-flash'), 1600);
    },
    toBottom,
  };
}
