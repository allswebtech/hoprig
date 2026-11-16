// An OpenCode conversation read back from its store (GET /api/session/<id>/message of OpenCode 2.3: the messages it
// keeps, oldest first here) → the chat's events (src/chat/events.mjs), as opencode-events.mjs draws them live. What
// a subagent did inside is not read back (it is a conversation of its own); its call and its result are.
import { clipInput, clipText, oneLine, plainText } from '../events.mjs';
import { failedResult, filesDiff, pageTool } from './opencode-events.mjs';

const PAGE = 200; // messages per request
const PAGES_MAX = 10; // a longer conversation shows its newest 2000 messages

const EMPTY = () => ({ events: [], tasks: [], todos: [], title: '', size: 0 });

/** The events of a conversation's messages (oldest first). */
export function transcriptEvents(messages) {
  const events = [];
  const tasks = [];
  let turn = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const at = Number(m.time && m.time.created) || 0;
    if (m.type === 'user' && typeof m.text === 'string') {
      events.push({ kind: 'user', text: m.text, attachments: [], messageId: String(m.id || ''), at });
      turn = { at, usage: null };
    } else if (m.type === 'assistant' && Array.isArray(m.content)) {
      for (const [n, c] of m.content.entries()) {
        if (!c || typeof c !== 'object') continue;
        const blockId = `${m.id}:${n}`;
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) events.push({ kind: 'text', blockId, text: c.text, agent: null, at });
        else if (c.type === 'reasoning' && typeof c.text === 'string' && c.text.trim()) events.push({ kind: 'thinking', blockId, text: clipText(c.text, 20000), agent: null, at });
        else if (c.type === 'tool' && typeof c.id === 'string') {
          const s = c.state && typeof c.state === 'object' ? c.state : {};
          const p = pageTool(c.name, s.input);
          const title = plainText(String(p.input.command || p.input.file_path || p.input.url || p.input.pattern || p.input.query || p.input.description || p.name), 200);
          events.push({ kind: 'tool', id: c.id, name: p.name, title, toolKind: p.toolKind, input: clipInput(p.input), agent: null, at });
          if (s.status === 'completed' || s.status === 'error') {
            const ok = s.status === 'completed';
            // As drawn live (opencode-events.mjs): a call the owner stopped or refused is his act, not a failure.
            const r = ok ? { text: Array.isArray(s.content) ? s.content.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '' } : failedResult(s.error, s.metadata);
            const diff = ok ? filesDiff(s.metadata && s.metadata.files) : null;
            events.push({ kind: 'tool-result', id: c.id, ok, ...r, text: clipText(r.text), ...(diff ? { diff } : {}), agent: null, at });
          }
          if (p.toolKind === 'agent') tasks.push({ kind: 'task', taskId: `call-${c.id}`, toolId: c.id, type: 'agent', status: s.status === 'completed' ? 'completed' : s.status === 'error' ? 'failed' : 'stopped', title: plainText(String(p.input.description || 'Subagent'), 200) });
        }
      }
      if (turn && m.tokens) turn.usage = add(turn.usage, m.tokens);
    } else if (m.type === 'idle') {
      const ok = m.outcome === 'succeeded';
      events.push({ kind: 'turn-end', ok, subtype: m.outcome || null, error: ok ? null : m.outcome === 'interrupted' ? null : 'the turn failed', stopped: m.outcome === 'interrupted', usage: turn ? turn.usage : null, durationMs: turn && at ? Math.max(0, at - turn.at) : null, at });
      turn = null;
    }
  }
  return { events, tasks };
}

function add(u, t) {
  const n = (x) => (Number.isFinite(x) ? x : 0);
  const x = { input_tokens: n(t.input), output_tokens: n(t.output), cache_read_input_tokens: n(t.cache && t.cache.read), cache_creation_input_tokens: n(t.cache && t.cache.write) };
  return u ? Object.fromEntries(Object.keys(x).map((k) => [k, u[k] + x[k]])) : x;
}

/**
 * The conversation `id` from the server (client: clients.mjs opencodeClient): { events, tasks, todos, title, size }.
 * size: when it last changed (the chat reads it again when that moves).
 */
export async function readTranscript(client, id) {
  // Only OpenCode's own "no such conversation" is an empty one. A server that could not be asked (gone, refusing,
  // busy) fails the read, so the chat reads again at its next look instead of keeping an empty conversation.
  const info = await client.req('GET', `/api/session/${encodeURIComponent(id)}`).catch((e) => {
    if (e && e.status === 404) return null;
    throw e;
  });
  if (!info || !info.data) return EMPTY();
  const all = [];
  let cursor = null;
  for (let i = 0; i < PAGES_MAX; i++) {
    const q = new URLSearchParams({ limit: String(PAGE), order: 'desc', ...(cursor ? { cursor } : {}) });
    const j = await client.req('GET', `/api/session/${encodeURIComponent(id)}/message?${q}`);
    const list = Array.isArray(j && j.data) ? j.data : [];
    all.push(...list);
    cursor = j && j.cursor && j.cursor.next;
    if (!cursor || list.length < PAGE) break;
  }
  const { events, tasks } = transcriptEvents(all.reverse());
  const s = info.data;
  const title = typeof s.title === 'string' ? plainText(s.title, 200) : '';
  return { events, tasks, todos: [], title: title || oneLine((events.find((e) => e.kind === 'user') || {}).text || '', 80), size: Number(s.time && s.time.updated) || 0 };
}
