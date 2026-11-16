// The chat with a coding tool (#/chat/<id>; #/m/<computer>/chat/<id> for another computer): coding without the
// terminal, as Claude Code works. The parts are modules of this folder: the head (header.js), the conversation
// (timeline.js with tools.js, diff.js, asks.js), the agents strip (agents.js), the composer (composer.js with its
// menus, popovers.js, and files, attach.js), the status line (statusline.js), the limit card (limit.js), the sheets of
// the history and the rewind (sheets.js) and the keys (keys.js); stream.js follows the server (src/chat/feature.mjs,
// live.mjs). Files dropped anywhere on the page go with the next message.
// Text from Claude, tools and files is only ever set as text (h(), mdView).
import { icon } from '../icons.js';
import { add, api, confirmSheet, fill, h, isClaudeCard, link, machine, prefs, toast } from '../lib.js';
import { registerPage, registerSessionAction } from '../registry.js';
import { pageNotify, store } from '../store.js';
import { forgetHere, named, wayBack } from '../trail.js';
import { agentsStrip } from './agents.js';
import { createComposer } from './composer.js';
import { createHeader } from './header.js';
import { installKeys, shortcutsSheet } from './keys.js';
import { limitCard } from './limit.js';
import { chooseRewind, historySheet, rewindSheet } from './sheets.js';
import { createStatusLine } from './statusline.js';
import { follow } from './stream.js';
import { createTimeline } from './timeline.js';
import { failText, turnRuns } from './words.js';

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
  named('Chat');
  const way = wayBack() || { hash: link('#/'), label: 'Home' }; // the page you came from (trail.js), else Home
  let v = null; // the chat's state: the first look's, then each new state merged in

  // ---------- actions ----------
  const act = {
    async stop() {
      try {
        // What was queued comes back into the box: after Stop nothing starts by itself.
        const r = await api(`${A}/stop`, {});
        const back = (r && r.back) || [];
        if (back.length) {
          composer.putBack(back.map((x) => x.text).join('\n\n'));
          const files = back.flatMap((x) => x.files || []);
          toast(`${back.length === 1 ? 'The queued message is' : 'The queued messages are'} back in the box${files.length ? `; attach ${files.length === 1 ? 'its file' : 'their files'} again` : ''}`);
        }
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    },
    async stopTask(taskId) {
      try {
        await api(`${A}/tasks/${encodeURIComponent(taskId)}/stop`, {});
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    },
    async compact() {
      try {
        await api(`${A}/send`, { text: '/compact' });
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    },
    // Clear: a new chat in the same folder with the same settings; this conversation is kept (and can be resumed).
    async clear() {
      if (!(await confirmSheet({ title: 'Clear: start a new chat?', text: 'A new chat starts in this folder with the same provider, mode, model, effort and ultracode. This conversation is kept: you can continue it later.', ok: 'New chat' }))) return;
      try {
        const r = await api('/api/chats', { dir: v.cwd, profile: v.profile.name, model: v.model, effort: v.effort, permissionMode: v.permissionMode });
        if (v.ultracode) await api(`/api/chats/${r.id}/settings`, { ultracode: true });
        if (!v.working && !v.pending.length) await api(`${A}/close`, {}).catch(() => {});
        store.refresh();
        location.hash = link(`#/chat/${r.id}`);
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    },
    async close() {
      if (!(await confirmSheet({ title: 'Close this chat?', text: 'Claude stops if it is working. The conversation is kept: you can continue it later from New session → Options → Conversation.', ok: 'Close', danger: true }))) return;
      try {
        await api(`${A}/close`, {});
        store.refresh();
        forgetHere();
        location.hash = way.hash;
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    },
    async terminal() {
      // A terminal runs the conversation already: that is where it goes on (the server never starts a second one).
      if (v && v.terminal) {
        if (v.terminal.name) location.hash = link(`#/s/${encodeURIComponent(v.terminal.name)}`);
        else toast('This conversation runs in a terminal outside the dashboard.', { kind: 'error' });
        return;
      }
      if (!(await confirmSheet({ title: 'Open in a terminal?', text: 'The same conversation continues in a terminal session, with Claude Code as you know it. This chat closes; you can open the session as a chat again from its menu.', ok: 'Open in terminal' }))) return;
      try {
        const { name, existing } = await api(`${A}/terminal`, {});
        store.refresh();
        if (!existing) forgetHere(); // the chat closes: the terminal goes back to where the chat would have
        location.hash = link(`#/s/${encodeURIComponent(name)}`);
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    },
    async moveTo(name, label) {
      try {
        await api(`${A}/provider`, { profile: name });
        toast(`The next message goes to ${label}`);
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    },
    history: () => v && historySheet({ A, v }),
    rewind: () => v && chooseRewind({ A, cwd: v.cwd, messages: timeline.messages(), conversation: canFork(), put: (t) => composer.putBack(t) }),
    shortcuts: () => shortcutsSheet(),
    async take() {
      if (!(await confirmSheet({ title: 'Continue here?', text: 'Claude stops in the terminal (the terminal stays, as a plain shell) and the conversation goes on in this chat. A reply the terminal is writing right now is cut off.', ok: 'Continue here' }))) return;
      try {
        await api(`${A}/take`, {});
        toast('The conversation continues here');
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    },
  };

  // ---------- layout ----------
  const header = createHeader({ A, way, act });
  const notes = h('div.chat-notes'); // a terminal runs it, a limit
  const conn = h('div.chat-conn'); // the connection
  const scroll = h('div.chat-scroll', { role: 'region', 'aria-label': 'Conversation', tabindex: '-1' });
  const caps = () => (v && v.engine && v.engine.capabilities) || {};
  // Never while a terminal runs the conversation: a rewind runs Claude Code on it (one place at a time).
  const canRewind = () => !!(v && (caps().rewind || caps().fork) && !v.terminal);
  const canFork = () => !!caps().fork;
  const timeline = createTimeline({
    scroll, A, cwd: () => (v ? v.cwd : ''), stopTask: act.stopTask, after: () => store.refresh(),
    canRewind: () => !v || canRewind(), // before the first state: drawn, and hidden by the state's class if not
    rewind: (m) => rewindSheet({ A, cwd: v ? v.cwd : '', m, conversation: canFork(), put: (t) => composer.putBack(t) }),
  });
  add(scroll, timeline.el);
  const todos = h('div.chat-todos');
  const strip = agentsStrip({ stop: act.stopTask, jump: (toolId) => timeline.jump(toolId) });
  // The page's own "/" commands, before the coding tool's (popovers.js).
  const own = () => [
    { name: 'compact', description: 'Claude goes on from a summary of the conversation, which frees context', run: act.compact },
    { name: 'clear', description: 'A new chat in this folder with the same settings; this one is kept', run: act.clear },
    { name: 'model', description: 'Choose the model', run: () => composer.choose('model') },
    { name: 'effort', description: 'Choose how hard Claude thinks', run: () => composer.choose('effort') },
    { name: 'mode', description: 'What Claude may do without asking', run: () => composer.chooseMode() },
    { name: 'history', description: 'Earlier conversations of this folder', run: act.history },
    canRewind() ? { name: 'rewind', description: 'Go back to before one of your messages: the files, the conversation or both', run: act.rewind } : null,
    v && v.terminal ? { name: 'terminal', description: 'Go to the terminal that runs this conversation', run: act.terminal } : { name: 'terminal', description: 'Open this conversation in a terminal', run: act.terminal },
    { name: 'help', description: 'Keyboard shortcuts', run: act.shortcuts },
  ].filter(Boolean);
  const composer = createComposer({ A, id, stop: act.stop, compact: act.compact, own });
  const status = createStatusLine();
  const dock = h('div.chat-dock', h('div.chat-col', todos, strip.el, composer.el, status.el));
  const wrap = h('div.chat-wrap', header.el, notes, conn, h('div.chat-mid', scroll, timeline.downBtn), dock);
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
    pageNotify.setTitleBase(v.title || 'Chat');
    named(v.title || 'Chat');
    const ro = !!v.terminal;
    fill(notes,
      ro ? h('div.banner.warn.chat-banner', icon('terminal', { size: 18 }),
        h('span', v.terminal.name ? `This conversation runs in the terminal session "${v.terminal.name}". You can read along here; to write, continue it here.` : 'This conversation runs in a terminal outside the dashboard. You can read along here; to write, continue it here.'),
        h('span.chat-banner-actions',
          h('button.btn.small.primary', { type: 'button', onclick: () => act.take() }, 'Continue here'),
          v.terminal.name ? h('a.btn.small.secondary', { href: link(`#/s/${encodeURIComponent(v.terminal.name)}`) }, 'Open the terminal') : null)) : null,
      limitCard(v, { id, moveProvider: header.providerMenu }));
    wrap.classList.toggle('chat-no-rewind', !canRewind());
    composer.paint(v);
    status.paint(v);
    strip.paint(v.tasks);
    timeline.tasks(v.tasks);
    timeline.liveState(v.live);
    if (Array.isArray(v.pending)) timeline.pending(v.pending);
    paintTodos(v.todos);
  }
  // A chat that is not open any more (closed, cleared, opened in a terminal) offers only what still makes sense: read
  // what was drawn, continue the conversation in a new chat, go back. Its head and its cards act on nothing.
  function gone(e) {
    unfollow();
    forgetHere(); // a chat that is not open any more is never a way back
    // What is known of it: as the page saw it while it was open, else as the server remembers a chat it closed.
    const was = v && v.cwd && v.conversationId ? v : (e && e.data && e.data.closed) || null;
    const known = !!(was && was.cwd && was.conversationId); // its conversation can go on in a new chat
    header.closed(was && was.title);
    wrap.classList.add('chat-closed', 'chat-no-rewind');
    const again = async () => {
      try {
        const r = await api('/api/chats', { dir: was.cwd, sessionId: was.conversationId });
        store.refresh();
        location.hash = link(`#/chat/${r.id}`);
      } catch (e) {
        toast(failText(e), { kind: 'error' });
      }
    };
    const back = h(`a.btn.${known ? 'secondary' : 'primary'}`, { href: way.hash }, icon(way.label === 'Home' ? 'home' : 'back', { size: 18 }), h('span', way.label === 'Home' ? 'Home' : `Back to ${way.label}`));
    const words = 'This chat is not open any more: it was closed, or opened in a terminal.';
    const go = known ? h('button.btn.primary', { type: 'button', onclick: again }, icon('text', { size: 18 }), h('span', 'Continue in a new chat')) : null;
    if (!v) {
      // Nothing of it was drawn here: the conversation is read in the new chat, which shows it from its start.
      fill(wrap, header.el, h('div.chat-mid', h('div.empty', icon('text', { size: 32 }), h('p', words), h('div.chat-gone-actions', go, back))));
      return;
    }
    fill(wrap, header.el, h('div.chat-mid', scroll, timeline.downBtn),
      h('div.chat-dock', h('div.chat-col.chat-gone', h('p.chat-gone-text', words),
        h('div.chat-gone-actions', go, back))));
  }
  const unfollow = follow({
    A,
    remote: !!machine.current,
    events: (r) => timeline.apply(r),
    state,
    live: (list) => timeline.live(list),
    gone,
    connection: (ok) => fill(conn, ok ? null : h('div.banner.warn.chat-banner', { role: 'status' }, icon('refresh', { size: 18 }), h('span', 'Connection lost. Reconnecting…'))),
  });

  // ---------- keys (keys.js) and files dropped on the page ----------
  // Esc and Stop end a turn: only while one runs (background work has its own Stop in the agents strip).
  const unkeys = installKeys({ working: () => turnRuns(v), stop: act.stop, nextMode: () => composer.nextMode(), openAsk: () => timeline.openAsk(), box: composer.textarea });
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
    status.stop();
    unfollow();
    store.viewing = null;
    document.body.classList.remove('chat-mode');
    unkeys();
    vv?.removeEventListener('resize', onViewport);
    vv?.removeEventListener('scroll', onViewport);
  };
}

registerPage({ id: 'chat', title: 'Chat', icon: 'text', navAs: 'home', perComputer: true, render: viewChat });

// The terminal session's "more" sheet: the same conversation as a chat (it runs in the terminal until "Continue here").
registerSessionAction({
  id: 'open-chat',
  label: 'Open as chat',
  sub: 'The same conversation, without the terminal',
  icon: 'text',
  describe: (me) => {
    const s = ((store.data && store.data.sessions) || []).find((x) => x.name === me.name);
    // A chat runs Claude Code: a Codex or OpenCode conversation stays in its terminal.
    return s && isClaudeCard(s) && s.sessionId ? {} : null;
  },
  run: async (me) => {
    try {
      const { id } = await api('/api/chats/from-session', { session: me.name });
      location.hash = link(`#/chat/${id}`, me.machine);
    } catch (e) {
      toast(failText(e), { kind: 'error' });
    }
  },
});
