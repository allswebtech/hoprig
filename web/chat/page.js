// The chat with a coding tool (#/chat/<id>; #/m/<computer>/chat/<id> for another computer): coding without the
// terminal, as Claude Code works. The parts are modules of this folder: the session list at the left (sidebar.js), the
// head (header.js), the conversation
// (timeline.js with tools.js, diff.js, asks.js), the agents strip (agents.js), the composer (composer.js with its
// menus, popovers.js, and files, attach.js), the status line (statusline.js), the limit card (limit.js), the sheets of
// the history and the rewind (sheets.js) and the keys (keys.js); stream.js follows the server (src/chat/feature.mjs,
// live.mjs). Files dropped anywhere on the page go with the next message.
// Text from Claude, tools and files is only ever set as text (h(), mdView).
import { icon } from '../icons.js';
import { BARE, add, api, closeWindow, confirmSheet, fill, goTo, h, link, machine, prefs, toast } from '../lib.js';
import { registerPage, registerSessionAction } from '../registry.js';
import { pageNotify, store } from '../store.js';
import { forgetHere, named, wayBack, windowWay } from '../trail.js';
import { agentsStrip } from './agents.js';
import { createComposer } from './composer.js';
import { createHeader, openEditor } from './header.js';
import { helpSheet, installKeys, shortcutsSheet } from './keys.js';
import { limitCard } from './limit.js';
import { handsOffBar, openConsentSheet } from '../handsoff.js';
import { createRail, folderNews } from './rail.js';
import { partsSheet } from './parts.js';
import { archiveSession, createSidebar, deletableHere, nameOf, sideFits } from './sidebar.js';
import { createDiffPane } from './diffpane.js';
import { openNewSession } from '../newsession-popup.js';
import { chooseRewind, historySheet, rewindSheet } from './sheets.js';
import { deleteNow, pickToDelete, trashSheet } from './deletes.js';
import { createStatusLine } from './statusline.js';
import { createTermPane } from './termpane.js';
import { follow } from './stream.js';
import { createTimeline } from './timeline.js';
import { opensAsChat } from './start.js';
import { backWords, beforeState, billed, canCompact, caps as capsOf, failText, goneWords, planModes, toolWord, turnRuns, viewChoices } from './words.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function viewChat({ sub }) {
  const id = String(sub || '');
  if (!ID_RE.test(id)) {
    location.replace(link('#/'));
    return () => {};
  }
  const A = `/api/chats/${id}`;
  const app = document.getElementById('app');
  document.body.classList.remove('has-nav');
  document.body.classList.add('chat-mode');
  store.viewing = `chat:${id}`;
  named('App');
  // The page you came from (trail.js), else Home; in a window of the desktop the way back stays in its app, and a
  // window that started on this chat has none (null).
  const inWindow = windowWay();
  const way = inWindow || wayBack() || { hash: link('#/'), label: 'Home' };
  let v = null; // the chat's state: the first look's, then each new state merged in

  // ---------- actions ----------
  const act = {
    async stop() {
      try {
        // The messages sent while it worked come back into the box: after Stop nothing starts by itself.
        const r = await api(`${A}/stop`, {});
        const back = (r && r.back) || [];
        if (back.length) {
          composer.putBack(back.map((x) => x.text).join('\n\n'));
          // The box shows the words; only files that must be attached again are said (under the head, chat.css).
          const files = back.flatMap((x) => x.files || []);
          if (files.length) toast(backWords(back.length, files.length));
        }
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    },
    async stopTask(taskId) {
      try {
        await api(`${A}/tasks/${encodeURIComponent(taskId)}/stop`, {});
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    },
    async compact() {
      try {
        await api(`${A}/send`, { text: '/compact' });
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    },
    // Clear: a new chat in the same folder with the same settings; this conversation is kept (and can be resumed).
    async clear({ title = '' } = {}) {
      if (!(await confirmSheet({ title: 'Clear: start a new session?', text: `A new session${title ? ` named “${title.slice(0, 80)}”` : ''} starts in this folder with the same coding tool, provider, mode, model, effort and ultracode. This conversation is kept: you can continue it later.`, ok: 'New session' }))) return;
      try {
        const r = await api('/api/chats', { dir: v.cwd, tool: v.engine ? v.engine.id : undefined, profile: v.profile.name, model: v.model, effort: v.effort, permissionMode: v.permissionMode });
        if (v.ultracode) await api(`/api/chats/${r.id}/settings`, { ultracode: true });
        if (title) await api(`/api/chats/${r.id}/title`, { title: title.slice(0, 80) }).catch(() => {});
        if (!v.working && !v.pending.length) await api(`${A}/close`, {}).catch(() => {});
        store.refresh();
        location.hash = link(`#/chat/${r.id}`);
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    },
    // Hands-off for this session (its menu): on, or stopped at once.
    async handsOff() {
      const on = !(v && v.handsOff && v.handsOff.on);
      try {
        await api(`${A}/handsoff`, { on });
        if (on === true) openConsentSheet(); // the first time any switch is turned on, this browser sees the sheet once
        toast(on ? 'Hands-off is on for this session' : 'Hands-off stopped for this session');
      } catch (e) {
        toast(e, { kind: 'error' });
      }
    },
    // Archive (the session menu): no question, a toast with Undo (sidebar.js archiveSession); a question only for a working
    // session, or a branch of its own with changes not committed.
    async close() {
      await archiveSession({
        chatId: id, cwd: v && v.cwd, working: !!(v && (v.working || v.pending.length)),
        refresh: () => store.refresh(),
        gone: () => {
          forgetHere();
          if (inWindow !== null) location.hash = way.hash;
          else if (!closeWindow()) gone();
        },
      });
    },
    // Delete (the session menu): to the trash, with Undo on the toast; the page goes Home as after Archive.
    parts: () => partsSheet(A), // Lead model: who did what, at every width
    async remove() {
      const r = await deleteNow({ chats: [id] }, [(v && v.title) || 'New session'], { after: () => store.refresh() });
      if (!r || !r.deleted.length) return;
      forgetHere();
      if (inWindow !== null) location.hash = way.hash;
      else if (!closeWindow()) gone({ data: { closed: { cwd: v.cwd, title: v.title, tool: v.engine && v.engine.id, conversationId: null, deleted: true } } });
    },
    // The session menu where no session list is drawn (a phone, a narrow window): the trash, and Select to delete.
    trash: () => trashSheet({ after: () => store.refresh() }),
    async pickDelete() {
      const r = await pickToDelete(deletableHere(store), nameOf, { after: () => store.refresh() });
      if (r && r.deleted.some((x) => x.chat === id) && !machine.current) location.hash = link('#/');
    },
    // The title bar's Terminal button and Ctrl+`: a shell under the chat (termpane.js). The hand-off to a terminal
    // session is terminal() below (the session menu's Open in > Continue in Terminal).
    termPane: () => termPane.toggle(),
    async terminal() {
      // A terminal runs the conversation already: that is where it goes on (the server never starts a second one).
      if (v && v.terminal) {
        if (v.terminal.name) goTo(`#/s/${encodeURIComponent(v.terminal.name)}`);
        else toast('This conversation runs in a terminal outside the dashboard.', { kind: 'error' });
        return;
      }
      const tool = v && v.engine && v.engine.id !== 'claude' ? v.engine.label : 'Claude Code';
      if (!(await confirmSheet({ title: 'Open in the Terminal?', text: `The same conversation continues in a terminal session, with ${tool} as you know it. The App closes it here; you can open the session in the App again from its menu.`, ok: 'Open in Terminal' }))) return;
      try {
        const { name, existing } = await api(`${A}/terminal`, {});
        store.refresh();
        if (!existing) forgetHere(); // the chat closes: the terminal goes back to where the chat would have
        goTo(`#/s/${encodeURIComponent(name)}`);
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    },
    async moveTo(name, label) {
      try {
        await api(`${A}/provider`, { profile: name });
        toast(`The next message goes to ${label}`);
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    },
    history: () => v && historySheet({ A, v }),
    // A new App session on a copy of this conversation (the server makes it); this one stays as it is. As Claude Code:
    // Branch (the session menu, /branch [name]) switches into the copy; /fork [prompt] keeps working here, the copy
    // goes on in the session list (with the prompt as its first message, when one is given).
    async fork({ stay = false, title = '', prompt = '' } = {}) {
      try {
        const r = await api(`${A}/fork`, {});
        if (title) await api(`/api/chats/${r.id}/title`, { title: title.slice(0, 80) }).catch(() => {});
        if (prompt) await api(`/api/chats/${r.id}/send`, { text: prompt });
        store.refresh();
        if (stay) return toast(`Forked: the copy is in the session list${prompt ? ' and works on your prompt' : ''}; you go on here`);
        location.hash = link(`#/chat/${r.id}`);
        toast('Branched: this is a copy of the conversation; the original stays in its own session');
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    },
    diff: () => diffPane.open(), // the title bar's Changes, the rail's Changes card
    rewind: () => v && chooseRewind({ A, cwd: v.cwd, messages: timeline.messages(), conversation: canFork(), put: (t) => composer.putBack(t) }),
    shortcuts: () => shortcutsSheet(),
    tasks: () => strip.open(), // the more menu's Background tasks (the strip is made below; called after)
    async take() {
      if (!(await confirmSheet({ title: 'Continue here?', text: `${toolWord(v)} stops in the terminal (the terminal stays, as a plain shell) and the conversation goes on here in the App. A reply the terminal is writing right now is cut off.`, ok: 'Continue here' }))) return;
      try {
        await api(`${A}/take`, {});
        toast('The conversation continues here');
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    },
  };

  // ---------- layout ----------
  // The session menu's Transcript view sets the timeline's (drawn below); the status line and the rail say the cost in
  // Verbose only. The rail's Hide / Show is in the head (the rail is drawn below).
  const view = {
    now: () => timeline.view(), thought: () => timeline.thought(),
    set(x) {
      timeline.setView(x);
      if (v) state({});
    },
  };
  const railCtl = { hidden: () => rail.hidden(), toggle: () => rail.toggle() };
  // The session list's Hide / Show (sidebar.js), remembered in this browser as chat.side = off; the head's first button.
  let sideOver = false; // the list is open over the chat (narrower than its width)
  const sideCtl = BARE ? null : {
    hidden: () => (sideFits() ? prefs.get('chat.side', 'on') === 'off' : !sideOver),
    toggle() {
      if (!sideFits()) return side.overlay(); // narrower than the list's width: over the chat (sidebar.js), not remembered
      prefs.set('chat.side', this.hidden() ? 'on' : 'off');
      wrap.classList.toggle('chat-side-off', this.hidden());
      header.paintSide();
    },
  };
  const header = createHeader({ A, way: inWindow === null ? null : way, act, view, rail: railCtl, side: sideCtl });
  const notes = h('div.chat-notes'); // a terminal runs it, a limit
  const conn = h('div.chat-conn'); // the connection
  const scroll = h('div.chat-scroll', { role: 'region', 'aria-label': 'Conversation', tabindex: '-1' });
  const caps = () => capsOf(v);
  // Never while a terminal runs the conversation: a rewind runs Claude Code on it (one place at a time).
  const canRewind = () => !!(v && (caps().rewind || caps().fork) && !v.terminal);
  const canFork = () => !!caps().fork;
  const timeline = createTimeline({
    scroll, A, cwd: () => (v ? v.cwd : ''), stopTask: act.stopTask, after: () => store.refresh(), who: () => toolWord(v), provider: () => (v ? { profile: v.profile || null, tool: v.engine && v.engine.id, remote: !!machine.current } : null), canStopTask: () => !v || caps().stopTask !== false,
    modes: () => planModes(v), // a plan's answers: auto mode only once the session showed it has it
    canRewind: () => !v || canRewind(), // before the first state: drawn, and hidden by the state's class if not
    rewind: (m) => rewindSheet({ A, cwd: v ? v.cwd : '', m, conversation: canFork(), put: (t) => composer.putBack(t) }),
  });
  add(scroll, timeline.el);
  const todos = h('div.chat-todos');
  const strip = agentsStrip({ stop: (taskId) => act.stopTask(taskId), canStop: () => !v || caps().stopTask !== false, jump: (toolId) => timeline.jump(toolId), output: (taskId) => api(`${A}/tasks/${taskId}/output`) });
  // The page's own "/" commands (popovers.js lists them with the coding tool's, by name, as Claude Code's / menu): its
  // words where Claude Code has the command, and what each does here where that differs (/clear opens a new session,
  // /config Hoprig's Settings). One with a hint goes into the box first, for its argument (/compact's focus).
  const own = () => [
    // Compact is Claude Code's own, and a message: not where the coding tool has none, nor while the box is read only.
    canCompact(v) ? { name: 'compact', hint: '[instructions]', description: 'Free up context by summarizing the conversation so far. Optionally pass focus instructions for the summary', run: act.compact } : null,
    // `args`: what the command takes after its name, as Claude Code's (/model sonnet): typed whole, the page does it
    // (composer.js ownSlash); picked from the menu, it runs at once. Hoprig's own commands (not Claude Code's) say so.
    { name: 'clear', args: '[name]', description: 'Start a new conversation with empty context: a new session in this folder with the same settings; this one is kept', run: () => act.clear(), arg: (t) => act.clear({ title: t }) },
    { name: 'config', description: 'Open Settings', run: () => goTo('#/settings') },
    { name: 'model', args: '[model]', description: 'Switch the AI model', run: () => composer.choose('model'), arg: (t) => composer.setChoice('model', t) },
    { name: 'effort', args: '[level|auto]', description: 'Set the effort level', run: () => composer.choose('effort'), arg: (t) => composer.setChoice('effort', t) },
    { name: 'mode', description: `Hoprig: what ${toolWord(v)} may do without asking (the permission mode; Shift+Tab too)`, run: () => composer.chooseMode() },
    { name: 'resume', description: 'Resume a conversation: the earlier conversations of this folder', run: act.history },
    canRewind() ? { name: 'rewind', description: 'Rewind the conversation and/or code to a previous point', run: act.rewind } : null,
    canFork() ? { name: 'branch', args: '[name]', description: 'Create a branch of the current conversation at this point and switch into it; the original stays', run: () => act.fork(), arg: (t) => act.fork({ title: t }) } : null,
    canFork() ? { name: 'fork', args: '[prompt]', description: 'Copy this conversation into a new session and keep working here; a prompt goes to the copy', run: () => act.fork({ stay: true }), arg: (t) => act.fork({ stay: true, prompt: t }) } : null,
    v && v.terminal ? { name: 'terminal', description: 'Hoprig: go to the terminal that runs this conversation', run: act.terminal } : { name: 'terminal', description: 'Hoprig: open this conversation in the Terminal', run: act.terminal },
    { name: 'help', description: 'Show help and available commands', run: () => helpSheet(own(), composer.commands()) },
  ].filter(Boolean);
  // A first look: fewer than three chats on this computer (Home's list), so the composer keeps its row short.
  const firstLook = () => ((store.data && store.data.sessions) || []).filter((s) => s.kind === 'chat').length < 3;
  const composer = createComposer({ A, id, stop: act.stop, compact: act.compact, own, firstLook });
  const status = createStatusLine();
  // The limit banner sits right above the box, where the eye is when a message does not go (limit.js).
  const limitSlot = h('div.chat-limitslot');
  const dock = h('div.chat-dock', h('div.chat-col', todos, strip.el, limitSlot, composer.el, status.el));
  const rail = createRail({
    A, view: () => timeline.view(), computer: () => (store.data && store.data.machineLabel) || 'This computer',
    stop: (taskId) => act.stopTask(taskId), canStop: () => !v || caps().stopTask !== false, jump: (toolId) => timeline.jump(toolId),
    changes: () => act.diff(), send: (text) => api(`${A}/send`, { text }), providers: () => header.providerMenu(), tasks: () => strip.open(),
    onToggle: (off) => {
      wrap.classList.toggle('chat-rail-off', off);
      if (v) header.paint(v); // its Hide / Show button says the other now
    },
  });
  // The session list at the left on a wide screen (sidebar.js), not inside a window of the desktop (its own Sessions
  // app lists them there). At its right the head, the chat and its dock in one column, and the session rail (rail.css).
  const side = BARE ? null : createSidebar({ store, current: { chat: id, machine: machine.current ?? null }, newSession: () => openNewSession({ m: machine.current ?? null }), onOverlay: (on) => {
    sideOver = on;
    header.paintSide();
  } });
  // The diff pane (diffpane.js): beside the chat, in the rail's place while it is open; comments go as one message.
  const diffPane = createDiffPane({
    A, send: (text) => api(`${A}/send`, { text }), editor: () => v && openEditor(v.cwd, 'changes'),
    onToggle: (on) => wrap.classList.toggle('chat-diff-open', on),
  });
  const termPane = createTermPane({ id, cwd: () => (v ? v.cwd : ''), onToggle: (on) => header.paintTerm(on) });
  const pane = h('div.chat-pane', header.el, notes, conn,
    h('div.chat-body', h('div.chat-main', h('div.chat-mid', scroll, timeline.downBtn), dock, termPane.el), diffPane.el, rail.el));
  const wrap = h(`div.chat-wrap${rail.hidden() ? '.chat-rail-off' : ''}${side ? '.chat-has-side' : ''}${side && sideCtl.hidden() ? '.chat-side-off' : ''}`, side && side.el, pane);
  fill(app, wrap);
  fill(timeline.el.querySelector('.chat-list'), h('div.chat-loading', h('div.spinner', { 'aria-hidden': 'true' })));

  // The height follows the visual viewport: the message box stays above an open phone keyboard.
  const vv = window.visualViewport;
  const onViewport = () => {
    if (!vv) return;
    wrap.style.setProperty('--vvh', `${vv.height}px`);
    wrap.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);
  onViewport();
  // The chat's toasts sit under the head and the banners under it (a terminal runs it, a limit, the connection),
  // where they cover none of their buttons (chat.css: --chat-toast-top).
  const toastPlace = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    document.body.style.setProperty('--chat-toast-top', `${Math.round(Math.max(...[header.el, notes, conn].map((x) => x.getBoundingClientRect().bottom)))}px`);
  }) : null;
  for (const x of [header.el, notes, conn]) toastPlace?.observe(x);

  // ---------- the to-do list (one line on a phone until opened) ----------
  let todosOpen = prefs.get('chat.todos', !matchMedia('(max-width: 599px)').matches);
  function paintTodos(items) {
    if (!items || !items.length) return fill(todos);
    const done = items.filter((t) => t.status === 'completed').length;
    const now = items.find((t) => t.status === 'in_progress');
    const head = h('button.chat-todos-head', { type: 'button', 'aria-expanded': String(todosOpen), onclick: () => {
      todosOpen = !todosOpen;
      prefs.set('chat.todos', todosOpen);
      paintTodos(items);
    } }, icon(todosOpen ? 'chevronDown' : 'chevronRight', { size: 14 }), h('strong', `To-do ${done}/${items.length}`), now ? h('span.chat-todo-now', now.activeForm || now.content) : null);
    fill(todos, head, todosOpen ? h('ul.chat-todo-list', items.map((t) => h(`li.t-${t.status}`, h('span.chat-todo-mark', { 'aria-hidden': 'true' }, t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'), h('span', t.content)))) : null);
  }

  // ---------- following the server ----------
  function state(s) {
    const before = v ? v.status : null;
    const folder = v ? v.cwd : null;
    v = { ...(v || {}), ...s };
    if (Number.isFinite(s.now)) v.skew = Date.now() - s.now; // this computer's clock against the chat's (a tool's seconds)
    if (v.cwd && v.cwd !== folder) timeline.folder(v.cwd); // cards drawn before the folder was known
    if (before && before !== v.status) store.refresh(); // Home's copy is old: an OK is needed, or was given
    header.paint(v);
    pageNotify.setTitleBase(v.title || 'App');
    named(v.title || 'App');
    const ro = !!v.terminal;
    // Its coding tool was turned off since the chat opened: it runs nothing, and the page says so instead of inviting
    // a message (what OpenCode's server still runs is shown, else nothing: no empty intro either).
    wrap.classList.toggle('chat-tool-off', !!v.toolOff);
    fill(notes,
      v.toolOff ? h('div.banner.warn.chat-banner', { role: 'status' }, icon('alert', { size: 18 }), h('span', `${v.toolOff}.`),
        h('span.chat-banner-actions', h('a.btn.small.secondary', { href: link('#/settings/new-sessions?show=coding-tools') }, 'Coding tools'))) : null,
      ro ? h('div.banner.warn.chat-banner', icon('terminal', { size: 18 }),
        h('span', v.terminal.name ? `This conversation runs in the terminal session "${v.terminal.name}". You can read along here; to write, continue it here.` : 'This conversation runs in a terminal outside the dashboard. You can read along here; to write, continue it here.'),
        h('span.chat-banner-actions',
          h('button.btn.small.primary', { type: 'button', onclick: () => act.take() }, 'Continue here'),
          v.terminal.name ? h('a.btn.small.secondary', { href: link(`#/s/${encodeURIComponent(v.terminal.name)}`), onclick: (e) => BARE && (e.preventDefault(), act.terminal()) }, 'Open the terminal') : null)) : null,
      // Hands-off (web/handsoff.js): while it is on, stopped by a loop, or turned off by an update; one press stops it.
      v.handsOff && (v.handsOff.on || v.handsOff.loop || v.handsOff.stale || v.handsOff.own) ? handsOffBar(v.handsOff, async (on) => {
        const r = await api(`${A}/handsoff`, { on });
        if (on === true) openConsentSheet(); // the first time any switch is turned on, this browser sees the sheet once
        return r;
      }, null, { app: true }) : null);
    fill(limitSlot, limitCard(v, { id, moveProvider: header.providerMenu })); // right above the box, where the eye is
    wrap.classList.toggle('chat-no-rewind', !canRewind());
    composer.paint(v);
    status.paint(v, { view: timeline.view() });
    rail.paint(v);
    strip.paint(v.tasks, v.skew);
    timeline.tasks(v.tasks);
    timeline.liveState(v.live);
    timeline.billed(billed(v));
    if (Array.isArray(v.pending)) timeline.pending(v.pending);
    paintTodos(v.todos);
  }
  // A chat that is not open any more (closed, cleared, opened in a terminal) offers only what still makes sense: read
  // what was drawn, continue the conversation in a new chat, go back. Its head and its cards act on nothing.
  let said = false; // the conversation has a message: there is something to continue
  function gone(e) {
    unfollow();
    rail.stop(); // the rail is not drawn any more
    diffPane.close();
    unkeys(); // Esc, Shift+Tab, a number: the page's keys act on nothing now (gone only comes after a request)
    forgetHere(); // a chat that is not open any more is never a way back
    // What is known of it: as the server remembers a chat it closed (it names the conversation only when there is one
    // to continue), else as the page saw it while it was open (a message was said in it).
    const was = (e && e.data && e.data.closed) || (v && v.cwd && v.conversationId && said ? v : null);
    const known = !!(was && was.cwd && was.conversationId); // its conversation can go on in a new chat
    header.closed(was && was.title);
    wrap.classList.add('chat-closed', 'chat-no-rewind');
    // In its own coding tool (a conversation stays in the tool it was started with); Claude Code's is the default.
    // `fresh`: a new conversation in its folder (nothing was said in it, so there is nothing to continue).
    const again = async (fresh = false) => {
      try {
        const tool = (was.engine && was.engine.id) || was.tool;
        const r = await api('/api/chats', { dir: was.cwd, ...(fresh ? {} : { sessionId: was.conversationId }), ...(tool && tool !== 'claude' ? { tool } : {}) });
        store.refresh();
        const to = link(`#/chat/${r.id}`);
        // The new chat may take this address (a chat's id is its conversation's while that is free): the same
        // address fires no hashchange, so the page is drawn again by hand.
        if (location.hash === to) window.dispatchEvent(new HashChangeEvent('hashchange'));
        else location.hash = to;
      } catch (e) {
        toast(failText(e), { from: e, kind: 'error' });
      }
    };
    const words = goneWords(was);
    // Never a dead end: the terminal it went to, its conversation in a new App session, or a new session in its folder.
    const term = was && was.terminal ? h('a.btn.primary', { href: link(`#/s/${encodeURIComponent(was.terminal)}`) }, icon('terminal', { size: 18 }), h('span', 'Open its terminal')) : null;
    const go = known ? h(`button.btn.${term ? 'secondary' : 'primary'}`, { type: 'button', onclick: () => again() }, icon('text', { size: 18 }), h('span', 'Continue in the App'))
      : was && was.cwd ? h('button.btn.primary', { type: 'button', onclick: () => again(true) }, icon('plus', { size: 18 }), h('span', 'New session in this folder')) : null;
    // A deleted one: the trash first (Put back there, which draws this page again), a new session in its folder beside it.
    const bin = was && was.deleted ? h('button.btn.primary', { type: 'button', onclick: () => trashSheet({ after: () => store.refresh() }) }, icon('trashBack', { size: 18 }), h('span', 'Open the trash')) : null;
    if (bin && go) go.className = go.className.replace('primary', 'secondary');
    const lead = bin || term || go; // the one primary button
    // In a window of the desktop it also offers to close the window; a window that started on this chat has no way
    // back (trail.js windowWay), so closing is its way out.
    const shut = BARE ? h(`button.btn.${!lead && inWindow === null ? 'primary' : 'secondary'}`, { type: 'button', onclick: () => closeWindow() }, icon('x', { size: 18 }), h('span', 'Close window')) : null;
    const back = inWindow === null ? null : h(`a.btn.${lead ? 'secondary' : 'primary'}`, { href: way.hash }, icon(way.label === 'Home' ? 'home' : 'back', { size: 18 }), h('span', way.label === 'Home' ? 'Home' : `Back to ${way.label}`));
    if (!v || !scroll.querySelector('.chat-item, .chat-userrow')) {
      // Nothing of it was drawn here (or nothing was said in it: its "Write what … should do" would invite to type
      // where nothing can be sent): the conversation is read in the new chat, which shows it from its start.
      fill(pane, header.el, h('div.chat-mid', h('div.empty', icon('text', { size: 32 }), h('p', words), h('div.chat-gone-actions', bin, term, go, back, shut))));
      return;
    }
    fill(pane, header.el, h('div.chat-mid', scroll, timeline.downBtn),
      h('div.chat-dock', h('div.chat-col.chat-gone', h('p.chat-gone-text', words),
        h('div.chat-gone-actions', bin, term, go, back, shut))));
  }
  const unfollow = follow({
    A,
    remote: !!machine.current,
    events: (r) => {
      // On a fresh page the events come before the first state: drawn with its coding tool and modes (beforeState).
      v = beforeState(v, r);
      said = said || (r.events || []).some((x) => x.kind === 'user');
      timeline.apply(r);
      // A tool ran, a turn ended, a rewind of files: the rail asks what changed in the folder (and after a turn, what
      // fills the context).
      const news = folderNews(r);
      if (news === 'turn') {
        rail.turnEnded();
        diffPane.refresh(); // Claude may have changed the code the comments were about
      }
      else if (news) rail.changed();
    },
    state,
    live: (list) => timeline.live(list),
    gone,
    connection: (ok) => fill(conn, ok ? null : h('div.banner.warn.chat-banner', { role: 'status' }, icon('refresh', { size: 18 }), h('span', 'Connection lost. Reconnecting…'))),
  });

  // ---------- keys (keys.js) and files dropped on the page ----------
  // Esc and Stop end a turn: only while one runs (background work has its own Stop in the agents strip).
  // The desktop app's keys (keys.js desktopKeys): the menus at their controls, the next transcript view, the diff pane.
  const nextView = () => {
    if (!v) return;
    const list = viewChoices(timeline.view(), timeline.thought(), toolWord(v));
    const at = list.findIndex((x) => x.id === timeline.view());
    const to = list[(at + 1) % list.length];
    view.set(to.id);
    toast(`Transcript view: ${to.label}`);
  };
  const unkeys = installKeys({
    working: () => turnRuns(v), stop: act.stop, stopShell: () => composer.stopShell(), nextMode: () => composer.nextMode(), openAsk: () => timeline.openAsk(), box: composer.textarea,
    menu: (what) => (v && !v.terminal && !v.toolOff ? (what === 'mode' ? composer.chooseMode() : composer.choose(what, { byKey: true })) : null),
    view: nextView,
    diff: () => (diffPane.isOpen() ? diffPane.close() : act.diff()),
    terminal: () => act.termPane(),
    newSession: () => openNewSession({ m: machine.current ?? null }),
    rewind: () => canRewind() && act.rewind(),
    clearDraft: () => composer.clearDraft(),
    go: (d) => side && side.el.isConnected && side.go(d), // the session list is drawn from 900 px wide only
    side: () => sideCtl && sideFits() && sideCtl.toggle(),
  });
  const dropHint = h('div.chat-drop.hidden', { 'aria-hidden': 'true' }, h('div.chat-drop-box', icon('paperclip', { size: 28 }), h('p', 'Drop to send with your message')));
  add(wrap, dropHint);
  const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files') && !(v && v.terminal);
  let dragDepth = 0;
  wrap.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth += 1;
    dropHint.classList.remove('hidden');
  });
  wrap.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropHint.classList.add('hidden');
  });
  wrap.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault(); // or the browser opens the file instead
  });
  wrap.addEventListener('drop', (e) => {
    dragDepth = 0;
    dropHint.classList.add('hidden');
    if (!hasFiles(e)) return;
    e.preventDefault();
    composer.addFiles(e.dataTransfer.files);
  });

  return () => {
    composer.destroy(); // its microphone
    status.stop();
    strip.stopClock();
    rail.stop();
    side?.stop();
    header.stop(); // its session menu, drawn on the page's body
    unfollow();
    store.viewing = null;
    document.body.classList.remove('chat-mode');
    unkeys();
    vv?.removeEventListener('resize', onViewport);
    vv?.removeEventListener('scroll', onViewport);
    toastPlace?.disconnect();
    document.body.style.removeProperty('--chat-toast-top');
  };
}

registerPage({ id: 'chat', title: 'App', icon: 'text', navAs: 'home', perComputer: true, render: viewChat });

// The terminal session's "more" sheet: the same conversation in the App (it runs in the terminal until "Continue here").
registerSessionAction({
  id: 'open-chat',
  label: 'Open in the App',
  sub: 'The same conversation, without the terminal',
  icon: 'text',
  describe: (me) => {
    const s = ((store.data && store.data.sessions) || []).find((x) => x.name === me.name);
    if (!s || !s.sessionId) return null;
    // Only where that computer has a chat for the session's coding tool: else the conversation stays in its terminal.
    return opensAsChat(s, me.machine || null) ? {} : null;
  },
  run: async (me) => {
    try {
      const { id } = await api('/api/chats/from-session', { session: me.name });
      location.hash = link(`#/chat/${id}`, me.machine);
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  },
});
