// The composer, laid out as Claude Code's: the queued messages above the box (each with a remove), the files to
// send with the message (attach.js: the paperclip, a paste or a drop), the box with its "/" and "@" menus
// (popovers.js), Send (Enter on a desktop; while Claude works it queues) and Stop beside it while Claude works; under
// it the chips that change the chat at once: the permission mode (Shift+Tab goes to the next; bypass is marked), the
// model and the effort (Auto first in both) and ultracode, and the context ring. Up in an empty box brings back the
// last message (keys.js), Escape stops Claude.
import { icon } from '../icons.js';
import { api, chooseSheet, fill, h, openSheet, prefs, toast } from '../lib.js';
import { createAttachments } from './attach.js';
import { recall } from './keys.js';
import { createMenus } from './popovers.js';
import { MODE, canCompact, caps, contextPercent, effortName, kilo, modeChip, modeInfo, modeOf, modelName, nextMode, toolWord, touchScreen, turnRuns } from './words.js';

// Enter sends unless the screen is touched (a phone's Enter makes a new line; its Send button sends).
const finePointer = () => !touchScreen();

/** o: { A (the chat's API path), id, stop(), compact(), own() (the page's own / commands) } → { el, paint(v), focus(), … } */
export function createComposer(o) {
  const draftKey = `chat.draft.${o.id}`;
  const queueBox = h('ul.chat-queue', { 'aria-label': 'Queued messages' });
  const textarea = h('textarea.msg.chat-input', { rows: 1, 'aria-label': 'Message to Claude', enterkeyhint: finePointer() ? 'send' : 'enter' });
  const files = createAttachments({ A: o.A, changed: () => paintButtons() });
  const menus = createMenus({ textarea, A: o.A, own: () => o.own(), send: (text) => send(text) });
  const sent = recall({ get: () => prefs.get(`chat.sent.${o.id}`, []), set: (list) => prefs.set(`chat.sent.${o.id}`, list) });
  const fileInput = h('input.hidden', { type: 'file', multiple: true, tabindex: '-1', 'aria-hidden': 'true' });
  const attachBtn = h('button.btn.icon.ghost.chat-attachbtn', { type: 'button', 'aria-label': 'Attach files or pictures', title: 'Attach files or pictures (or paste or drop them)', onclick: () => fileInput.click() }, icon('paperclip'));
  const sendBtn = h('button.btn.primary.icon.chat-send', { type: 'button', 'aria-label': 'Send', title: 'Send', onclick: () => send() }, icon('send', { size: 20 }));
  const stopBtn = h('button.btn.danger.icon.chat-stop.hidden', { type: 'button', 'aria-label': 'Stop', title: 'Stop Claude (Esc; the turn ends, background agents go on)', onclick: () => o.stop() }, icon('stop', { size: 20 }));
  const modeBtn = h('button.chip.chat-chip.chat-modechip', { type: 'button', onclick: () => chooseMode() });
  const modelBtn = h('button.chip.chat-chip', { type: 'button', onclick: () => choose('model') });
  const effortBtn = h('button.chip.chat-chip', { type: 'button', onclick: () => choose('effort') });
  const ultraWord = h('span.chat-chip-v');
  const ultraBtn = h('button.chip.chat-chip.chat-ultra', { type: 'button', 'aria-pressed': 'false', title: 'Ultracode: Claude plans the work out to agents and workflows', onclick: () => toggleUltra() }, icon('grid', { size: 13 }), h('span.chat-chip-k', 'Ultracode'), ultraWord);
  const ring = h('button.chat-ring', { type: 'button', onclick: () => contextSheet() }, h('span.chat-ring-pie', { 'aria-hidden': 'true' }), h('span.chat-ring-text'));
  const chips = h('div.chat-chips', modeBtn, modelBtn, effortBtn, ultraBtn, h('span.chat-chips-gap'), ring);
  const el = h('div.chat-composer-wrap', menus.el, queueBox, files.el, h('div.chat-composer', attachBtn, textarea, sendBtn, stopBtn, fileInput), chips);
  let v = null;

  // ---------- the box ----------
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, Math.round(innerHeight * 0.3))}px`;
  };
  const setText = (t) => {
    textarea.value = t;
    textarea.setSelectionRange(t.length, t.length);
    prefs.set(draftKey, t);
    grow();
    paintButtons();
  };
  textarea.value = prefs.get(draftKey, '');
  textarea.addEventListener('input', () => {
    prefs.set(draftKey, textarea.value);
    grow();
    paintButtons();
    menus.update();
  });
  // The caret moved without typing (a click, the arrow keys): the menu follows it.
  textarea.addEventListener('click', () => menus.update());
  textarea.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') menus.update();
  });
  textarea.addEventListener('blur', () => setTimeout(() => document.activeElement !== textarea && menus.close(), 150));
  textarea.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (menus.key(e)) {
      e.preventDefault();
      e.stopPropagation(); // Escape closed the menu: it does not stop Claude too
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && finePointer()) {
      e.preventDefault();
      send();
    } else if (e.key === 'Tab' && e.shiftKey && v) {
      e.preventDefault();
      e.stopPropagation();
      setMode(nextMode(modeOf(v), v.choices ? v.choices.modes : undefined));
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && textarea.selectionStart === textarea.selectionEnd) {
      const atEdge = e.key === 'ArrowUp' ? !textarea.value.slice(0, textarea.selectionStart).includes('\n') : !textarea.value.slice(textarea.selectionEnd).includes('\n');
      const t = atEdge ? (e.key === 'ArrowUp' ? sent.up(textarea.value) : sent.down(textarea.value)) : null;
      if (t !== null) {
        e.preventDefault();
        setText(t);
      }
    }
  });
  textarea.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    // Text wins: an app that copies text often adds a picture of it too.
    if (!cd || !cd.files || !cd.files.length || cd.types.includes('text/plain')) return;
    e.preventDefault();
    files.take(cd.files);
  });

  async function send(given) {
    const text = given ?? textarea.value.replace(/\s+$/, '');
    if (!text) return textarea.focus();
    sendBtn.disabled = true;
    try {
      const attachments = given ? [] : await files.ready();
      await api(`${o.A}/send`, { text, ...(attachments.length ? { attachments } : {}) });
      sent.push(text);
      if (!given) {
        setText('');
        files.clear();
      }
      menus.close();
    } catch (e) {
      toast(`Not sent: ${e.message}`, { kind: 'error' });
    } finally {
      sendBtn.disabled = false;
      paintButtons();
      textarea.focus(); // the box keeps the focus (and a phone its keyboard) for the next message
    }
  }

  // ---------- the queue ----------
  function paintQueue(q) {
    fill(queueBox, (q || []).map((m) => h('li.chat-queued',
      icon('clock', { size: 14 }),
      h('span.chat-queued-text', m.text),
      h('span.chat-queued-state', m.state === 'sent' ? `${toolWord(v)} has it` : 'waiting'),
      h('button.btn.icon.ghost.chat-unqueue', { type: 'button', 'aria-label': `Remove the queued message: ${m.text.slice(0, 60)}`, title: 'Remove from the queue', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api(`${o.A}/unqueue`, { id: m.id });
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      } }, icon('x', { size: 16 })))));
  }

  fileInput.addEventListener('change', () => {
    files.take(fileInput.files);
    fileInput.value = '';
    textarea.focus();
  });

  // ---------- the chips ----------
  async function setMode(mode) {
    try {
      await api(`${o.A}/mode`, { mode }); // the chip shows it
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  async function chooseMode() {
    const now = modeOf(v);
    const pick = await chooseSheet({
      title: `What ${toolWord(v)} may do without asking`,
      subtitle: `Changes at once, also while ${toolWord(v)} works. Shift+Tab in the message box goes to the next.`,
      items: (v.choices ? v.choices.modes : Object.keys(MODE)).map((m) => {
        const w = modeInfo(v, m);
        return { value: m, label: w ? w.chip : modeChip(m), sub: w ? w.sub : '', current: m === now, danger: !!(w && w.danger) };
      }),
    });
    if (pick && pick !== now) setMode(pick);
  }
  async function choose(what) {
    const cur = v[what];
    const claude = toolWord(v) === 'Claude';
    const first = v.choices.models[0]; // another tool's Auto: the provider's own model, else this one
    const items = what === 'model'
      ? [{ value: '', label: 'Auto', sub: claude ? 'Claude Code\'s own model; each agent gets the model its task needs' : `The provider's own model when it names one, else the first it lists${first ? ` (${modelName(first)})` : ''}` }, ...v.choices.models.map((m) => ({ value: m, label: modelName(m) }))]
      : [{ value: '', label: 'Auto', sub: claude ? 'Claude Code\'s own effort; each agent gets the effort its task needs' : 'The model\'s own default' }, ...v.choices.efforts.map((e) => ({ value: e, label: effortName(e) }))];
    // Another tool's ultracode is its model's highest effort: while it is on, it decides, not this choice.
    const over = what === 'effort' && !claude && v.ultracode;
    const pick = await chooseSheet({
      title: what === 'model' ? 'Model' : `How hard ${toolWord(v)} thinks`,
      subtitle: what === 'model' ? 'Changes at once, in this chat. A new model reads the conversation again, which costs more once.' : over ? 'Ultracode is on: the model thinks as hard as it can, whatever is chosen here. Turn it off to use this choice.' : 'Changes at once, in this chat.',
      items: items.map((x) => ({ ...x, current: (x.value || null) === (cur || null) })),
    });
    if (pick === null || (pick || null) === (cur || null)) return;
    try {
      const r = await api(`${o.A}/settings`, { [what]: pick || null });
      if (r.restart) toast(`It takes effect when ${toolWord(v)} starts again with the next message`);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  async function toggleUltra() {
    try {
      await api(`${o.A}/settings`, { ultracode: !v.ultracode });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  function contextSheet() {
    const u = v.usage || {};
    const p = contextPercent(u);
    const who = toolWord(v);
    // Compact is Claude Code's: another coding tool's chat only says how full the context is.
    const compact = canCompact(v);
    openSheet({ title: 'Context', subtitle: `How much of what ${who} can keep in mind this conversation fills.` }, (close) => [
      h('p.sheet-text', p === null ? `Not known yet: it comes with ${who}'s next answer.` : `${p}% used${Number.isFinite(u.contextUsed) ? ` · ${kilo(u.contextUsed)} of ${kilo(u.contextWindow || 0)} tokens` : ''}.`),
      compact ? h('p.sheet-text', 'When it is nearly full Claude compacts by itself: it goes on from a summary of the conversation. Compact now to do that at a moment you choose.') : null,
      h('div.sheet-actions',
        h(`button.btn.${compact ? 'secondary' : 'primary'}`, { type: 'button', onclick: () => close() }, 'Close'),
        compact ? h('button.btn.primary', { type: 'button', onclick: () => {
          close();
          o.compact();
        } }, 'Compact now') : null),
    ]);
  }

  function paintButtons() {
    const busy = turnRuns(v); // background work alone is no turn: Send sends, and its Stop is in the agents strip
    const hasText = !!textarea.value.trim() || files.count() > 0;
    stopBtn.classList.toggle('hidden', !busy);
    // While Claude works: Stop is the main button; Send stays for a message to queue.
    sendBtn.classList.toggle('hidden', !!busy && !hasText);
    fill(sendBtn, icon(busy ? 'clock' : 'send', { size: 20 }));
    sendBtn.setAttribute('aria-label', busy ? 'Queue the message' : 'Send');
    sendBtn.title = busy ? `Queue: ${toolWord(v)} takes it at its next step` : 'Send';
  }

  return {
    el,
    textarea,
    focus: () => textarea.focus(),
    /** Text back into the box (a message taken back by Stop, the message a rewind went back to), before what is there. */
    putBack(text) {
      const t = String(text || '');
      if (!t) return;
      setText(textarea.value.trim() ? `${t}\n\n${textarea.value}` : t);
      textarea.focus();
    },
    /** Files dropped on the page, or chosen elsewhere: to go with the next message. */
    addFiles: (list) => {
      files.take(list);
      textarea.focus();
    },
    choose,
    chooseMode,
    nextMode: () => v && setMode(nextMode(modeOf(v), v.choices ? v.choices.modes : undefined)),
    paint(state) {
      v = state;
      const ro = !!v.terminal;
      textarea.disabled = ro;
      attachBtn.disabled = ro;
      if (ro) menus.close();
      const who = toolWord(v);
      textarea.setAttribute('aria-label', `Message to ${who}`);
      stopBtn.title = `Stop ${who} (Esc; the turn ends${caps(v).stopTask ? ', background agents go on' : ''})`;
      ultraBtn.classList.toggle('hidden', !caps(v).ultracode);
      ultraBtn.title = who === 'Claude' ? 'Ultracode: Claude plans the work out to agents and workflows' : 'Ultracode: the model thinks as hard as it can';
      const words = ro ? 'Read only while the terminal runs this conversation'
        : turnRuns(v) ? 'Queue a message…'
          : finePointer() ? `Message ${who} · / commands · @ files · Shift+Tab mode · /help keys` : `Message ${who} · / commands · @ files`;
      if (textarea.placeholder !== words) {
        textarea.placeholder = words;
        grow(); // an empty box is as high as its placeholder
      }
      paintQueue(v.queue);
      paintButtons();
      const mode = modeOf(v);
      const mw = modeInfo(v, mode);
      const chip = mw ? mw.chip : modeChip(mode);
      modeBtn.classList.toggle('chat-is-danger', !!(mw && mw.danger));
      fill(modeBtn, icon(mw && mw.danger ? 'alert' : 'lock', { size: 13 }), h('span', chip));
      modeBtn.setAttribute('aria-label', `Permission mode: ${chip}. Change it`);
      fill(modelBtn, icon('sparkle', { size: 13 }), h('span.chat-chip-k', 'Model'), h('span', v.model ? modelName(v.model) : 'Auto'));
      modelBtn.setAttribute('aria-label', `Model: ${v.model ? modelName(v.model) : 'Auto'}. Change it`);
      // Another tool's ultracode is the model's highest effort: the chip says so instead of a choice it overrides.
      const effortNow = v.ultracode && who !== 'Claude' ? 'Highest (ultracode)' : v.effort ? effortName(v.effort) : 'Auto';
      fill(effortBtn, icon('zap', { size: 13 }), h('span.chat-chip-k', 'Effort'), h('span', effortNow));
      effortBtn.setAttribute('aria-label', `Effort: ${effortNow}. Change it`);
      ultraBtn.setAttribute('aria-pressed', String(!!v.ultracode));
      fill(ultraWord, v.ultracode ? 'on' : 'off'); // said in words, not only by its colour
      const p = contextPercent(v.usage);
      ring.classList.toggle('hidden', p === null);
      ring.classList.toggle('chat-is-low', p !== null && p >= 85);
      ring.style.setProperty('--p', String(p || 0));
      fill(ring.querySelector('.chat-ring-text'), p === null ? '' : `${p}%`);
      ring.setAttribute('aria-label', p === null ? 'Context' : `Context ${p}% used. Compact`);
    },
  };
}
