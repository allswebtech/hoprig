// The one small interface between the MCP server and the dashboard: call(tool, args) → { text, isError }.
//
//   httpClient   the real one: POST <dashboard>/api/assistant/call with the assistant's bearer token. The
//                dashboard runs core.mjs, so every client sees the same validation, levels and cards.
//   localClient  an in-process core (tests, and a dashboard that hosts the assistant itself).
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';

export const CONVERSATION_HEADER = 'X-Hoprig-Conversation';
const CONV_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Where the dashboard keeps the token it made for the assistant (phase 2 writes it, mode 600). */
export const tokenFile = () => path.join(stateDir(), 'assistant-token');

/** What every tool call answers when the server was not told its dashboard's address; nothing is sent anywhere. */
export const NO_ADDRESS = 'Error: this MCP server was not told the address of its dashboard (HOPRIG_DASHBOARD_URL), so nothing was sent. Next: tell the owner to add it again with the command from Settings → Tia.';

/**
 * The dashboard address and token for `hoprig mcp`. The token: HOPRIG_ASSISTANT_TOKEN (the owner's own MCP
 * client, made in Settings → Tia), else the file HOPRIG_ASSISTANT_TOKEN_FILE or <stateDir>/assistant-token
 * (Tia's own engine). A file is read again on every call, so the token the dashboard rotates at each start is
 * picked up.
 */
export function clientSettings(env = process.env) {
  // Only the address it was given (HOPRIG_DASHBOARD_URL): never a default port or the config's. A server started
  // without it would otherwise reach whatever dashboard listens there, which may be another one than its own.
  const url = env.HOPRIG_DASHBOARD_URL || '';
  const fixed = env.HOPRIG_ASSISTANT_TOKEN || '';
  const file = env.HOPRIG_ASSISTANT_TOKEN_FILE || tokenFile();
  const token = fixed ? () => fixed : () => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return ''; // none yet: calls will say so
    }
  };
  const conv = env.HOPRIG_ASSISTANT_CONVERSATION || 'direct';
  return { url: url.replace(/\/+$/, ''), token, conversation: CONV_RE.test(conv) ? conv : 'direct' };
}

export function httpClient({ url, token, conversation = 'direct', fetchImpl = fetch, timeoutMs = 120_000 }) {
  return {
    async call(tool, args) {
      if (!url) return { isError: true, text: NO_ADDRESS };
      const bearer = typeof token === 'function' ? token() : token;
      if (!bearer) return { isError: true, text: 'Error: this MCP server has no token for the dashboard. Next: tell the owner to open the dashboard once (it creates the assistant token) and try again.' };
      let res;
      try {
        res = await fetchImpl(`${url}/api/assistant/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, [CONVERSATION_HEADER]: conversation },
          body: JSON.stringify({ tool, args: args ?? {} }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        return { isError: true, text: `Error: the dashboard is not reachable at ${url} (${e.name === 'TimeoutError' ? 'timed out' : 'connection failed'}). Next: tell the owner to start it (hoprig serve).` };
      }
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* not JSON */
      }
      if (res.status === 403 && body && body.code === 'tia-off') return { isError: true, text: 'Error: Tia is turned off. Next: the owner can turn her on in Settings → Tia.' };
      if (res.status === 401 || res.status === 403) return { isError: true, text: 'Error: the dashboard refused the assistant token. Next: tell the owner to check Settings → Tia.' };
      if (!res.ok || !body || typeof body.text !== 'string') return { isError: true, text: `Error: the dashboard answered ${res.status}${body && body.error ? `: ${String(body.error).slice(0, 200)}` : ''}. Next: try once more, then tell the owner.` };
      return { text: body.text, isError: body.isError === true };
    },
  };
}

export function localClient(core, { conversation = 'direct' } = {}) {
  return {
    async call(tool, args) {
      const r = await core.call(tool, args ?? {}, { conversation, actor: 'assistant' });
      return { text: r.text, isError: r.isError };
    },
  };
}
