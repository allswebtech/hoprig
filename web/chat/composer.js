// The composer, one rounded box as Claude Code's: the field on top and ONE row inside the box. The row: + (the files
// to send, attach.js: a paste or a drop too, and the "/" and "@" menus, popovers.js), then on a phone ONE pill that says
// the mode, the model and what is on and opens the sheet This session (the mode, model, effort, Ultracode, Lead model and
// the context with Compact), on a wide screen the chips (the permission mode, Ultracode and Lead, Hoprig's own, the
// model with its effort, and the usage ring); then the microphone and ONE round Send or Stop (Enter on a desktop, also
// while Claude works: it reads the message after its current step). The messages sent while Claude works are drawn
// by this file too (queueEl: the page puts it into the conversation, where they will be read; each can be taken back
// until then). A message that did not arrive says so with Retry. The menus open at their control (menu.js). Up in an
// empty box brings back the last message (keys.js), Escape stops Claude.
import { icon } from '../icons.js';
import { api, fill, h, openSheet, prefs, toast, until } from '../lib.js';
import { createAttachments, messageFiles, queuedLine } from './attach.js';
import { bangOf, createShellRuns } from './bang.js';
import { recall } from './keys.js';
import { FIRST_PLACEHOLDER, FIRST_PLACEHOLDER_SHORT, NARROW_BOX, doneFirstChat, isFirstChat } from './firstchat.js';
import { asSheet, closeMenu, openMenu } from './menu.js';
import { createMenus, ownSlash } from './popovers.js';
import { micButton } from '../voice.js';
import { askOnce } from '../allowall.js';
import { MODE, backWords, boxWords, canCompact, modeMenu, caps, contextPercent, effortName, failText, hasPlan, kilo, modeChip, modeInfo, modeOf, modelName, modelWords, nextMode, planWindows, ringOf, toolWord, touchScreen, turnRuns, modelSub } from './words.js';

// Enter sends unless the screen is touched (a phone's Enter makes a new line; its Send button sends).
const finePointer = () => !touchScreen();

// The pill's colour by mode (a mode this page does not know is amber; its own flag for a risky one makes it red).
const MODE_TONE = { bypassPermissions: 'danger', acceptEdits: 'warn', auto: 'warn', plan: 'plan' };
/**
 * What the phone's pill says, as parts: the mode when it is not Manual (in its colour), then the model, then Ultracode and
 * Lead only when they are on. "Bypass · Fable · Ultracode"; Manual shows just the model. → [{ k, text, tone? }]
 */
export function pillParts(v) {
  const mode = modeOf(v);
  const info = modeInfo(v, mode);
  const parts = [];
  if (mode && mode !== 'manual') parts.push({ k: 'mode', text: modeChip(mode).replace(/ permissions$/i, ''), tone: info && info.danger ? 'danger' : MODE_TONE[mode] || 'warn' });
  parts.push({ k: 'model', text: v && v.model ? modelName(v.model) : 'Auto' });
  if (v && v.ultracode && caps(v).ultracode) parts.push({ k: 'ultra', text: 'Ultracode' });
  if (v && v.lead && v.engine && v.engine.id === 'claude') parts.push({ k: 'lead', text: 'Lead' });
  return parts;
}

/** o: { A (the chat's API path), id, stop(), compact(), own() (the page's own / commands) } → { el, queueEl, paint(v), focus(), … } */
export function createComposer(o) {
  const draftKey = `chat.draft.${o.id}`;
  const queueBox = h('ul.chat-queue', { 'aria-label': 'Messages sent while Claude works' }); // the page puts it into the conversation
  const textarea = h('textarea.msg.chat-input', { rows: 1, 'aria-label': 'Message', enterkeyhint: finePointer() ? 'send' : 'enter' });
  const files = createAttachments({ A: o.A, changed: () => paintButtons() });
  const shell = createShellRuns({ A: o.A, changed: () => paintButtons() }); // "!" lines (bang.js)
  const menus = createMenus({ textarea, A: o.A, own: () => o.own(), send: (text) => send(text), closed: () => giveBack() });
  const sent = recall({ get: () => prefs.get(`chat.sent.${o.id}`, []), set: (list) => prefs.set(`chat.sent.${o.id}`, list) });
  const fileInput = h('input.hidden', { type: 'file', multiple: true, tabindex: '-1', 'aria-hidden': 'true' });
  // The + menu, as the desktop app's: Add files or photos, Slash commands (its Add folder, Connectors and Plugins are
  // not Hoprig's: the parity table says why).
  const plusBtn = h('button.btn.icon.ghost.chat-plus', { type: 'button', 'aria-label': 'Add files or photos, slash commands', title: 'Add files or photos, slash commands', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => plusMenu() }, icon('plus'));
  const sendBtn = h('button.btn.primary.icon.chat-send', { type: 'button', 'aria-label': 'Send', title: 'Send', onclick: () => send() }, icon('send', { size: 18 }));
  const stopBtn = h('button.btn.icon.chat-stop.hidden', { type: 'button', 'aria-label': 'Stop', title: 'Stop', onclick: () => o.stop() }, icon('stop', { size: 18 }));
  const modeBtn = h('button.chip.chat-chip.chat-modechip', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => chooseMode() });
  const modelBtn = h('button.chip.chat-chip.chat-modelchip', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => choose('model') });
  const ultraWord = h('span.chat-chip-v');
  const ultraBtn = h('button.chip.chat-chip.chat-ultra', { type: 'button', 'aria-pressed': 'false', title: 'Ultracode: Claude plans the work out to agents and workflows', onclick: () => toggleUltra() }, icon('grid', { size: 13 }), h('span.chat-chip-k', 'Ultracode'), ultraWord);
  // Lead model: on or off for this session, said in words; its line (which model does which kind) is its title, and a
  // press turns it on or off from the next start (the settings route).
  const leadWord = h('span.chat-chip-v');
  const leadBtn = h('button.chip.chat-chip.chat-lead', { type: 'button', 'aria-pressed': 'false', onclick: () => toggleLead() }, icon('stack', { size: 13 }), h('span.chat-chip-k', 'Lead'), leadWord);
  const ring = h('button.chat-ring', { type: 'button', onclick: () => usageSheet() }, h('span.chat-ring-pie', { 'aria-hidden': 'true' }), h('span.chat-ring-text'));
  // The desktop's order: the mode at the left, the model picker toward the right with the ring next to it; ultracode and Lead
  // are Hoprig's own and sit just left of the model chip.
  const chips = h('div.chat-chips', modeBtn, h('span.chat-chips-gap'), ultraBtn, leadBtn, modelBtn, ring);
  // A phone has no room for the chips: ONE pill says what matters and opens the sheet This session (settingsSheet).
  const pillBtn = h('button.chat-setpill', { type: 'button', 'aria-haspopup': 'dialog', onclick: () => settingsSheet() });
  // Speak instead of typing: the words go into the box, and the owner sends them (voice.js).
  const mic = micButton(textarea);
  // A message that did not arrive: why, and Retry (its words and files are still in the box).
  const unsent = h('div.chat-unsent.hidden', { role: 'alert' });
  // The box: the field on top, one row inside it (the pill on a phone, the chips on a wide screen: styles show one).
  const box = h('div.chat-composer.chat-box', textarea, h('div.chat-box-row', plusBtn, pillBtn, chips, h('span.chat-row-gap'), mic.el, sendBtn, stopBtn, fileInput));
  const el = h('div.chat-composer-wrap', menus.el, shell.el, files.el, unsent, mic.note, box);
  let v = null;
  // A message is on its way (its files upload, then POST /send): Send, Enter and a "/" command wait for it. The box
  // is emptied only when the POST returns, so a second tap before that would send the same message twice.
  let sending = false;
  // Read only: the conversation runs in a terminal or its coding tool is off. One rule for the box and for Send.
  const readOnly = () => !!(v && (v.terminal || v.toolOff));
  const paintSend = () => {
    sendBtn.disabled = sending || readOnly();
  };

  // ---------- the box ----------
  // The words in the box while the + menu's Slash commands lists the commands: put aside, never sent with a command or
  // emptied by one. They live only while the box holds a / line: back in the box when the list closes on a command
  // start alone ("/", "/br": in its place), once a command line written out was sent, and as soon as the box holds no
  // / line any more (before what was typed there). So a word typed after them is never lost from the saved draft.
  let aside = null;
  const slashStart = (t) => t === '' || /^\/\S*$/.test(t);
  // The saved draft (a reload keeps it): the box as it shows, with the words put aside before a command line written out.
  const draftOf = (t) => (aside === null ? t : slashStart(t) ? aside : `${aside}\n\n${t}`);
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.round(innerHeight * 0.3))}px`;
  };
  const shellLook = () => el.classList.toggle('chat-shell-mode', textarea.value.startsWith('!')); // "!": a shell command (bang.js)
  const setText = (t) => {
    textarea.value = t;
    textarea.setSelectionRange(t.length, t.length);
    shellLook(); // a box emptied or filled without typing (Esc Esc, Up, a send) looks as its words are
    prefs.set(draftKey, draftOf(t));
    grow();
    paintButtons();
  };
  function giveBack(sentNow = false) {
    if (aside === null) return;
    const now = textarea.value;
    if (!sentNow && now.startsWith('/') && !slashStart(now)) return; // a command line written out: back once it is sent
    const t = aside;
    aside = null;
    setText(sentNow || slashStart(now) ? t : `${t}\n\n${now}`);
  }
  textarea.value = prefs.get(draftKey, '');
  textarea.addEventListener('input', () => {
    if (aside !== null && !textarea.value.startsWith('/')) giveBack(); // the / line is gone: the words put aside are back
    shellLook();
    prefs.set(draftKey, draftOf(textarea.value));
    grow();
    paintButtons();
    menus.update();
  });
  // "Attach as context" on a path in a reply (pathmenu.js): its @path goes into the box, for the owner to send.
  const attachPath = (e) => {
    const p = e && e.detail && typeof e.detail.path === 'string' ? e.detail.path.trim() : '';
    if (!p || readOnly()) return;
    const t = textarea.value;
    setText(`${t}${t && !/\s$/.test(t) ? ' ' : ''}@${p} `);
    textarea.focus();
  };
  document.addEventListener('chat-attach-path', attachPath);
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
      // Up in an empty box: the last message waiting to be read comes back to be changed (Claude Code's own key).
      if (e.key === 'ArrowUp' && !textarea.value && queued.length) {
        e.preventDefault();
        const m = queued[queued.length - 1];
        return takeBack(m, queuedLine(m), true);
      }
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
    if (sending) return;
    const typed = given ?? textarea.value.replace(/\s+$/, '');
    // Enter with words (a message, a "!" line, a / command): the microphone stops first, so nothing heard later is
    // written into the box that is about to be emptied.
    if (!given && typed) mic.stop();
    // "!" before the line: a shell command in the folder; its output goes with the next message (bang.js).
    // One of the page's own commands, also with its argument (/model sonnet): the page does it, nothing is sent.
    const mine = given === undefined ? ownSlash(typed, o.own()) : null;
    if (mine) {
      menus.close();
      const done = mine.arg && mine.cmd.arg ? mine.cmd.arg(mine.arg) : mine.cmd.run();
      if (done === false) return textarea.focus(); // refused at once (/model with a name the chat lacks): the text stays
      sent.push(typed);
      setText('');
      giveBack(true);
      return done;
    }
    const cmd = given === undefined ? bangOf(typed) : null;
    if (cmd) {
      // One at a time: the line stays in the box until the one that runs has ended.
      if (shell.running()) return toast(`A command runs already: wait for its output, or stop it${finePointer() ? ' (Esc)' : ''}`, { kind: 'error' });
      sent.push(typed);
      setText('');
      return shell.run(cmd);
    }
    // A slash command goes alone (in front of it the runs would make it plain text): the runs wait for the next message.
    const lead = given === undefined && shell.count() && !typed.startsWith('/') ? shell.text() : '';
    const text = lead ? (typed ? `${lead}\n\n${typed}` : lead) : typed;
    if (!text) return textarea.focus();
    if (!given) mic.stop();
    sending = true;
    showUnsent(null);
    paintSend();
    try {
      const attachments = given ? [] : await files.ready();
      await api(`${o.A}/send`, { text, ...(attachments.length ? { attachments } : {}) });
      if (typed) sent.push(typed);
      if (firstChat()) {
        doneFirstChat(); // the first message is sent: an ordinary chat from here
        paintFirst();
        paintPlaceholder();
        if (v) {
          ring.classList.toggle('hidden', !ringOf(v));
        }
      }
      if (!given) {
        setText('');
        files.clear();
        if (lead) shell.clear();
        giveBack(true);
      }
      menus.close();
      if (o.sent) o.sent();
    } catch (e) {
      // The words stay in the box (only a message that arrived empties it); Retry sends them again.
      showUnsent(failText(e), given);
    } finally {
      sending = false;
      paintSend();
      paintButtons();
      textarea.focus(); // the box keeps the focus (and a phone its keyboard) for the next message
    }
  }

  function showUnsent(why, given) {
    unsent.classList.toggle('hidden', !why);
    if (!why) return fill(unsent);
    fill(unsent, icon('alert', { size: 16 }), h('span.chat-unsent-text', `Not sent: ${why}`),
      h('button.btn.small.secondary', { type: 'button', onclick: () => send(given) }, icon('refresh', { size: 14 }), h('span', 'Retry')),
      h('button.btn.icon.ghost.small', { type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => showUnsent(null) }, icon('x', { size: 14 })));
  }

  // ---------- the messages sent while Claude works ----------
  /** Text back into the box, before what is there (a message taken back, the message a rewind went back to). */
  function putText(text) {
    const t = String(text || '');
    if (!t) return;
    setText(textarea.value.trim() ? `${t}\n\n${textarea.value}` : t);
    textarea.focus();
  }
  // Short in the line; the long words are its title.
  const QUEUED_STATE = 'Queued · read after this step';
  const QUEUED_TITLE = () => `Not read yet: ${toolWord(v)} reads it after its current step`;
  const opened = new Set(); // the queued messages shown whole ("Show all")
  let queued = [];
  let queueKey = '';
  // Take a message back before it is read: Remove drops it, Edit puts its words back in the box (its files are said,
  // as after Stop: they are attached again).
  async function takeBack(m, line, edit) {
    try {
      await api(`${o.A}/unqueue`, { id: m.id });
    } catch (err) {
      return toast(failText(err), { from: err, kind: 'error' });
    }
    if (!edit) return;
    putText(line.text);
    if (line.names.length) toast(backWords(1, line.names.length));
  }
  function paintQueue(q) {
    queued = Array.isArray(q) ? q : [];
    // The state comes often: only a change of the queue (or of one message's "Show all") is drawn again.
    const key = JSON.stringify([queued.map((m) => [m.id, m.text, m.state, (m.attachments || []).length, opened.has(m.id)]), toolWord(v)]);
    if (key === queueKey) return;
    queueKey = key;
    // As its bubble will read, faded and dashed: its words and its files (attach.js queuedLine), never the upload paths.
    fill(queueBox, queued.map((m) => [m, queuedLine(m)]).map(([m, line]) => {
      const long = line.text.length > 180 || line.text.split('\n').length > 3;
      const whole = opened.has(m.id);
      return h('li.chat-queued',
        h('div.chat-queued-bubble', h(`div.chat-queued-text${long && !whole ? '.chat-queued-clip' : ''}`, line.text), messageFiles(line.files, o.A),
          long ? h('button.chat-queued-more', { type: 'button', 'aria-expanded': String(whole), onclick: () => {
            if (opened.has(m.id)) opened.delete(m.id);
            else opened.add(m.id);
            paintQueue(queued);
          } }, whole ? 'Show less' : 'Show all') : null),
        h('div.chat-queued-foot',
          h('span.chat-queued-state', { title: QUEUED_TITLE() }, QUEUED_STATE),
          h('span.chat-queued-acts',
            h('button.chat-queued-act.chat-edit-queued', { type: 'button', 'aria-label': `Edit the message: ${line.label.slice(0, 60)}`, title: 'Take it back into the box to change it', onclick: () => takeBack(m, line, true) }, 'Edit'),
            h('button.btn.icon.ghost.chat-unqueue', { type: 'button', 'aria-label': `Take back the message: ${line.label.slice(0, 60)}`, title: 'Take back: it is not read yet', onclick: (e) => {
              e.currentTarget.disabled = true;
              takeBack(m, line, false);
            } }, icon('x', { size: 16 })))));
    }));
  }

  fileInput.addEventListener('change', () => {
    files.take(fileInput.files);
    fileInput.value = '';
    textarea.focus();
  });

  // The box's placeholder (words.js boxWords): short enough for one line also beside the diff pane.
  function paintPlaceholder() {
    if (!v) return;
    const narrow = touchScreen() || (textarea.clientWidth > 0 && textarea.clientWidth < NARROW_BOX);
    const words = firstChat() && !readOnly() ? (narrow ? FIRST_PLACEHOLDER_SHORT : FIRST_PLACEHOLDER) : boxWords(v, { readOnly: readOnly(), touch: touchScreen() });
    if (textarea.placeholder !== words) {
      textarea.placeholder = words;
      grow(); // an empty box is as high as its placeholder
    }
  }

  // ---------- the chips ----------
  async function setMode(mode) {
    try {
      const r = await api(`${o.A}/mode`, { mode }); // the chip shows it
      if (r && r.restart) toast(`${modeChip(mode)} starts when ${toolWord(v)} starts again with the next message`);
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  }
  const allState = {};
  // A phone (under 600 px) shows the pill, not the chips: a menu opens at the pill, and a change is said in a toast there.
  const phone = () => typeof innerWidth === 'number' && innerWidth < 600;
  const anchorOf = (chip) => (phone() ? pillBtn : chip);
  const said = (text) => phone() && toast(text);
  async function chooseMode({ sheet = false } = {}) {
    if (!v) return;
    const now = modeOf(v);
    const item = (m) => {
      const w = modeInfo(v, m);
      return { value: m, label: w ? w.chip : modeChip(m), sub: w ? w.sub : '', current: m === now, danger: !!(w && w.danger) };
    };
    // The desktop app's order; a mode it does not offer (don't ask) waits under "More modes", never gone.
    const { main, rare } = modeMenu(v.choices ? v.choices.modes : Object.keys(MODE));
    const pick = await openMenu({
      from: anchorOf(modeBtn), sheet, label: 'Permission mode', title: `What ${toolWord(v)} may do without asking`,
      subtitle: v.modeLater ? `${modeChip(v.modeLater)} starts with the next message.` : `Changes at once, also while ${toolWord(v)} works.`,
      sections: [{ items: main.map(item) }, { label: 'More modes', items: rare.map(item) }],
    });
    // Allow everything: the first time on this computer he is asked once (web/allowall.js), then it is a mode like the others.
    if (pick && pick !== now && (pick !== 'allowEverything' || (await askOnce(allState)))) {
      said(`Permission mode: ${modeChip(pick)}`);
      setMode(pick);
    }
  }
  /**
   * /model <id> and /effort <level>, typed: the same route as the chip's menu. "auto" (or "default") is Auto; a name the
   * chat does not offer is refused with the list, at once: → false (the box keeps the line), else a Promise.
   */
  function setChoice(what, word) {
    const list = what === 'model' ? (v && v.choices && v.choices.models) || [] : (v && v.choices && v.choices.efforts) || [];
    const w = String(word).trim().toLowerCase();
    const pick = w === 'auto' || w === 'default' ? null : list.find((x) => x.toLowerCase() === w || modelName(x).toLowerCase() === w || effortName(x).toLowerCase() === w);
    if (pick === undefined) {
      toast(`No ${what} "${word}" here. Choose one of: auto, ${list.join(', ')}`, { kind: 'error' });
      return false;
    }
    return saveChoice(what, pick);
  }
  async function saveChoice(what, pick) {
    try {
      const r = await api(`${o.A}/settings`, { [what]: pick });
      toast(r && r.restart ? `It takes effect when ${toolWord(v)} starts again with the next message` : `${what === 'model' ? 'Model' : 'Effort'}: ${what === 'model' ? modelName(pick) : effortName(pick)}`);
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  }
  /**
   * The model menu, as the desktop app's model picker: the models, then its Effort section. what: 'model' or 'effort'
   * (the keyboard starts in that section: /effort and Ctrl+Shift+E open the same menu at Effort). byKey: a desktop key
   * asked (with the menu open, its key for the other section moves there).
   */
  async function choose(what, { byKey = false, sheet = false } = {}) {
    if (!v || !v.choices) return;
    const claude = toolWord(v) === 'Claude';
    const first = v.choices.models[0]; // another tool's Auto: the provider's own model, else this one
    const mark = (x, cur) => ({ ...x, current: (x.v || null) === (cur || null) });
    const models = [{ v: '', label: 'Auto', sub: claude ? 'Claude Code\'s own model; each agent gets the model its task needs' : `The provider's own model when it names one, else the first it lists${first ? ` (${modelName(first)})` : ''}` }, ...v.choices.models.map((m) => ({ v: m, label: modelName(m), sub: modelSub(m, v.choices) }))]
      .map((x) => ({ ...mark(x, v.model), value: `model:${x.v}` }));
    // Another tool's ultracode is its model's highest effort: while it is on, it decides, not this choice.
    const over = !claude && v.ultracode;
    const efforts = [{ v: '', label: 'Auto', sub: claude ? 'Claude Code\'s own effort; each agent gets the effort its task needs' : 'The model\'s own default' }, ...v.choices.efforts.map((e) => ({ v: e, label: effortName(e) }))]
      .map((x) => ({ ...mark(x, v.effort), value: `effort:${x.v}` }));
    const pick = await openMenu({
      from: anchorOf(modelBtn), sheet, label: 'Model and effort', at: what === 'effort' ? 1 : 0, key: byKey, title: what === 'effort' ? 'Effort' : 'Model and effort',
      subtitle: 'Changes at once, in this session. A new model reads the conversation again, which costs more once.',
      sections: [{ label: 'Model', items: models }, { label: over ? 'Effort (ultracode is on: the highest)' : 'Effort', items: efforts }],
    });
    if (!pick) return;
    const [key, ...rest] = pick.split(':');
    const value = rest.join(':') || null;
    if ((value || null) === (v[key] || null)) return;
    try {
      const r = await api(`${o.A}/settings`, { [key]: value });
      said(key === 'model' ? `Model: ${modelName(value)}` : `Effort: ${effortName(value)}`);
      if (r.restart) toast(`It takes effect when ${toolWord(v)} starts again with the next message`);
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  }
  async function toggleLead() {
    try {
      const r = await api(`${o.A}/settings`, { lead: !v.lead });
      toast(`Lead model ${v.lead ? 'off' : 'on'}${r && r.restart ? ` from when ${toolWord(v)} starts again with the next message` : ''}`);
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  }
  async function plusMenu() {
    if (readOnly()) return;
    const pick = await openMenu({
      from: plusBtn, label: 'Add', title: 'Add',
      sections: [{ items: [
        { value: 'files', label: 'Add files or photos', sub: 'Or paste or drop them on the page', icon: 'paperclip' },
        { value: 'slash', label: 'Slash commands', sub: 'Commands and skills, as / at the start of the box', icon: 'text' },
        // On a first look Ultracode and Lead are not in the chip row (tucked): they are here, each line the press it is
        // (Turn on …), with its state in the sub line.
        ...(tucked() && !phone() && caps(v).ultracode ? [{ value: 'ultra', label: 'Turn on Ultracode', sub: `Off now. ${ultraBtn.title.replace(/^Ultracode: /, '')}; it uses more of your plan or money.`, icon: 'grid' }] : []),
        ...(tucked() && !phone() && canLead() ? [{ value: 'lead', label: 'Turn on Lead model', sub: 'Off now: the model you chose does every part. On, it hands parts to faster and stronger models.', icon: 'stack' }] : []),
      ] }],
    });
    if (pick === 'files') fileInput.click();
    else if (pick === 'ultra') toggleUltra();
    else if (pick === 'lead') toggleLead();
    else if (pick === 'slash') {
      // To browse the commands: the box shows "/" alone; words written there wait aside (giveBack), untouched.
      if (!textarea.value.startsWith('/')) {
        if (textarea.value.trim()) aside = textarea.value;
        setText('/');
      }
      textarea.focus();
      textarea.setSelectionRange(1, 1);
      menus.update();
    }
  }
  // A first look (o.firstLook: fewer than three chats on this computer) keeps the row to what a newcomer needs:
  // Ultracode and Lead go behind + while both are off; one that is on stays in the row, so its state is in view.
  const canLead = () => !!(v && v.engine && v.engine.id === 'claude');
  const tucked = () => !!(v && o.firstLook && o.firstLook() && !v.ultracode && !v.lead);
  // The first chat of a new install (firstchat.js): the box says what to do, and the row keeps to the mode (the model
  // and the ring come with the next chat), until the first message is sent.
  const firstChat = () => !!(v && isFirstChat() && o.firstLook && o.firstLook());
  const paintFirst = () => {
    const f = firstChat();
    modelBtn.classList.toggle('hidden', f);
    if (f) ring.classList.add('hidden');
  };
  async function toggleUltra() {
    try {
      await api(`${o.A}/settings`, { ultracode: !v.ultracode });
      said(`Ultracode ${v.ultracode ? 'off' : 'on'}`);
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  }
  /**
   * The ring's sheet: the plan's usage where the ring shows it (each window, when it starts again), and the context. On a
   * subscription the running coding tool is asked (GET /usage, no model request): the ring shows Context until the
   * plan's usage is known, and the press is what makes it known (a phone has no rail to ask it). The sheet opens at
   * once with what is known and says it asks; the answer (the tool may take up to 15 s) fills it in. Every press opens
   * the sheet at once, also one after the sheet was closed while the ask ran: there is one ask at a time (usageAsk), and
   * its answer fills the newest sheet.
   */
  let usageAsk = null;
  async function usageSheet() {
    const ask = hasPlan(v) && caps(v).usage && v.running;
    const who = toolWord(v);
    const compact = canCompact(v); // Compact is Claude Code's: another coding tool's chat only says how full the context is
    const planNow = () => {
      const r = ringOf(v);
      return r && r.kind === 'plan' ? planWindows(v.limits) : [];
    };
    const planBox = h('div.chat-plan-box', { 'aria-live': 'polite' });
    const contextLine = h('p.sheet-text');
    const paintUsage = (waiting) => {
      const plan = planNow();
      fill(planBox, plan.length ? h('ul.chat-plan', plan.map((w) => h('li', h('strong', w.name), ` ${w.percent}% used${Number.isFinite(w.resetsAt) ? ` · starts again ${until(w.resetsAt)}` : ''}`)))
        : waiting ? h('p.sheet-text', `Asking ${who} how much of your plan is used…`)
          : ask ? h('p.sheet-text', `${who} did not say how much of your plan is used.`) : null);
      const u = v.usage || {};
      const p = contextPercent(u);
      fill(contextLine, p === null ? `Not known yet: it comes with ${who}'s next answer.` : `${p}% used${Number.isFinite(u.contextUsed) ? ` · ${kilo(u.contextUsed)} of ${kilo(u.contextWindow || 0)} tokens` : ''}.`);
    };
    const withPlan = ask || planNow().length > 0;
    paintUsage(ask);
    const shown = openSheet(withPlan ? { title: 'Plan usage', subtitle: 'Your plan\'s limits, shared by every Claude Code session of this account.' } : { title: 'Context', subtitle: `How much of what ${who} can keep in mind this conversation fills.` }, (close) => [
      withPlan ? planBox : null,
      withPlan ? h('h3.chat-help-h', 'Context') : null,
      contextLine,
      compact ? h('p.sheet-text', 'When it is nearly full Claude compacts by itself: it goes on from a summary of the conversation. Compact now to do that at a moment you choose.') : null,
      h('div.sheet-actions',
        h(`button.btn.${compact ? 'secondary' : 'primary'}`, { type: 'button', onclick: () => close() }, 'Close'),
        compact ? h('button.btn.primary', { type: 'button', onclick: () => {
          close();
          o.compact();
        } }, 'Compact now') : null),
    ]);
    if (ask) {
      usageAsk ||= api(`${o.A}/usage`).then((r) => {
        if (r) v = { ...v, ...(r.usage ? { usage: r.usage } : {}), ...(r.limits ? { limits: r.limits } : {}) };
      }, () => {
        /* not running any more: what is known is shown */
      }).finally(() => {
        usageAsk = null;
      });
      await usageAsk;
      paintUsage(false);
    }
    return shown;
  }

  /**
   * The sheet This session behind the pill: what the chips hold on a wide screen, as rows of 56 px with the value at the
   * right. A change acts at once, as the chips do, and says so in a toast; the open sheet follows the chat's state.
   */
  let settingsLive = null;
  function settingsSheet() {
    if (!v || readOnly()) return;
    const claude = toolWord(v) === 'Claude';
    const rows = (close) => {
      const mode = modeOf(v);
      const mw = modeInfo(v, mode);
      const ring = ringOf(v);
      const row = (label, value, { go, sub = null, tone = '', role = null, on = false } = {}) => h('button.choice.chat-set-row', { type: 'button', onclick: go, ...(role ? { role, 'aria-checked': String(on) } : {}) },
        h('span.choice-main', h('span.choice-label', label), sub ? h('span.choice-sub', sub) : null),
        value === null ? null : h(`span.chat-set-value${tone ? `.chat-tone-${tone}` : ''}`, value),
        role ? h('span.chat-switch', { 'aria-hidden': 'true' }) : value === null ? null : icon('chevronRight', { size: 16 }));
      return [
        row('Permission mode', mw ? mw.chip : modeChip(mode), { go: () => chooseMode({ sheet: true }), tone: mw && mw.danger ? 'danger' : '' }),
        row('Model', v.model ? modelName(v.model) : 'Auto', { go: () => choose('model', { sheet: true }) }),
        row('Effort', !claude && v.ultracode ? 'Highest' : v.effort ? effortName(v.effort) : 'Auto', { go: () => choose('effort', { sheet: true }) }),
        caps(v).ultracode ? row('Ultracode', v.ultracode ? 'On' : 'Off', { role: 'switch', on: !!v.ultracode, sub: claude ? 'Plans the work out to agents' : 'The model thinks as hard as it can', go: () => toggleUltra() }) : null,
        canLead() ? row('Lead model', v.lead ? 'On' : 'Off', { role: 'switch', on: !!v.lead, sub: 'Hands parts to other models', go: () => toggleLead() }) : null,
        row(ring && ring.kind === 'plan' ? 'Plan usage' : 'Context', ring ? `${ring.percent}% used` : 'Not known yet', { go: () => usageSheet() }),
        canCompact(v) ? row('Compact now', null, { sub: 'Goes on from a summary', go: () => {
          close();
          o.compact();
        } }) : null,
      ];
    };
    let drawn = '';
    const list = h('div.choice-list.chat-set-list');
    const mine = () => {
      const key = JSON.stringify([modeOf(v), v.model, v.effort, v.ultracode, v.lead, ringOf(v), canCompact(v)]);
      if (key === drawn) return;
      drawn = key;
      fill(list, rows(closeNow));
    };
    let closeNow = () => {};
    settingsLive = mine;
    openSheet({ title: 'This session' }, (close) => {
      closeNow = close;
      mine();
      return list;
    }).then(() => {
      if (settingsLive === mine) settingsLive = null;
    });
  }

  function paintButtons() {
    const busy = turnRuns(v); // background work alone is no turn: Send sends, and its Stop is in the agents strip
    const hasText = !!textarea.value.trim() || files.count() > 0 || shell.count() > 0;
    // One button place, as Claude Code has it: Stop while a turn runs and the box is empty; Send as soon as the box holds
    // something (it goes to the queue). Esc stops either way, and the box's words and Send's title say so.
    stopBtn.classList.toggle('hidden', !busy || hasText);
    sendBtn.classList.toggle('hidden', !!busy && !hasText);
    sendBtn.classList.toggle('chat-send-empty', !hasText); // nothing to send: the quiet grey circle
    fill(sendBtn, icon('send', { size: 18 }));
    sendBtn.setAttribute('aria-label', 'Send');
    // A touch screen has no Esc key: nothing says it there.
    sendBtn.title = busy ? `Send: ${toolWord(v)} reads it after its current step${finePointer() ? `. Esc stops ${toolWord(v)}` : ''}` : 'Send';
  }

  shell.adopt(); // a "!" command running since before this page opened (a reload, another window) shows, with Stop
  return {
    el,
    textarea,
    commands: () => menus.commands(), // the coding tool's / commands, for /help
    /** The page is left: the microphone stops, so nothing heard later reaches this box or its saved draft. */
    destroy: () => {
      mic.dispose();
      document.removeEventListener('chat-attach-path', attachPath);
    },
    focus: () => textarea.focus(),
    /** Esc Esc with words in the box (keys.js), as the terminal does: they go, and Up brings them back. */
    clearDraft() {
      const t = textarea.value;
      if (!t.trim()) return;
      sent.push(t);
      setText('');
      menus.update(); // a / or @ list open on those words closes with them
      giveBack(); // words put aside by Slash commands come back in the emptied box, never only in the saved draft
    },
    /** Text back into the box (a message taken back by Stop, the message a rewind went back to), before what is there. */
    putBack: (text) => putText(text),
    /** Files dropped on the page, or chosen elsewhere: to go with the next message. */
    addFiles: (list) => {
      files.take(list);
      textarea.focus();
    },
    /** The list of messages waiting to be read: the page places it in the conversation, after the living line. */
    queueEl: queueBox,
    choose,
    setChoice,
    chooseMode,
    settingsSheet,
    queueEl: queueBox,
    plusMenu,
    nextMode: () => v && setMode(nextMode(modeOf(v), v.choices ? v.choices.modes : undefined)),
    /** Esc while a "!" command runs stops that command (not the coding tool's turn). → whether one ran */
    stopShell: () => shell.stop(),
    paint(state) {
      v = state;
      const ro = readOnly();
      textarea.disabled = ro;
      plusBtn.disabled = ro;
      if (ro) {
        menus.close();
        closeMenu();
      }
      const who = toolWord(v);
      textarea.setAttribute('aria-label', `Message to ${who}`);
      stopBtn.title = `Stop ${who} (${finePointer() ? 'Esc; ' : ''}the turn ends${caps(v).stopTask ? ', background agents go on' : ''})`;
      ultraBtn.classList.toggle('hidden', !caps(v).ultracode || tucked());
      ultraBtn.title = who === 'Claude' ? 'Ultracode: Claude plans the work out to agents and workflows' : 'Ultracode: the model thinks as hard as it can';
      paintPlaceholder();
      paintQueue(v.queue);
      paintButtons();
      paintSend(); // a state update while a message is on its way keeps Send disabled
      const mode = modeOf(v);
      const mw = modeInfo(v, mode);
      const chip = mw ? mw.chip : modeChip(mode);
      modeBtn.classList.toggle('chat-is-danger', !!(mw && mw.danger));
      modeBtn.classList.toggle('chat-is-all', !!(mw && mw.strong));
      fill(modeBtn, icon(mw && mw.danger ? 'alert' : 'lock', { size: 13 }), h('span', chip));
      // The phone's pill: the mode when it is not Manual, the model, what is on; its colour is the mode's.
      const parts = pillParts(v);
      pillBtn.setAttribute('data-tone', parts[0].k === 'mode' ? parts[0].tone : '');
      fill(pillBtn, h('span.chat-pill-text', parts.flatMap((x, i) => [i ? h('span.chat-pill-dot', ' · ') : null, h(`span.chat-pill-${x.k}`, x.text)])), icon('chevronDown', { size: 14 }));
      pillBtn.setAttribute('aria-label', `This session: ${parts.map((x) => x.text).join(', ')}. Change settings`);
      pillBtn.disabled = ro;
      if (settingsLive) settingsLive();
      modeBtn.setAttribute('aria-label', `Permission mode: ${chip}. Change it`);
      // The model and its effort in one control ("Sonnet · High"), as the desktop app's model picker.
      const mdl = modelWords(v);
      const [mName, ...mEffort] = mdl.text.split(' · ');
      fill(modelBtn, h('span.chat-chip-label', mName, mEffort.length ? h('span.chat-chip-effort', ` ${mEffort.join(' · ')}`) : null));
      modelBtn.setAttribute('aria-label', `${mdl.said}. Change them`);
      modelBtn.title = mdl.said;
      ultraBtn.setAttribute('aria-pressed', String(!!v.ultracode));
      fill(ultraWord, v.ultracode ? 'on' : 'off'); // said in words, not only by its colour
      // Lead model: only Claude Code can lead; the chip says on or off, its title the line of what it uses.
      leadBtn.classList.toggle('hidden', !canLead() || tucked());
      leadBtn.setAttribute('aria-pressed', String(!!v.lead));
      fill(leadWord, v.lead ? 'on' : 'off');
      leadBtn.title = v.lead ? `Lead model is on. ${v.leadLine || ''}`.trim() : 'Lead model is off: the model you chose does every part. Turn it on to hand parts to faster and stronger models.';
      leadBtn.setAttribute('aria-label', `Lead model: ${v.lead ? 'on' : 'off'}. Turn it ${v.lead ? 'off' : 'on'}`);
      // Plan usage where the provider reports it, else context; the label says which (words.js ringOf).
      const r = ringOf(v);
      ring.classList.toggle('hidden', !r);
      ring.classList.toggle('chat-is-low', !!r && r.percent >= 85);
      ring.dataset.kind = r ? r.kind : '';
      ring.style.setProperty('--p', String(r ? r.percent : 0));
      fill(ring.querySelector('.chat-ring-text'), r ? r.text : '');
      ring.setAttribute('aria-label', r ? `${r.said}. Details` : 'Usage');
      ring.title = r ? r.said : '';
      paintFirst();
    },
  };
}
