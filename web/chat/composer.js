// The composer, laid out as Claude Code's: the queued messages above the box (each with a remove), the files to
// send with the message, the box, Send (Enter on a desktop; while Claude works it queues) and Stop beside it while
// Claude works; under it the chips that change the chat at once: the permission mode (Shift+Tab goes to the next;
// bypass is marked), the model and the effort (Auto first in both) and ultracode, and the context ring.
import { icon } from '../icons.js';
import { api, bytes, chooseSheet, fill, h, openSheet, prefs, toast, url } from '../lib.js';
import { MODE, contextPercent, effortName, kilo, modeChip, modeOf, modelName, nextMode } from './words.js';

const finePointer = typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches; // desktop: Enter sends

/** o: { A (the chat's API path), id, state() (the last state), stop(), compact() } → { el, paint(v), focus() } */
export function createComposer(o) {
  const draftKey = `chat.draft.${o.id}`;
  let files = []; // uploaded, to go with the next message: { path, name, size }
  const queueBox = h('ul.chat-queue', { 'aria-label': 'Queued messages' });
  const filesBox = h('div.chat-attach');
  const upStatus = h('p.chat-hint.chat-upstatus.hidden', { role: 'status' });
  const textarea = h('textarea.msg.chat-input', { rows: 1, 'aria-label': 'Message to Claude', enterkeyhint: finePointer ? 'send' : 'enter' });
  const fileInput = h('input.hidden', { type: 'file', multiple: true });
  const attachBtn = h('button.btn.icon.ghost.chat-attachbtn', { type: 'button', 'aria-label': 'Attach files', title: 'Attach files (they go into the project\'s uploads folder)', onclick: () => fileInput.click() }, icon('paperclip'));
  const sendBtn = h('button.btn.primary.icon.chat-send', { type: 'button', 'aria-label': 'Send', title: 'Send', onclick: () => send() }, icon('send', { size: 20 }));
  const stopBtn = h('button.btn.danger.icon.chat-stop.hidden', { type: 'button', 'aria-label': 'Stop', title: 'Stop Claude (the turn ends; background agents go on)', onclick: () => o.stop() }, icon('stop', { size: 20 }));
  const modeBtn = h('button.chip.chat-chip.chat-modechip', { type: 'button', onclick: () => chooseMode() });
  const modelBtn = h('button.chip.chat-chip', { type: 'button', onclick: () => choose('model') });
  const effortBtn = h('button.chip.chat-chip', { type: 'button', onclick: () => choose('effort') });
  const ultraBtn = h('button.chip.chat-chip.chat-ultra', { type: 'button', 'aria-pressed': 'false', title: 'Ultracode: Claude plans the work out to agents and workflows', onclick: () => toggleUltra() }, icon('grid', { size: 13 }), h('span', 'Ultracode'));
  const ring = h('button.chat-ring', { type: 'button', onclick: () => contextSheet() }, h('span.chat-ring-pie', { 'aria-hidden': 'true' }), h('span.chat-ring-text'));
  const chips = h('div.chat-chips', modeBtn, modelBtn, effortBtn, ultraBtn, h('span.chat-chips-gap'), ring);
  const el = h('div.chat-composer-wrap', queueBox, filesBox, upStatus, h('div.chat-composer', attachBtn, textarea, sendBtn, stopBtn, fileInput), chips);
  let v = null;

  // ---------- the box ----------
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, Math.round(innerHeight * 0.3))}px`;
  };
  textarea.value = prefs.get(draftKey, '');
  textarea.addEventListener('input', () => {
    prefs.set(draftKey, textarea.value);
    grow();
    paintButtons();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && finePointer && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Tab' && e.shiftKey && v) {
      e.preventDefault();
      setMode(nextMode(modeOf(v), v.choices ? v.choices.modes : undefined));
    }
  });

  async function send() {
    const text = textarea.value.replace(/\s+$/, '');
    if (!text) return textarea.focus();
    sendBtn.disabled = true;
    try {
      await api(`${o.A}/send`, { text, ...(files.length ? { attachments: files.map((f) => ({ path: f.path })) } : {}) });
      textarea.value = '';
      prefs.set(draftKey, '');
      files = [];
      paintFiles();
      grow();
    } catch (e) {
      toast(`Not sent: ${e.message}`, { kind: 'error' });
    } finally {
      sendBtn.disabled = false;
      paintButtons();
      textarea.focus();
    }
  }

  // ---------- the queue ----------
  function paintQueue(q) {
    fill(queueBox, (q || []).map((m) => h('li.chat-queued',
      icon('clock', { size: 14 }),
      h('span.chat-queued-text', m.text),
      h('span.chat-queued-state', m.state === 'sent' ? 'Claude has it' : 'waiting'),
      h('button.btn.icon.ghost.chat-unqueue', { type: 'button', 'aria-label': `Remove the queued message: ${m.text.slice(0, 60)}`, title: 'Remove from the queue', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api(`${o.A}/unqueue`, { id: m.id });
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      } }, icon('x', { size: 16 })))));
  }

  // ---------- attachments (the uploads folder, as for terminal sessions) ----------
  const paintFiles = () => fill(filesBox, files.map((f, n) => h('span.chip.chat-file', icon('paperclip', { size: 12 }), h('span', f.name),
    h('button.chat-file-x', { type: 'button', 'aria-label': `Do not send ${f.name}`, onclick: () => {
      files.splice(n, 1);
      paintFiles();
    } }, icon('x', { size: 12 })))));
  const upload = (file) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); // XHR, not fetch: it reports upload progress
    xhr.open('POST', url(`${o.A}/upload`));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'upload'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) upStatus.textContent = `Uploading ${file.name}: ${Math.round((e.loaded / e.total) * 100)}% of ${bytes(e.total)}`;
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200) resolve(body);
      else reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: connection lost'));
    xhr.send(file);
  });
  fileInput.addEventListener('change', async () => {
    const list = [...fileInput.files];
    fileInput.value = '';
    upStatus.classList.remove('hidden');
    for (const f of list) {
      try {
        const r = await upload(f);
        files.push({ path: r.path, name: f.name, size: f.size });
        paintFiles();
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    }
    upStatus.classList.add('hidden');
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
      title: 'What Claude may do without asking',
      subtitle: 'Changes at once, also while Claude works. Shift+Tab in the message box goes to the next.',
      items: (v.choices ? v.choices.modes : Object.keys(MODE)).map((m) => ({ value: m, label: modeChip(m), sub: MODE[m] ? MODE[m].sub : '', current: m === now, danger: !!(MODE[m] && MODE[m].danger) })),
    });
    if (pick && pick !== now) setMode(pick);
  }
  async function choose(what) {
    const cur = v[what];
    const items = what === 'model'
      ? [{ value: '', label: 'Auto', sub: 'Claude Code\'s own model; each agent gets the model its task needs' }, ...v.choices.models.map((m) => ({ value: m, label: modelName(m) }))]
      : [{ value: '', label: 'Auto', sub: 'Claude Code\'s own effort; each agent gets the effort its task needs' }, ...v.choices.efforts.map((e) => ({ value: e, label: effortName(e) }))];
    const pick = await chooseSheet({
      title: what === 'model' ? 'Model' : 'How hard Claude thinks',
      subtitle: what === 'model' ? 'Changes at once, in this chat. A new model reads the conversation again, which costs more once.' : 'Changes at once, in this chat.',
      items: items.map((x) => ({ ...x, current: (x.value || null) === (cur || null) })),
    });
    if (pick === null || (pick || null) === (cur || null)) return;
    try {
      const r = await api(`${o.A}/settings`, { [what]: pick || null });
      if (r.restart) toast('It takes effect when Claude starts again with the next message');
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
    openSheet({ title: 'Context', subtitle: 'How much of what Claude can keep in mind this conversation fills.' }, (close) => [
      h('p.sheet-text', p === null ? 'Not known yet: it comes with Claude\'s next answer.' : `${p}% used${Number.isFinite(u.contextUsed) ? ` · ${kilo(u.contextUsed)} of ${kilo(u.contextWindow || 0)} tokens` : ''}.`),
      h('p.sheet-text', 'When it is nearly full Claude compacts by itself: it goes on from a summary of the conversation. Compact now to do that at a moment you choose.'),
      h('div.sheet-actions',
        h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Close'),
        h('button.btn.primary', { type: 'button', onclick: () => {
          close();
          o.compact();
        } }, 'Compact now')),
    ]);
  }

  function paintButtons() {
    const busy = v && v.working;
    const hasText = !!textarea.value.trim();
    stopBtn.classList.toggle('hidden', !busy);
    // While Claude works: Stop is the main button; Send stays for a message to queue.
    sendBtn.classList.toggle('hidden', !!busy && !hasText);
    fill(sendBtn, icon(busy ? 'clock' : 'send', { size: 20 }));
    sendBtn.setAttribute('aria-label', busy ? 'Queue the message' : 'Send');
    sendBtn.title = busy ? 'Queue: Claude takes it at its next step' : 'Send';
  }

  return {
    el,
    textarea,
    focus: () => textarea.focus(),
    paint(state) {
      v = state;
      const ro = !!v.terminal;
      textarea.disabled = ro;
      attachBtn.disabled = ro;
      const words = ro ? 'Read only while the terminal runs this conversation'
        : v.working ? 'Queue a message…'
          : finePointer ? 'Message Claude. Enter sends, Shift+Enter a new line, Shift+Tab the mode' : 'Message Claude';
      if (textarea.placeholder !== words) {
        textarea.placeholder = words;
        grow(); // an empty box is as high as its placeholder
      }
      paintQueue(v.queue);
      paintButtons();
      const mode = modeOf(v);
      modeBtn.classList.toggle('chat-is-danger', !!(MODE[mode] && MODE[mode].danger));
      fill(modeBtn, icon(MODE[mode] && MODE[mode].danger ? 'alert' : 'lock', { size: 13 }), h('span', modeChip(mode)));
      modeBtn.setAttribute('aria-label', `Permission mode: ${modeChip(mode)}. Change it`);
      fill(modelBtn, icon('sparkle', { size: 13 }), h('span.chat-chip-k', 'Model'), h('span', v.model ? modelName(v.model) : 'Auto'));
      modelBtn.setAttribute('aria-label', `Model: ${v.model ? modelName(v.model) : 'Auto'}. Change it`);
      fill(effortBtn, icon('zap', { size: 13 }), h('span.chat-chip-k', 'Effort'), h('span', v.effort ? effortName(v.effort) : 'Auto'));
      effortBtn.setAttribute('aria-label', `Effort: ${v.effort ? effortName(v.effort) : 'Auto'}. Change it`);
      ultraBtn.setAttribute('aria-pressed', String(!!v.ultracode));
      const p = contextPercent(v.usage);
      ring.classList.toggle('hidden', p === null);
      ring.classList.toggle('chat-is-low', p !== null && p >= 85);
      ring.style.setProperty('--p', String(p || 0));
      fill(ring.querySelector('.chat-ring-text'), p === null ? '' : `${p}%`);
      ring.setAttribute('aria-label', p === null ? 'Context' : `Context ${p}% used. Compact`);
    },
  };
}
