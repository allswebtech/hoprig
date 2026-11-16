// Talking to the servers of src/codetools/servers.mjs: Codex's app server (JSON-RPC 2.0 over a WebSocket, one JSON
// object per message) and OpenCode's server (HTTP with a password, events as a server-sent stream).
import { EventEmitter } from 'node:events';
import { basicAuth } from './servers.mjs';
import { wsConnect } from './wsclient.mjs';

/**
 * A client of Codex's app server. `on('notification', (method, params) => …)`, `on('close', …)`, `call(method,
 * params)` resolves to the result or rejects with the server's message. Requests the server sends to clients (an
 * approval) are left to the terminal that started the turn: this client never answers them.
 */
export async function codexClient({ port, secret, name = 'hoprig', timeoutMs = 5000 }) {
  const ws = await wsConnect({ port, headers: { Authorization: `Bearer ${secret}` }, timeoutMs });
  const ee = new EventEmitter();
  const pending = new Map();
  let id = 0;
  ws.on('message', (text) => {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m && m.id !== undefined && m.id !== null && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(String(m.error.message || 'the server refused it')), { code: m.error.code }));
      else p.resolve(m.result);
    } else if (m && typeof m.method === 'string' && (m.id === undefined || m.id === null)) {
      ee.emit('notification', m.method, m.params || {});
    }
  });
  ws.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('the connection to the server ended'));
    pending.clear();
    ee.emit('close');
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await call('initialize', { clientInfo: { name, title: 'Hoprig', version: '0' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  return { call, on: (ev, fn) => ee.on(ev, fn), close: () => ws.close() };
}

/** A client of OpenCode's server: `req(method, path, body)` resolves to the parsed body ({ data } mostly). */
export function opencodeClient({ port, secret, fetchImpl = globalThis.fetch }) {
  const url = `http://127.0.0.1:${port}`;
  const headers = { authorization: basicAuth(secret) };
  async function req(method, p, body) {
    const r = await fetchImpl(`${url}${p}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    const text = await r.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (r.status >= 400) {
      const msg = (j && (j.error?.message || j.message || j.error)) || `status ${r.status}`;
      throw Object.assign(new Error(`OpenCode's server: ${String(msg).slice(0, 200)}`), { status: r.status });
    }
    return j;
  }
  /**
   * Follow the event stream: `onEvent({ type, data })` per event. Resolves when the stream ends (the server stopped)
   * or `signal` aborts it. The stream does not replay what was missed (OpenCode's own contract).
   */
  async function events(onEvent, { signal } = {}) {
    const r = await fetchImpl(`${url}/api/event`, { headers, signal });
    if (r.status !== 200 || !r.body) throw new Error(`OpenCode's event stream: status ${r.status}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try {
          const ev = JSON.parse(data);
          if (ev && typeof ev.type === 'string') onEvent(ev);
        } catch {
          /* a broken line: skip it */
        }
      }
      if (buf.length > 4 * 1024 * 1024) buf = ''; // a peer that never ends an event
    }
  }
  return { url, req, events };
}
