// The conversation as it happens: the numbered events of the chat (src/chat/events.mjs) drawn once each, in turns
// (a message of the owner, or a turn Claude starts by itself, and everything up to its end); text that streams and
// is replaced by its final block (same block id); thinking folded with its time; tool cards (tools.js) with a
// subagent's steps inside the call that started it; cards that wait for the owner (asks.js); "Show earlier"; and the
// view stays at the bottom unless the owner scrolled up.
import { icon } from '../icons.js';
import { add, api, fill, h, toast } from '../lib.js';
import { mdView } from '../mdtext.js';
import { OUTCOME, askCard } from './asks.js';
import { toolCard } from './tools.js';
import { took, turnLine } from './words.js';

const NEAR_PX = 120;

/** o: { scroll (the scrolling element), A (the chat's API path), cwd(), stopTask(id), after() } */
export function createTimeline(o) {
  const moreSlot = h('div.chat-moreslot');
  const olderBox = h('div.chat-older');
  const list = h('div.chat-list');
  const downBtn = h('button.btn.small.primary.chat-down.hidden', { type: 'button', onclick: () => toBottom(true) }, icon('down', { size: 16 }), h('span', 'New messages'));
  const tools = new Map(); // tool call id → its card
  const asks = new Map(); // request id → its card
  const blocks = new Map(); // block id → its element (live while it streams, then final)
  const orphans = new Map(); // agent id → where its steps go when its call is not drawn (an earlier window)
  let main = { root: list, group: null }; // where new events go
  let first = 0; // the number of the first event drawn
  let stick = true;
  let asked = false; // a card that waits for the owner came while the view was scrolled up

  // ---------- where an event goes ----------
  function group(at, { auto = false } = {}) {
    at.group = h('section.chat-turn', auto ? h('p.chat-auto', icon('refresh', { size: 13 }), h('span', 'Claude went on by itself: a background task ended')) : null);
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
    const peek = h('span.chat-think-peek');
    const body = h('div.chat-think-body');
    const el = h('details.chat-item.chat-think', h('summary', icon('sparkle', { size: 14 }), head, peek), body);
    Object.assign(el, { head, peek, body, kind: 'thinking', agent });
    fill(head, 'Thinking…');
    return el;
  }
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
          if (b.kind === 'text') fill(b, mdView(b.text));
          else {
            fill(b.body, b.text);
            fill(b.peek, b.final ? '' : b.text.slice(-90).replace(/\s+/g, ' '));
          }
        }
        pending.clear();
        follow();
      });
    }
  }
  function liveBlock(blockId, kind, agent, at = main) {
    let el = blocks.get(blockId);
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
        const files = Array.isArray(ev.attachments) ? ev.attachments : [];
        return add(g, h('div.chat-item.chat-user', { dataset: { message: ev.messageId || '' } }, ev.text,
          files.length ? h('div.chat-files', files.map((f) => h('span.chip.small', icon(f.type === 'image' ? 'sparkle' : 'paperclip', { size: 12 }), f.name || (f.type === 'image' ? 'picture' : 'file')))) : null));
      }
      case 'turn-start':
        if (ev.auto) group(at, { auto: true });
        else groupOf(at);
        return null;
      case 'text':
      case 'thinking': {
        let el = blocks.get(ev.blockId);
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
          fill(el.body, el.text || h('span.chat-hint', 'Claude did not show what it thought.'));
          fill(el.peek);
        } else fill(el, mdView(el.text));
        return el;
      }
      case 'tool': {
        let card = tools.get(ev.id);
        if (card) card.finish(ev);
        else {
          card = toolCard(ev, { cwd: o.cwd(), stopTask: o.stopTask });
          tools.set(ev.id, card);
          add(container(ev, at), card);
        }
        return card;
      }
      case 'tool-result':
        tools.get(ev.id)?.result(ev);
        return null;
      case 'ask': {
        // Always in the main conversation, where it is seen, even when an agent asks.
        const card = askCard(ev, { A: o.A, cwd: o.cwd(), after: o.after });
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
        card.closed(plan ? (ok ? 'Approved' : ev.outcome === 'denied' ? 'Keep planning' : text) : question && ok ? 'Answered' : text, ok);
        return null;
      }
      case 'turn-end': {
        const g = groupOf(at);
        if (ev.ok) {
          const t = turnLine(ev);
          if (t) add(g, h('p.chat-item.chat-turnend', icon('check', { size: 13 }), h('span', t)));
        } else if (ev.stopped || ev.subtype === 'stopped' || ev.subtype === 'error_during_execution' || ev.error === 'stopped') add(g, h('p.chat-item.chat-note', 'Stopped.'));
        else add(g, h('div.chat-item.banner.error-box', { role: 'alert' }, icon('alert', { size: 18 }), h('span', ev.error || 'The reply ended with an error.')));
        at.group = null;
        return null;
      }
      case 'session-changed':
        at.group = null;
        return add(at.root, h('div.chat-item.chat-divider', h('span', ev.reason === 'compact' ? 'Conversation compacted: Claude goes on from a summary' : ev.reason === 'clear' ? 'Conversation cleared' : 'A new conversation')));
      case 'notice':
        return add(groupOf(at), h(`p.chat-item.chat-note${ev.level === 'error' ? '.chat-is-err' : ''}`, ev.text));
      default:
        return null;
    }
  }
  const drawAll = (events, at) => {
    for (const ev of events) draw(ev, at);
  };

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
    fill(downText, asked ? 'Claude needs your OK' : 'New messages');
    downBtn.classList.remove('hidden');
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
      paintMore(r.events.length > 0 && first > r.base);
      o.scroll.scrollTop += o.scroll.scrollHeight - h0; // what was on screen stays where it was
    } catch (e) {
      btn.disabled = false;
      toast(e.message, { kind: 'error' });
    }
  }

  const empty = () => h('div.chat-empty', icon('text', { size: 26 }), h('p', 'Write what Claude should do in this project. It works here as in the terminal: it reads, edits and runs commands, and asks you before anything that needs your OK.'));

  return {
    el: h('div.chat-col.chat-timeline', moreSlot, olderBox, list),
    downBtn,
    asks,
    /** Numbered events: { reset, events, first?, older? } */
    apply(r) {
      if (r.reset) {
        for (const m of [tools, asks, blocks, orphans]) m.clear();
        fill(olderBox);
        fill(list);
        main = { root: list, group: null };
        first = r.events.length ? r.events[0].i : r.next || 0;
        paintMore(r.older ?? first > 0);
        if (!r.events.length && !(r.older ?? first > 0)) add(list, empty());
      } else if (r.events.length) list.querySelector('.chat-empty')?.remove();
      drawAll(r.events, main);
      if (r.reset) toBottom(true);
      else if (r.events.length) follow();
    },
    /** Live deltas (never numbered). */
    live(evs) {
      for (const ev of evs) {
        if (ev.kind === 'text-delta' || ev.kind === 'thinking-delta') {
          if (blocks.get(ev.blockId)?.final) continue;
          list.querySelector('.chat-empty')?.remove();
          const el = liveBlock(ev.blockId, ev.kind === 'text-delta' ? 'text' : 'thinking', ev.agent);
          el.text += ev.text || '';
          if (ev.tokens) el.tokens = ev.tokens;
          paintBlock(el);
        } else if (ev.kind === 'tool-start') {
          let card = tools.get(ev.id);
          if (!card) {
            card = toolCard(ev, { cwd: o.cwd(), stopTask: o.stopTask });
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
      for (const [r, card] of asks) if (!ids.includes(r) && !card.done) card.closed('No longer waiting', false);
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
