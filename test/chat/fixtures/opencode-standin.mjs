// A stand-in for OpenCode's server (2.3) that replays what the real one sent (opencode-events.jsonl, recorded from a
// real server through Hoprig's own one-per-computer server, paths made neutral): each message the chat sends plays
// the next recorded turn on the event stream. Where the real turn waited for the client (an OK, a Stop), the
// stand-in waits for the same call. Every request is kept in `calls`, so a test can say what the engine asked.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECORDED = fs.readFileSync(path.join(HERE, 'opencode-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
export const MESSAGES = JSON.parse(fs.readFileSync(path.join(HERE, 'opencode-messages.json'), 'utf8'));
export const SESSION_ID = RECORDED.find((x) => x.m.type === 'session.created').m.data.sessionID;
export const SECRET = 'the-server-password-of-the-test';
const KEY = 'sk-provider-key-that-must-stay-on-the-server';

/** The recorded turns: [{ text, steps: [{ event } | { wait: 'reply' | 'interrupt' }] }]. */
export function recordedTurns() {
  const turns = [];
  let t = null;
  for (const x of RECORDED) {
    if (x.dir === '>' && /\/prompt$/.test(x.m.p)) {
      t = { text: x.m.b.text, steps: [] };
      turns.push(t);
    } else if (!t) continue;
    else if (x.dir === '>' && /\/permission\/[^/]+\/reply$/.test(x.m.p)) t.steps.push({ wait: 'reply' });
    else if (x.dir === '>' && /\/interrupt$/.test(x.m.p)) t.steps.push({ wait: 'interrupt' });
    else if (x.dir === '<' && x.m.type !== 'server.connected') t.steps.push({ event: x.m });
  }
  return turns;
}

/** Start it. o: { turns (default: the recorded ones), title } → { port, secret, server, calls, close(), drop() } */
export async function standIn(o = {}) {
  const turns = (o.turns || recordedTurns()).map((t) => ({ ...t, steps: [...t.steps] }));
  const calls = [];
  const streams = new Set();
  const waiters = []; // { kind, resolve }
  const queue = []; // turns waiting for the one that runs: { turn, inboxId }
  let running = false;
  let next = 0;
  let title = o.title || 'Recorded session';
  let updated = 1000;
  let dir = '/work/proj'; // the folder of the conversation (the one it was made in)
  const send = (ev) => {
    for (const res of streams) res.write(`data: ${JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, ...ev })}\n\n`);
  };
  const came = (kind, body) => {
    const i = waiters.findIndex((w) => w.kind === kind);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(body);
  };
  const wait = (kind) => new Promise((resolve) => waiters.push({ kind, resolve }));
  async function play(turn) {
    running = true;
    for (const s of turn.steps) {
      if (s.wait) await wait(s.wait);
      else {
        send(s.event);
        await new Promise((r) => setImmediate(r));
      }
    }
    updated++;
    running = false;
    const n = queue.shift();
    if (n) play(n.turn);
  }
  const inboxOf = (turn) => (turn.steps.find((s) => s.event && s.event.type === 'session.inbox.enqueued') || { event: { data: { inboxID: `msg_${Date.now()}` } } }).event.data.inboxID;

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${SECRET}`).toString('base64')}`) return json(res, 401, { error: 'unauthorized' });
    calls.push({ method: req.method, path: p, query: url.search, body });
    if (p === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (p === '/api/info') return json(res, 200, { version: '2.3.0' });
    if (p === '/api/model') {
      return json(res, 200, { data: [{ id: 'sample-model', providerID: 'hoprig_demo_000001', settings: { apiKey: KEY }, variants: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id })), limit: { context: 200000, output: 32000 } }] });
    }
    if (p === '/api/session' && req.method === 'POST') {
      if (body.location && body.location.directory) dir = body.location.directory;
      return json(res, 200, { data: { id: SESSION_ID, model: body.model, permissions: body.permissions, location: body.location } });
    }
    // Like the real server asked with a filter it does not know: every folder's conversations.
    if (p === '/api/session' && req.method === 'GET') return json(res, 200, { data: [{ id: SESSION_ID, title, time: { created: 1, updated }, location: { directory: dir } }, { id: 'ses_elsewhere0001', title: 'Elsewhere', time: { created: 1, updated: 1 }, location: { directory: '/somewhere/else' } }] });
    const m = /^\/api\/session\/(ses_[A-Za-z0-9]+)(\/.*)?$/.exec(p);
    if (!m || m[1] !== SESSION_ID) return json(res, 404, { error: 'no such session' });
    const rest = m[2] || '';
    if (!rest && req.method === 'GET') return json(res, 200, { data: { id: SESSION_ID, title, time: { created: 1, updated } } });
    if (!rest && req.method === 'PATCH') {
      if (body && typeof body.title === 'string') title = body.title;
      return json(res, 200, null);
    }
    if (rest === '/message') return json(res, 200, { data: MESSAGES.data, cursor: { next: null } });
    if (rest === '/model') return json(res, 200, null);
    if (rest === '/prompt') {
      const turn = turns[next++] || { text: body.text, steps: [{ event: { type: 'session.execution.started', data: { sessionID: SESSION_ID } } }, { event: { type: 'session.execution.succeeded', data: { sessionID: SESSION_ID } } }] };
      const inboxId = inboxOf(turn);
      json(res, 200, { data: { id: inboxId, sessionID: SESSION_ID, type: 'user', payload: { text: body.text }, delivery: 'steer' } });
      if (running) queue.push({ turn, inboxId });
      else setImmediate(() => play(turn));
      return;
    }
    let r = /^\/inbox\/(msg_[A-Za-z0-9]+)$/.exec(rest);
    if (r && req.method === 'DELETE') {
      const i = queue.findIndex((q) => q.inboxId === r[1]);
      if (i < 0) return json(res, 409, { error: { message: 'already delivered' } });
      queue.splice(i, 1);
      send({ type: 'session.inbox.cancelled', data: { sessionID: SESSION_ID, inboxID: r[1] } });
      return json(res, 200, null);
    }
    r = /^\/permission\/(per_[A-Za-z0-9]+)\/reply$/.exec(rest);
    if (r) {
      json(res, 200, null);
      return came('reply', { request: r[1], ...body });
    }
    if (rest === '/interrupt') {
      json(res, 200, { interrupted: true });
      return came('interrupt', {});
    }
    r = /^\/form\/(frm_[A-Za-z0-9]+)(\/reply)?$/.exec(rest);
    if (r) {
      json(res, 200, null);
      return came('form', { form: r[1], method: req.method, ...body });
    }
    return json(res, 404, { error: `not in the stand-in: ${req.method} ${p}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port, secret: SECRET, key: KEY, calls,
    server: { tool: 'opencode', port, secret: SECRET, url: `http://127.0.0.1:${port}` },
    send,
    /** The event stream ends (the server stopped). */
    drop: () => {
      for (const s of streams) s.end();
      streams.clear();
    },
    close: () => new Promise((r) => {
      for (const s of streams) s.end();
      server.close(() => r());
      server.closeAllConnections?.();
    }),
  };
}

/** What a chat's engine is given to use the stand-in instead of a real server (engineOpts of the chat). */
export function standInOpts(s) {
  const ensure = async () => ({ ok: true, server: s.server });
  return {
    ensure,
    served: { ensure, providers: () => [{ name: 'gw', id: 'hoprig_demo_000001', model: 'sample-model' }], hold: () => () => {} },
    providerFor: (name) => ({ name, label: 'Gateway', kind: 'api' }),
  };
}
