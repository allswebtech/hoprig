// The chat's head, laid out as the Claude Code desktop app's title bar: the way back, the title (click to rename)
// with the session menu on the caret beside it (Transcript view, Open in, Archive, Copy branch name, and the
// folder's earlier conversations), the folder and the provider chip (move to another provider, each with its usage)
// under it, the title-bar buttons Terminal, Changes and Files, "Desktop mode", and the more menu (Stop, Compact,
// Clear = a new session in the same folder with the same settings, Rewind, Background tasks, Keyboard shortcuts, the
// rail). A conversation stays with the coding tool it started with: the provider changes, the coding tool does not.
// On a phone the title opens the session menu, with the provider in it.
import { icon } from '../icons.js';
import { BARE, api, chooseSheet, fill, h, kindLabel, link, openApp, openSheet, profileIcon, profileState, promptSheet, servesTool, stateOf, toast, toolBadge } from '../lib.js';
import { closeMenuOf, openMenu } from '../desktop/menu.js'; // the drop-down menu with submenus (also the desktop's)
import { store } from '../store.js';
import { copyBranch, railFits } from './rail.js';
import { notPickable } from './deletes.js';
import { sideFits } from './sidebar.js';
import * as W from './words.js';
import { VIEWS, canCompact, caps, failText, toolWord, touchScreen, turnRuns, viewChoices } from './words.js';
import { hasKeys } from './keys.js';

const phone = () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 599px)').matches;
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');

/**
 * The state word of the title bar's sub line: { key, text } when the session is doing something or stopped, null for
 * Ready and Finished (an idle session has no word; a dot is never drawn without one). The words are Home's (lib.js
 * stateOf); words.js chatState says the same for the whole chat page and is used when it is there.
 */
export function stateMark(v) {
  if (!v) return null;
  let m;
  if (typeof W.chatState === 'function') m = W.chatState(v);
  else {
    const st = stateOf(v);
    const key = st.key === 'limit' ? 'limit' : st.key === 'failed' ? 'error' : st.key === 'shell' ? 'terminal' : st.key === 'attention' ? 'attention'
      : st.key === 'waiting' ? (v.endedInError ? 'error' : v.lastMessage ? 'finished' : 'ready') : st.key === 'starting' ? 'working' : st.key === 'working' ? (v.background ? 'background' : 'working') : 'stopped';
    m = { key, text: st.text };
  }
  return !m || m.key === 'ready' || m.key === 'finished' ? null : { key: m.key === 'failed' ? 'error' : m.key, text: m.text };
}

/** A provider's plan usage in a few words: "5-hour 42% · weekly 10%", or ''. */
export function usageWords(p) {
  const u = (p && p.usage) || {};
  return [['5-hour', u.fiveHour], ['weekly', u.week]].filter(([, x]) => x && Number.isFinite(x.pct)).map(([w, x]) => `${w} ${Math.round(x.pct)}%`).join(' · ');
}

/**
 * The menus' terminal entry: while a terminal runs the conversation, it goes there (one conversation, one process);
 * else it opens the conversation in a new one (the chat closes).
 */
export const terminalItem = (v) => (v && v.terminal
  ? { value: 'terminal', label: 'Open the terminal', sub: v.terminal.name ? `This conversation runs in "${v.terminal.name}"` : 'It runs in a terminal outside the dashboard', icon: 'terminal' }
  : { value: 'terminal', label: 'Continue in Terminal', sub: 'The same conversation, in a terminal session', icon: 'terminal' });

/**
 * The session menu's Open in: the hand-off to a terminal session ("Continue in Terminal": the title bar's Terminal
 * button is the plain shell pane under the chat) and Hoprig's editor. While a terminal runs the conversation, the
 * entry goes there.
 */
export const openInItems = (v) => [
  terminalItem(v),
  { value: 'files', label: 'Files', sub: 'The folder in the editor', icon: 'code' },
  // Not "Changes": that is the diff pane (the title bar's Changes), as the desktop app has one Changes.
  { value: 'changes', label: 'Source control', sub: 'What changed in the folder (git), in the editor\'s Source Control', icon: 'git' },
];

/**
 * The more menu (⋮): Stop, Compact, Clear, Rewind, Keyboard shortcuts; Background tasks once the session has
 * background work, as the desktop app's ⋮ lists it; Hide / Show session rail where the rail fits.
 * o: { rail: { hidden() } | null, wide (the rail fits), touch (a touch screen: no shortcuts), side: { hidden() } | null
 * (the session list), sideWide (the list fits) }
 */
export function moreItems(v, { rail = null, wide = false, touch = false, side = null, sideWide = false } = {}) {
  const can = caps(v);
  return [
    turnRuns(v) ? { value: 'stop', label: `Stop ${toolWord(v)}`, sub: can.stopTask ? 'Ends the turn; agents in the background go on' : 'Ends the turn', icon: 'stop' } : null,
    // Not while the box is read only, nor where the coding tool has none (words.js canCompact).
    canCompact(v) ? { value: 'compact', label: 'Compact', sub: `${toolWord(v)} goes on from a summary of the conversation, which frees context`, icon: 'minus' } : null,
    { value: 'clear', label: 'Clear', sub: 'A new session in this folder with the same settings; this one is kept', icon: 'plus' },
    // Not while a terminal runs the conversation: a rewind runs Claude Code on it (one place at a time).
    (can.rewind || can.fork) && v && !v.terminal ? { value: 'rewind', label: 'Rewind…', sub: 'Go back to before one of your messages: the code, the conversation or both', icon: 'undo' } : null,
    // Lead model: which model did which part, in a sheet (the rail's card is not drawn below its width).
    v && v.lead ? { value: 'parts', label: 'Who did what', sub: 'Which model did each part, with its tokens', icon: 'stack' } : null,
    v && Array.isArray(v.tasks) && v.tasks.length ? { value: 'tasks', label: 'Background tasks', sub: 'Agents, shells and workflows of this session, each with its Stop', icon: 'grid' } : null,
    touch ? null : { value: 'shortcuts', label: 'Keyboard shortcuts', sub: 'Enter, Esc, Shift+Tab, ↑, / and @', icon: 'info' },
    rail && wide ? { value: 'rail', label: rail.hidden() ? 'Show session rail' : 'Hide session rail', sub: 'The session\'s details beside the chat', icon: 'rail' } : null,
    side && sideWide ? { value: 'side', label: side.hidden() ? 'Show session list' : 'Hide session list', sub: 'The list of your sessions at the left', icon: 'panelLeft' } : null,
  ].filter(Boolean);
}

/** The editor's address for a folder (another part of the dashboard draws it). */
export const editorLink = (dir, view = null, m = undefined) => link(`#/code?dir=${encodeURIComponent(dir)}${view ? `&view=${view}` : ''}`, m);
// Files and Changes: the editor in place, or inside a window of the desktop an Editor window beside the chat. The
// folder is the chat's own: the editor checks it against its allowed folders as for any other address.
export const openEditor = (dir, view = null) => openApp('editor', editorLink(dir, view, null));

/**
 * The session menu, as the desktop app's on the caret beside the title (Transcript view, Open in, Archive, Copy
 * branch name), then Hoprig's own; on a phone Open in's targets at its first level and the provider (its chip does not
 * fit there). o: { view (the transcript view now; null: none to choose), phone, list (the session list is drawn
 * beside the chat: not on a phone, below SIDE_MIN_PX or in a window of the desktop) }
 */
export function sessionItems(v, { view = null, phone: onPhone = false, list = !onPhone } = {}) {
  const viewName = view ? (VIEWS.find((x) => x.id === view) || VIEWS[0]).label : '';
  return [
    view ? { value: 'view', label: 'Transcript view', sub: `${viewName}: how much of each step shows`, icon: 'text' } : null,
    // A phone: Open in's targets at the first level (two taps to the terminal, not three).
    // Changes is the diff pane there, as the title bar's Changes (which a phone does not show); its editor button has
    // the editor's Changes.
    ...(onPhone ? [terminalItem(v), ...openInItems(v).slice(1).map((x) => (x.value === 'changes' ? { ...x, value: 'diff', label: 'Changes', sub: 'What changed in the folder: review it, comment on lines' } : x))]
      : [{ value: 'openin', label: 'Open in', sub: `Terminal, Files or Source control${v && v.terminal ? ' (a terminal runs it now)' : ''}`, icon: 'terminal' }]),
    { value: 'archive', label: 'Archive', sub: 'It leaves Home; the conversation is kept and can be continued', icon: 'archive' },
    v && v.branch ? { value: 'branch', label: 'Copy branch name', sub: v.branch, icon: 'git' } : null,
    // Fork, the desktop app's word (it clashes less with a git branch): Claude Code's /branch (switches into the copy;
    // /fork, which stays here, is in the / menu too), where the coding tool can (OpenCode cannot).
    caps(v).fork ? { value: 'fork', label: 'Fork', sub: 'A copy of this chat you switch into; this one stays', icon: 'swap' } : null,
    { value: 'history', label: 'Earlier conversations', sub: 'Of this folder: continue one in the App', icon: 'clock' },
    { value: 'rename', label: 'Rename', sub: 'Give this session a name', icon: 'pencil' },
    // Hands-off for this session (web/handsoff.js), as on a terminal's page: on here, or one press stops it.
    v && v.handsOff ? { value: 'handsoff', label: v.handsOff.on ? 'Stop Hands-off' : 'Turn on Hands-off', sub: v.handsOff.on ? 'Hoprig stops answering for you in this session' : 'Hoprig answers what the tool marks as recommended, or with your note', icon: 'sparkle' } : null,
    // Where the note is written: one press opens Settings → Hands-off, not a place named in words only.
    v && v.handsOff ? { value: 'handsoffsettings', label: 'Hands-off settings', sub: 'Your note for this project, and what Hands-off never answers', icon: 'settings' } : null,
    // Not while it works or waits for an OK: the server would refuse it (the reason is the entry's sub line).
    v && v.engine && v.engine.id === 'claude' ? { value: 'delete', label: 'Delete', sub: notPickable(v) || 'To the trash; removed for good after 30 days', icon: 'trash', danger: true, ...(notPickable(v) ? { disabled: true } : {}) } : null,
    // Where the session list is not drawn (its menu has them), the trash and the pick of several are here.
    !list ? { value: 'pick', label: 'Select to delete', sub: 'Several App sessions of this computer at once', icon: 'checkAll' } : null,
    !list ? { value: 'trash', label: 'Trash', sub: 'Deleted sessions: put one back within 30 days', icon: 'trashBack' } : null,
    onPhone ? { value: 'provider', label: 'Provider', sub: `Now ${v && v.profile ? v.profile.label : '…'}: move to another`, icon: 'user' } : null,
  ].filter(Boolean);
}

/** The menus' title: the session's, else what its head says (never "App"). */
export const menuTitle = (v) => (v && v.title) || 'New session';

/**
 * The session menu as it drops down from the caret on a wider screen, as the desktop app's: Transcript view (the
 * views, the one now marked) and Open in are submenus. o: { view (now; null: none to choose), thought (there is
 * thinking: the Thinking view is offered), who (the coding tool's word), list (the session list is drawn: sessionItems) }
 * → [{ value, label, icon, checked?, items? }]
 */
export function sessionTree(v, { view = null, thought = false, who = 'Claude', list = true } = {}) {
  return sessionItems(v, { view, list }).map((x) => (x.value === 'view'
    ? { ...x, items: viewChoices(view, thought, who).map((c) => ({ value: `view:${c.id}`, label: c.label, checked: c.id === view })) }
    : x.value === 'openin' ? { ...x, items: openInItems(v) } : x));
}

const GROUP_OF = {
  stop: 'Now', tasks: 'Now', compact: 'Now', rewind: 'Now', parts: 'Now',
  terminal: 'Open', files: 'Open', diff: 'Open', changes: 'Open',
  rename: 'This session', provider: 'This session', fork: 'This session', history: 'This session', clear: 'This session', archive: 'This session', delete: 'This session',
};
export const GROUPS = ['Now', 'Open', 'This session', 'More'];
/**
 * A phone's one menu: the session menu and the more menu merged, each entry once, in four groups: Now (what the turn
 * does), Open (the terminal, the files, the changes), This session (rename, provider, fork, earlier conversations,
 * archive, delete) and More (the transcript view, the branch, Hands-off, Select to delete, Trash).
 * o: { view, rail, side } as sessionItems and moreItems take them → [{ title, items }]
 */
export function phoneGroups(v, { view = null, rail = null, side = null } = {}) {
  const seen = new Set();
  const all = [...moreItems(v, { rail, wide: false, touch: true, side, sideWide: false }), ...sessionItems(v, { view, phone: true })].filter((x) => !seen.has(x.value) && seen.add(x.value));
  const rank = (x) => (GROUP_OF[x.value] === 'Now' ? ['stop', 'tasks', 'compact', 'rewind', 'parts'].indexOf(x.value) : GROUP_OF[x.value] === 'Open' ? ['terminal', 'files', 'diff', 'changes'].indexOf(x.value)
    : GROUP_OF[x.value] === 'This session' ? ['rename', 'provider', 'fork', 'history', 'clear', 'archive', 'delete'].indexOf(x.value) : 0);
  return GROUPS.map((title) => ({ title, items: all.filter((x) => (GROUP_OF[x.value] || 'More') === title).sort((a, b) => rank(a) - rank(b)) })).filter((g) => g.items.length);
}

/**
 * o: { A, way: { hash, label } | null (a window that started on this chat: no way back), side: { hidden(), toggle() } | null
 * (the session list at the left, sidebar.js: its button is the bar's first), act: { stop, compact, clear,
 * close (Archive), terminal, moveTo(name), history, rewind, shortcuts }, view: { now(), set(id), thought() } (the
 * transcript view, timeline.js), rail: { hidden(), toggle() } (the session rail, rail.js) }
 * → { el, paint(v), closed(title), providerMenu(), stop() }
 */
export function createHeader(o) {
  let v = null;
  const titleText = h('span.chat-title-text', 'App');
  const titleSub = h('span.chat-title-sub'); // on a phone: the folder and provider, under the title
  // Desktop: the title renames, the caret beside it opens the session menu. Phone: both open the session menu (the
  // folder and the provider do not fit beside the title; the menu has the provider too).
  const titleBtn = h('button.chat-title', { type: 'button', onclick: () => (phone() ? phoneMenu() : rename()) }, h('span.chat-title-row', titleText), titleSub);
  const titleH1 = h('h1.chat-h1', titleBtn);
  const caretBtn = h('button.btn.icon.ghost.chat-caret', { type: 'button', 'aria-label': 'Session menu', title: 'Session menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => sessionMenu() }, icon('chevronDown', { size: 16 }));
  const folderLabel = h('span.chat-folder');
  const stateSlot = h('span.chat-stateslot'); // wide: the state word as a small chip before the folder (the phone has it in the sub line)
  const provLabel = h('span.chat-chip-label');
  const provBtn = h('button.chip.chat-hchip', { type: 'button', onclick: () => providerMenu() }, icon('user', { size: 13 }), provLabel, icon('chevronDown', { size: 12 }));
  const toolSlot = h('span.chat-toolslot'); // the coding tool's chip, when it is not Claude Code
  // The title-bar buttons, named on hover as the desktop app's are. Terminal opens a shell under the chat (termpane.js),
  // as the desktop app's does; the hand-off to a terminal session is in the session menu (Open in > Continue in
  // Terminal). Its Files and Changes are its editor.
  const barBtn = (name, ic, label, onclick) => h('button.btn.icon.ghost.chat-tbtn', { type: 'button', title: name, 'aria-label': label, onclick }, icon(ic, { size: 17 }));
  const termBtn = barBtn(hasKeys() ? 'Terminal (Ctrl+`)' : 'Terminal', 'terminal', 'Terminal: a shell in this folder, under the chat', () => o.act.termPane && o.act.termPane());
  termBtn.setAttribute('aria-pressed', 'false');
  // Hide / Show session rail: only where the screen is wide enough for the rail (rail.css).
  const railBtn = o.rail ? barBtn('Hide session rail', 'rail', 'Hide session rail', () => o.rail.toggle()) : null;
  if (railBtn) railBtn.classList.add('chat-railbtn');
  // The bar's first buttons, as the desktop app's: hide or show the session list (it flips its words), and Home (never
  // in a window of the desktop, which has its own way). Both show from the width the list does (sidebar.css); below it
  // the Back arrow stands in their place.
  // A phone says Sessions and draws a list; where the list stands beside the chat, the button hides and shows it.
  const pic = (name, cls, size) => {
    const svg = icon(name, { size });
    svg.setAttribute('class', `icon ${cls}`);
    return svg;
  };
  const sideBtn = o.side ? h('button.btn.icon.ghost.chat-sidebtn', { type: 'button', onclick: () => o.side.toggle() }, pic('panelLeft', 'ic-panel', 17), pic('list', 'ic-list', 20)) : null;
  const homeBtn = BARE ? null : h('a.btn.icon.ghost.chat-homebtn', { href: link('#/'), title: 'Home', 'aria-label': 'Home' }, icon('home', { size: 17 }));
  const paintSide = () => {
    if (!sideBtn) return;
    if (phone()) {
      sideBtn.title = 'Sessions';
      sideBtn.setAttribute('aria-label', 'Sessions');
      sideBtn.setAttribute('aria-haspopup', 'dialog');
      sideBtn.removeAttribute('aria-pressed');
      return;
    }
    const word = o.side.hidden() ? 'Show session list' : 'Hide session list';
    sideBtn.title = word;
    sideBtn.setAttribute('aria-label', word);
    sideBtn.removeAttribute('aria-haspopup');
    sideBtn.setAttribute('aria-pressed', String(!o.side.hidden())); // pressed: the list is shown
  };
  paintSide();
  const tbtns = h('div.chat-tbtns',
    termBtn,
    barBtn('Changes', 'git', 'Changes: the diff of the folder (git), to review and comment on', () => (o.act.diff ? o.act.diff() : openEditor(v.cwd, 'changes'))),
    barBtn('Files', 'code', 'Files: the folder in the editor', () => openEditor(v.cwd)),
    railBtn);
  // Wide: the more menu. A phone: the one menu, the same sheet the title opens.
  const moreBtn = h('button.btn.icon.ghost.chat-morebtn', { type: 'button', title: 'More for this session', 'aria-label': 'More for this session', onclick: () => (phone() ? phoneMenu() : more()) }, icon('moreV'));
  const el = h('header.chat-bar',
    o.way && h('a.btn.ghost.chatback', { href: o.way.hash, 'aria-label': `Back to ${o.way.label}`, title: `Back to ${o.way.label}` }, icon('back'), h('span.chatback-label', o.way.label)),
    sideBtn, homeBtn,
    h('div.chat-head', h('div.chat-h1row', titleH1, caretBtn), h('div.chat-sub', toolSlot, stateSlot, folderLabel, provBtn)),
    tbtns,
    moreBtn);

  const saveTitle = async (text) => {
    try {
      await api(`${o.A}/title`, { title: text });
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  };
  // Rename: on a wide screen the title turns into a box where it stands (Enter saves, Esc cancels, leaving it saves);
  // a phone has no room beside the menu: a small sheet.
  let editing = false;
  async function rename() {
    if (editing) return;
    if (phone()) {
      const title = await promptSheet({ title: 'Rename this session', value: (v && v.title) || '', ok: 'Rename', check: (x) => (!x.trim() ? 'Write a name' : x.length > 200 ? 'At most 200 characters' : '') });
      if (title && title.trim()) await saveTitle(title.trim());
      return;
    }
    editing = true;
    const was = (v && v.title) || '';
    const input = h('input.chat-title-input', { type: 'text', value: was, maxlength: 200, 'aria-label': 'Session name', spellcheck: false });
    const finish = (save) => {
      if (!editing) return;
      editing = false;
      const text = String(input.value || '').trim();
      fill(titleH1, titleBtn);
      titleBtn.focus();
      if (save && text && text !== was) saveTitle(text);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // not the page's Esc, which would stop Claude
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    fill(titleH1, input);
    input.focus();
    if (input.select) input.select();
  }

  let menu = null; // the session menu while it is open (it is drawn on the page's body, not in the head)
  // A wider screen: a menu that drops down from the caret, with its submenus (Escape and a press outside close it,
  // the keyboard goes back to the caret). A phone: a sheet from the bottom, its entries large enough for a finger.
  async function sessionMenu() {
    const view = o.view ? o.view.now() : null;
    if (!phone()) {
      const r = caretBtn.getBoundingClientRect();
      const item = (x) => ({ label: x.disabled && x.sub ? `${x.label} (${x.sub.charAt(0).toLowerCase()}${x.sub.slice(1)})` : x.label, icon: x.icon, ...(x.danger ? { danger: true } : {}), ...(x.disabled ? { disabled: true } : {}), ...(typeof x.checked === 'boolean' ? { checked: x.checked } : {}),
        ...(x.items ? { items: x.items.map(item) } : { run: () => sessionPick(x.value) }) });
      menu = openMenu(r.left, r.bottom + 4, sessionTree(v, { view, thought: o.view ? o.view.thought() : false, who: toolWord(v), list: !BARE && sideFits() }).map(item), `Session menu of ${menuTitle(v)}`, { from: caretBtn });
      return;
    }
    sessionPick(await chooseSheet({
      title: menuTitle(v),
      subtitle: v ? v.short || v.cwd : null,
      items: sessionItems(v, { view, phone: true }),
    }));
  }
  function sessionPick(pick) {
    if (typeof pick === 'string' && pick.startsWith('view:')) {
      if (pick.slice(5) !== o.view.now()) o.view.set(pick.slice(5));
    } else if (pick === 'view') viewMenu();
    else if (pick === 'files') openEditor(v.cwd);
    else if (pick === 'changes') openEditor(v.cwd, 'changes');
    else if (pick === 'diff') o.act.diff();
    else if (pick === 'terminal') o.act.terminal();
    else if (pick === 'archive') o.act.close();
    else if (pick === 'branch') copyBranch(v.branch);
    else if (pick === 'history') o.act.history();
    else if (pick === 'fork') o.act.fork();
    else if (pick === 'rename') rename();
    else if (pick === 'handsoff') o.act.handsOff?.();
    else if (pick === 'handsoffsettings') location.hash = link('#/settings/handsoff');
    else if (pick === 'delete') o.act.remove();
    else if (pick === 'pick') o.act.pickDelete();
    else if (pick === 'trash') o.act.trash();
    else if (pick === 'provider') providerMenu();
  }

  async function viewMenu() {
    const now = o.view.now();
    const pick = await chooseSheet({
      title: 'Transcript view',
      subtitle: 'How much of each step shows, in every session in this browser.',
      items: viewChoices(now, o.view.thought(), toolWord(v)).map((x) => ({ value: x.id, label: x.label, sub: x.sub, current: x.id === now })),
    });
    if (pick && pick !== now) o.view.set(pick);
  }

  async function providerMenu() {
    // Only the providers that serve the chat's coding tool: a conversation stays in its tool.
    const tool = (v.engine && v.engine.id) || 'claude';
    const profiles = ((store.data && store.data.profiles) || []).filter((p) => p.name && servesTool(p, tool));
    if (!profiles.length) return toast('No other provider on this computer', { kind: 'error' });
    const cur = v.profile ? v.profile.name : null;
    const pick = await chooseSheet({
      title: 'Continue on…',
      subtitle: `${(v.engine && v.engine.label) || 'Claude Code'} goes on with the same conversation on the provider you choose, from the next message.`,
      items: profiles.map((p) => ({
        value: p.name, label: p.label, icon: profileIcon(p),
        sub: [p.virtual ? null : kindLabel(p), profileState(p).text, usageWords(p)].filter(Boolean).join(' · '),
        current: p.name === cur, disabled: p.name === cur,
      })),
    });
    if (pick && pick !== cur) o.act.moveTo(pick, (profiles.find((p) => p.name === pick) || {}).label || pick);
  }

  // A phone: ONE sheet for the title and the dots, grouped (Now, Open, This session, More), its title the session's name.
  async function phoneMenu() {
    // An entry says more only where the words carry a value (the branch, the provider, the view) or a reason (it is off).
    const says = (it) => !!it.sub && (it.disabled || ['branch', 'provider', 'view'].includes(it.value));
    const row = (it) => h(`button.choice${it.danger ? '.danger' : ''}${says(it) ? '.has-sub' : ''}`, { type: 'button', disabled: it.disabled, onclick: () => pickFrom(it.value) },
      it.icon ? h('span.choice-icon', icon(it.icon)) : null,
      h('span.choice-main', h('span.choice-label', it.label), it.sub ? h('span.choice-sub', it.sub) : null),
      h('span.choice-end', icon('chevronRight')));
    let pickFrom = () => {};
    const view = o.view ? o.view.now() : null;
    const groups = phoneGroups(v, { view, rail: null, side: null });
    const pick = await openSheet({ title: menuTitle(v), subtitle: v ? v.short || v.cwd : null, tall: true }, (close) => {
      pickFrom = close;
      return groups.map((g) => h('section.chat-menu-group', { 'aria-label': g.title }, h('h3.chat-menu-gh', g.title), h('div.choice-list', g.items.map(row))));
    });
    if (!pick) return;
    const moreValues = new Set(moreItems(v, { touch: true }).map((x) => x.value));
    if (moreValues.has(pick)) o.act[pick]?.();
    else sessionPick(pick);
  }

  async function more() {
    const what = await chooseSheet({
      title: menuTitle(v),
      subtitle: v ? v.short : null,
      items: moreItems(v, { rail: o.rail || null, wide: railFits(), touch: touchScreen(), side: o.side || null, sideWide: !BARE && sideFits() }),
    });
    if (what === 'rail') o.rail.toggle();
    else if (what === 'side') o.side.toggle();
    else if (what && o.act[what]) o.act[what]();
  }

  return {
    el,
    providerMenu,
    /** The list button says Hide or Show again (the list was hidden or shown). */
    paintSide,
    /** The Terminal button says whether the shell pane is open (the screen reader's pressed state). */
    paintTerm: (on) => termBtn.setAttribute('aria-pressed', String(!!on)),
    /** The page went: its session menu goes with it (its entries would act on a session no longer shown). */
    stop: () => closeMenuOf(menu),
    /**
     * The chat is not open any more: the head names it and goes back, nothing else (its menus would act on nothing;
     * the page's .chat-closed hides them).
     */
    closed(title) {
      closeMenuOf(menu);
      fill(titleText, title || 'Archived session'); // never "New session" for one that is gone
      titleBtn.disabled = true;
      titleBtn.removeAttribute('aria-label');
      titleBtn.title = '';
      fill(titleSub);
    },
    paint(state) {
      v = state;
      paintSide();
      fill(titleText, v.title || 'New session');
      titleBtn.setAttribute('aria-label', phone() ? `${v.title || 'New session'}: session menu` : `${v.title || 'New session'}. Rename`);
      titleBtn.title = phone() ? '' : 'Rename this session';
      moreBtn.title = phone() ? 'Session menu' : 'More for this session';
      moreBtn.setAttribute('aria-label', moreBtn.title);
      // The state word first, in its colour (nothing when the session is Ready or Finished), then the folder and provider.
      const mark = stateMark(v);
      const word = (cls) => (mark ? h(`span.chat-state${cls}`, { dataset: { key: mark.key } }, mark.text) : null);
      fill(titleSub, mark ? [word(''), ' · '] : null, [v.engine && v.engine.id !== 'claude' ? v.engine.label : '', base(v.cwd), v.profile ? v.profile.label : ''].filter(Boolean).join(' · '));
      fill(stateSlot, word('.chat-statechip'));
      fill(folderLabel, icon('folder', { size: 13 }), h('span.chat-chip-label', base(v.cwd)));
      folderLabel.title = v.short || v.cwd || '';
      if (railBtn) {
        const word = o.rail.hidden() ? 'Show session rail' : 'Hide session rail';
        railBtn.title = word;
        railBtn.setAttribute('aria-label', word);
      }
      fill(provLabel, v.profile ? v.profile.label : '…');
      fill(toolSlot, toolBadge(v.engine && v.engine.id));
      provBtn.setAttribute('aria-label', `Provider ${v.profile ? v.profile.label : ''}: move to another`);
    },
  };
}
