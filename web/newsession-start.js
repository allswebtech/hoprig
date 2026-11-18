// Starting what the New session popup chose (newsession-popup.js): the App (POST /api/chats through startChat), the
// coding tool in a terminal (POST /api/sessions) or a plain terminal (POST /api/shells). What each sends is what the
// New session page sent before it became a popup.
import { startChat } from './chat/start.js';
import { ago, api, at, chooseSheet, link, servesTool, toast } from './lib.js';
import { markStarting } from './newsession.js';
import { terminalMode } from './newsession-tools.js';
import { store } from './store.js';

/** The popup's own address (#/new, #/m/<computer>/new). */
export const atNewAddress = () => /^#(\/m\/[a-z0-9][a-z0-9_-]{0,31})?\/new(\/here)?(\?|$)/.test(location.hash || '');

/**
 * Start in folder `f` ({ path, name }). o: { st (the popup's choices), pc (the computer's state), way ('chat' |
 * 'claude' | 'shell'), info (another tool's modes, or null), toolName, busy(text), failed(error), leave(hash) (close the
 * popup and go there), picking() (the list of conversations takes the popup's place) }.
 */
export async function startSession(f, { st, pc, way, info, toolName, busy, failed, leave, picking }) {
  if (way === 'shell') {
    busy('Opening a terminal…');
    try {
      const { name } = await api(at(st.m, '/api/shells'), { dir: f.path });
      leave(link(`#/s/${encodeURIComponent(name)}`, st.m));
    } catch (e) {
      failed(e);
    }
    return;
  }
  const tool = st.tool;
  if (!tool) return toast('No coding tool is ready on this computer yet.', { kind: 'error', ms: 6000 });
  const own = tool !== 'claude'; // another coding tool, with its own choices (its own body, `tool` named)
  // No provider chosen: none is sent, so the server takes the folder's default for the coding tool (the one it used
  // there last, else the Providers page's order: src/defaultprovider.mjs). An older computer (no `recommendedIn`, no
  // `toolDefaults`) does not choose by itself: it gets its recommended one, or the first that serves the tool.
  const firstServing = pc ? (pc.profiles.find((p) => !p.virtual && servesTool(p, tool)) || {}).name : null;
  if (!st.profile && !(tool === 'claude' ? pc && pc.recommended : firstServing)) return toast('No provider yet: add one under Providers first.', { kind: 'error', ms: 6000 });
  let mode = st.conversation === 'pick' ? 'resume' : st.conversation;
  let sessionId = null;
  if (mode !== 'new') {
    const q = new URLSearchParams({ path: f.path, ...(tool !== 'claude' ? { tool } : {}) });
    const { sessions: convs } = await api(at(st.m, `/api/folders/sessions?${q}`)).catch(() => ({ sessions: [] }));
    if (!convs.length) mode = 'new'; // nothing to continue in this folder: a new conversation
    else if (mode === 'resume') {
      picking();
      sessionId = await chooseSheet({ title: 'Pick a conversation', subtitle: tool === 'claude' ? f.name : `${f.name} · ${toolName}`, items: convs.map((c) => ({ value: c.id, label: c.title, sub: ago(c.at), icon: 'text' })) });
      if (!sessionId) {
        if (atNewAddress()) location.replace('#/');
        return;
      }
    } else if (way === 'chat' || own) sessionId = convs[0].id; // the newest one (Claude Code's terminal finds it itself)
  }
  if (way === 'chat') {
    busy(`Opening the App in ${f.name}…`);
    try {
      // What is not chosen here is left out: the server takes what the last session in the App had in this folder.
      const permissionMode = own && !((info && info.modes) || []).includes(st.permissionMode) ? '' : st.permissionMode;
      await startChat(f.path, { tool, sessionId, profile: st.profile, permissionMode, effort: st.effort, model: own ? '' : st.model }, st.m);
    } catch (e) {
      failed(e);
    }
    return;
  }
  busy(`Starting ${toolName} in ${f.name}…`);
  try {
    // Another coding tool asks first unless the owner chose otherwise; Claude Code takes Settings for what is left out.
    const body = own
      ? { tool, dir: f.path, profile: st.profile || (pc && !pc.toolDefaults ? firstServing : undefined), mode: sessionId ? 'resume' : mode === 'continue' ? 'continue' : 'new', sessionId, permissionMode: terminalMode(st.permissionMode), effort: st.effort || null }
      : { dir: f.path, profile: st.profile || (pc && !pc.recommendedIn ? pc.recommended : undefined), mode, sessionId, permissionMode: st.permissionMode || null, effort: st.effort || null, model: st.model || null };
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
