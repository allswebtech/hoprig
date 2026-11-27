// Starting what the New session popup chose (newsession-popup.js): the App (POST /api/chats through startChat) or the
// coding tool in a terminal (POST /api/sessions). The popup asks for no provider, mode, effort, model or Lead: they are
// left out, so the server takes what the last chat in the folder had, else the folder's default provider and Settings
// → New sessions. The one exception: a terminal start on a computer that runs as root, whose default is Bypass, asks
// first (the server refuses Bypass there).
import { startChat } from './chat/start.js';
import { ago, api, at, chooseSheet, link, servesTool, toast } from './lib.js';
import { markStarting } from './newsession.js';
import { terminalMode } from './newsession-tools.js';
import { store } from './store.js';

// "Also open" (newsession-also.js): sent only where something is ticked; the server checks every name again.
const alsoOf = (st) => (Array.isArray(st.also) ? st.also : []);

/** The popup's own address (#/new, #/m/<computer>/new). */
export const atNewAddress = () => /^#(\/m\/[a-z0-9][a-z0-9_-]{0,31})?\/new(\/here)?(\?|$)/.test(location.hash || '');

/**
 * Start in folder `f` ({ path, name }). o: { st (the popup's choices), pc (the computer's state), way ('chat' |
 * 'claude'), toolName, busy(text), failed(error), leave(hash) (close the popup and go there), picking() (the list of
 * conversations takes the popup's place) }.
 */
export async function startSession(f, { st, pc, way, toolName, busy, failed, leave, picking }) {
  const tool = st.tool;
  if (!tool) return toast('No coding tool is ready on this computer yet.', { kind: 'error', ms: 6000 });
  const own = tool !== 'claude'; // another coding tool, with its own choices (its own body, `tool` named)
  // No provider chosen: none is sent, so the server takes the folder's default for the coding tool (the one it used
  // there last, else the Providers page's order: src/defaultprovider.mjs). An older computer (no `recommendedIn`, no
  // `toolDefaults`) does not choose by itself: it gets its recommended one, or the first that serves the tool.
  const firstServing = pc ? (pc.profiles.find((p) => !p.virtual && servesTool(p, tool)) || {}).name : null;
  if (!(tool === 'claude' ? pc && pc.recommended : firstServing)) return toast('No provider yet: add one under Providers first.', { kind: 'error', ms: 6000 });
  let mode = st.earlier === true ? 'resume' : 'new';
  let sessionId = null;
  if (mode === 'resume') {
    const q = new URLSearchParams({ path: f.path, ...(tool !== 'claude' ? { tool } : {}) });
    const { sessions: convs } = await api(at(st.m, `/api/folders/sessions?${q}`)).catch(() => ({ sessions: [] }));
    if (!convs.length) mode = 'new'; // nothing to continue in this folder: a new conversation
    else {
      picking();
      const newest = [...convs].sort((a, b) => (b.at || 0) - (a.at || 0));
      sessionId = await chooseSheet({ title: 'Pick a conversation', subtitle: tool === 'claude' ? f.name : `${f.name} · ${toolName}`, items: newest.map((c) => ({ value: c.id, label: c.title, sub: ago(c.at), icon: 'text' })) });
      if (!sessionId) {
        if (atNewAddress()) location.replace('#/');
        return;
      }
    }
  }
  if (way === 'chat') {
    busy(`Opening the App in ${f.name}…`);
    try {
      await startChat(f.path, { tool, sessionId, with: own ? [] : alsoOf(st), ...(!own && !sessionId && st.worktree === true ? { worktree: true } : {}) }, st.m);
    } catch (e) {
      failed(e);
    }
    return;
  }
  busy(`Starting ${toolName} in ${f.name}…`);
  try {
    // Another coding tool asks first; Claude Code takes Settings for what is left out (as root with Bypass as the
    // default: the mode that asks, which the server would otherwise refuse).
    const body = own
      ? { tool, dir: f.path, profile: pc && !pc.toolDefaults ? firstServing : undefined, mode: sessionId ? 'resume' : 'new', sessionId, permissionMode: terminalMode(''), effort: null }
      : { dir: f.path, profile: pc && !pc.recommendedIn ? pc.recommended : undefined, mode, sessionId, permissionMode: st.rootDefaultBypass ? 'manual' : null, effort: null, model: null, ...(alsoOf(st).length ? { with: alsoOf(st) } : {}) };
    const { name, chat, existing } = await api(at(st.m, '/api/sessions'), body);
    store.refresh();
    // The conversation runs in the App already (one conversation, one process): it goes on there.
    if (chat) return leave(link(`#/chat/${chat}`, st.m));
    if (!existing) markStarting(st.m, name, tool); // else it runs already: the terminal that has it opens
    leave(link(`#/s/${encodeURIComponent(name)}`, st.m));
  } catch (e) {
    failed(e);
  }
}
