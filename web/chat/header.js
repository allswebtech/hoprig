// The chat's head: the way back, the title (tap to rename) with the folder's history beside it (its earlier
// conversations), the folder chip (Files and Changes open the editor, and Open in terminal), the provider chip (move
// to another provider, each with its usage), and the more menu (Stop, Compact, Clear = a new chat in the same folder
// with the same settings, Rewind, Keyboard shortcuts, Close). A conversation stays with the coding
// tool it started with: the provider changes, the coding tool does not.
import { icon } from '../icons.js';
import { KIND, api, chooseSheet, fill, h, link, profileIcon, profileState, promptSheet, servesClaude, toast } from '../lib.js';
import { store } from '../store.js';
import { failText, touchScreen, turnRuns } from './words.js';

const phone = () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 599px)').matches;
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');

/** A provider's plan usage in a few words: "5-hour 42% · weekly 10%", or ''. */
export function usageWords(p) {
  const u = (p && p.usage) || {};
  return [['5-hour', u.fiveHour], ['weekly', u.week]].filter(([, x]) => x && Number.isFinite(x.pct)).map(([w, x]) => `${w} ${Math.round(x.pct)}%`).join(' · ');
}

/** The editor's address for a folder (another part of the dashboard draws it). */
export const editorLink = (dir, view = null) => link(`#/code?dir=${encodeURIComponent(dir)}${view ? `&view=${view}` : ''}`);

/** o: { A, way: { hash, label }, act: { stop, compact, clear, close, terminal, moveTo(name), history, rewind, shortcuts } } → { el, paint(v) } */
export function createHeader(o) {
  let v = null;
  const titleText = h('span.chat-title-text', 'Chat');
  const titleSub = h('span.chat-title-sub'); // on a phone: the folder and provider, under the title
  // On a phone the folder and provider chips do not fit beside the title: the title opens one sheet with all of it.
  const titleBtn = h('button.chat-title', { type: 'button', onclick: () => (phone() ? phoneMenu() : rename()) }, h('span.chat-title-row', titleText, icon('pencil', { size: 13 })), titleSub);
  const folderLabel = h('span.chat-chip-label');
  const folderBtn = h('button.chip.chat-hchip', { type: 'button', onclick: () => folderMenu() }, icon('folder', { size: 13 }), folderLabel, icon('chevronDown', { size: 12 }));
  const provLabel = h('span.chat-chip-label');
  const provBtn = h('button.chip.chat-hchip', { type: 'button', onclick: () => providerMenu() }, icon('user', { size: 13 }), provLabel, icon('chevronDown', { size: 12 }));
  const histBtn = h('button.btn.icon.ghost.chat-histbtn', { type: 'button', 'aria-label': 'Earlier conversations of this folder', title: 'Earlier conversations of this folder', onclick: () => o.act.history() }, icon('clock', { size: 16 }));
  const el = h('header.chat-bar',
    h('a.btn.ghost.chatback', { href: o.way.hash, 'aria-label': `Back to ${o.way.label}`, title: `Back to ${o.way.label}` }, icon('back'), h('span.chatback-label', o.way.label)),
    h('div.chat-head', h('div.chat-h1row', h('h1.chat-h1', titleBtn), histBtn), h('div.chat-sub', folderBtn, provBtn)),
    h('button.btn.icon.ghost.chat-morebtn', { type: 'button', title: 'More for this chat', 'aria-label': 'More for this chat', onclick: () => more() }, icon('more')));

  async function rename() {
    const title = await promptSheet({ title: 'Rename this chat', value: (v && v.title) || '', ok: 'Rename', check: (x) => (!x.trim() ? 'Write a name' : x.length > 200 ? 'At most 200 characters' : '') });
    if (!title || !title.trim()) return;
    try {
      await api(`${o.A}/title`, { title: title.trim() });
    } catch (e) {
      toast(failText(e), { kind: 'error' });
    }
  }

  async function phoneMenu() {
    const pick = await chooseSheet({
      title: (v && v.title) || 'Chat',
      subtitle: v.short || v.cwd,
      items: [
        { value: 'rename', label: 'Rename', sub: 'Give this chat a name', icon: 'pencil' },
        { value: 'history', label: 'Earlier conversations', sub: 'Of this folder: continue one in a chat', icon: 'clock' },
        { value: 'files', label: 'Files', sub: 'Open the folder in the editor', icon: 'code' },
        { value: 'changes', label: 'Changes', sub: 'What changed in the folder (git), in the editor', icon: 'git' },
        { value: 'terminal', label: 'Open in terminal', sub: 'The same conversation, in a terminal session', icon: 'terminal' },
        { value: 'provider', label: 'Provider', sub: `Now ${v.profile ? v.profile.label : '…'}: move to another`, icon: 'user' },
      ],
    });
    if (pick === 'rename') rename();
    else if (pick === 'history') o.act.history();
    else if (pick === 'files') location.hash = editorLink(v.cwd);
    else if (pick === 'changes') location.hash = editorLink(v.cwd, 'changes');
    else if (pick === 'terminal') o.act.terminal();
    else if (pick === 'provider') providerMenu();
  }

  async function folderMenu() {
    const pick = await chooseSheet({
      title: v.short || v.cwd,
      subtitle: 'The folder this chat works in.',
      items: [
        { value: 'files', label: 'Files', sub: 'Open the folder in the editor', icon: 'code' },
        { value: 'changes', label: 'Changes', sub: 'What changed in the folder (git), in the editor', icon: 'git' },
        { value: 'terminal', label: 'Open in terminal', sub: 'The same conversation, in a terminal session', icon: 'terminal' },
      ],
    });
    if (pick === 'files') location.hash = editorLink(v.cwd);
    else if (pick === 'changes') location.hash = editorLink(v.cwd, 'changes');
    else if (pick === 'terminal') o.act.terminal();
  }

  async function providerMenu() {
    // A chat runs Claude Code: a provider that does not serve it (an OpenAI key, a Codex sign-in) is not offered.
    const profiles = ((store.data && store.data.profiles) || []).filter((p) => p.name && servesClaude(p));
    if (!profiles.length) return toast('No other provider on this computer', { kind: 'error' });
    const cur = v.profile ? v.profile.name : null;
    const pick = await chooseSheet({
      title: 'Continue on…',
      subtitle: `${(v.engine && v.engine.label) || 'Claude Code'} goes on with the same conversation on the provider you choose, from the next message.`,
      items: profiles.map((p) => ({
        value: p.name, label: p.label, icon: profileIcon(p),
        sub: [p.virtual ? null : KIND[p.kind] || p.kind, profileState(p).text, usageWords(p)].filter(Boolean).join(' · '),
        current: p.name === cur, disabled: p.name === cur,
      })),
    });
    if (pick && pick !== cur) o.act.moveTo(pick, (profiles.find((p) => p.name === pick) || {}).label || pick);
  }

  async function more() {
    const busy = turnRuns(v);
    const caps = (v && v.engine && v.engine.capabilities) || {};
    const what = await chooseSheet({
      title: (v && v.title) || 'Chat',
      subtitle: v ? v.short : null,
      items: [
        busy ? { value: 'stop', label: 'Stop Claude', sub: 'Ends the turn; agents in the background go on', icon: 'stop' } : null,
        { value: 'compact', label: 'Compact', sub: 'Claude goes on from a summary of the conversation, which frees context', icon: 'minus' },
        { value: 'clear', label: 'Clear', sub: 'A new chat in this folder with the same settings; this one is kept', icon: 'plus' },
        // Not while a terminal runs the conversation: a rewind runs Claude Code on it (one place at a time).
        (caps.rewind || caps.fork) && v && !v.terminal ? { value: 'rewind', label: 'Rewind…', sub: 'Go back to before one of your messages: the files, the conversation or both', icon: 'undo' } : null,
        { value: 'terminal', label: 'Open in terminal', sub: 'The same conversation, in a terminal session', icon: 'terminal' },
        touchScreen() ? null : { value: 'shortcuts', label: 'Keyboard shortcuts', sub: 'Enter, Esc, Shift+Tab, ↑, / and @', icon: 'info' },
        { value: 'close', label: 'Close this chat', sub: 'The conversation stays; it leaves Home', icon: 'x', danger: true },
      ].filter(Boolean),
    });
    if (what && o.act[what]) o.act[what]();
  }

  return {
    el,
    providerMenu,
    /**
     * The chat is not open any more: the head names it and goes back, nothing else (its menus would act on nothing;
     * the page's .chat-closed hides them).
     */
    closed(title) {
      if (title) fill(titleText, title);
      titleBtn.disabled = true;
      titleBtn.removeAttribute('aria-label');
      titleBtn.title = '';
      fill(titleSub);
    },
    paint(state) {
      v = state;
      fill(titleText, v.title || 'New chat');
      titleBtn.setAttribute('aria-label', phone() ? `${v.title || 'New chat'}: name, folder, provider` : `${v.title || 'New chat'}. Rename`);
      titleBtn.title = phone() ? '' : 'Rename this chat';
      fill(titleSub, [base(v.cwd), v.profile ? v.profile.label : ''].filter(Boolean).join(' · '));
      fill(folderLabel, base(v.cwd));
      folderBtn.title = v.short || v.cwd || '';
      folderBtn.setAttribute('aria-label', `Folder ${v.short || v.cwd || ''}: files, changes, terminal`);
      fill(provLabel, v.profile ? v.profile.label : '…');
      provBtn.setAttribute('aria-label', `Provider ${v.profile ? v.profile.label : ''}: move to another`);
    },
  };
}
