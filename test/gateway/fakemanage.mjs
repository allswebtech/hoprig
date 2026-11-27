// A stand-in for TRouteAI's management routes (the ones Hoprig's management client may send, src/gateway/trouteaimanage.mjs),
// at 127.0.0.1 on a port of its own. It checks the way the real one does: the command token (header x-trouteai-cli-token)
// for most routes, a key with the manage scope for the OAuth ones (they refuse the token). It answers with secret-looking
// fields on purpose, so a test can see that none comes through. Not the fake of test/gateway/fakegateway.mjs (that one
// speaks Claude's API).
import http from 'node:http';

export const CLI_TOKEN = 'cd'.repeat(32);
export const SECRET = ['sk-', 'super-secret-provider-key-0123456789abcdef'].join('');

/**
 * opts: { catalog: array | null (the route answers 404 when null), authLink: bool (POST /api/auth/link answers) }.
 * state: providers, combos, keys, calls ({ method, url, headers, body }), polls (how many polls answer pending first).
 */
// What the real gateway sends: a one-time code and a code challenge are 43 characters of base64url, as long as a key.
export const LINK_CODE = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDe4GhJkLmN7pQr';
export const CHALLENGE = 'Zy9wVu6sTr3qPo0nMl7kJi4hGf1eDc8bAz5YxWvUtSr';
export async function fakeManage({ catalog = null, authLink = false, pendingPolls = 1, quota = true } = {}) {
  let n = 0;
  const state = {
    calls: [],
    providers: [
      { id: 'p1', provider: 'openai', name: 'My OpenAI', apiKey: SECRET, accessToken: SECRET, refreshToken: SECRET, isActive: true, testStatus: 'active', lastTested: '2026-11-27T08:00:00Z', lastError: null, authType: 'apikey', providerSpecificData: { cookie: SECRET } },
      { id: 'p2', provider: 'gemini', name: 'Work Gemini', email: 'me@example.com', isActive: false, testStatus: 'error', lastError: `401 invalid key ${SECRET}`, errorCode: '401', authType: 'apikey' },
    ],
    combos: [{ id: 'c1', name: 'claude-sonnet', strategy: 'priority', models: ['openai/gpt-5', { model: 'gemini/gemini-3' }] }],
    keys: [{ id: 'k1', name: 'Hoprig sessions (box)', key: 'sk-masked****', scopes: [] }, { id: 'k2', name: 'My laptop', key: 'sk-masked****', scopes: ['manage'] }],
    bearers: new Map(),
    polls: 0,
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      state.calls.push({ method: req.method, url: req.url, headers: req.headers, body: json });
      const out = (s, b) => {
        res.writeHead(s, { 'content-type': 'application/json' });
        res.end(JSON.stringify(b));
      };
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const tokenOk = req.headers['x-trouteai-cli-token'] === CLI_TOKEN && !req.headers.forwarded && !req.headers['x-real-ip'];
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      const manageOk = !!bearer && state.bearers.has(bearer);
      const isOauth = p.startsWith('/api/oauth/');
      if (isOauth ? !manageOk : !tokenOk && !manageOk) return out(isOauth ? 401 : 403, { error: 'Unauthorized' });
      let m;
      if (req.method === 'GET' && p === '/api/providers') return out(200, { connections: state.providers, total: state.providers.length });
      if (req.method === 'POST' && p === '/api/providers') {
        if (!json?.apiKey) return out(400, { error: { message: 'API key is required' } });
        const c = { id: `p${++n + 2}`, provider: json.provider, name: json.name, apiKey: json.apiKey, isActive: true };
        state.providers.push(c);
        return out(201, { connection: c });
      }
      if (req.method === 'PATCH' && p === '/api/providers') {
        for (const id of json.ids) {
          const c = state.providers.find((x) => x.id === id);
          if (c) c.isActive = json.isActive;
        }
        return out(200, { message: `${json.isActive ? 'Activated' : 'Deactivated'} ${json.ids.length} connection(s)`, updated: json.ids.length, notFound: [] });
      }
      if ((m = /^\/api\/providers\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        const i = state.providers.findIndex((x) => x.id === m[1]);
        if (i < 0) return out(404, { error: 'Connection not found' });
        state.providers.splice(i, 1);
        return out(200, { message: 'Connection deleted successfully' });
      }
      if ((m = /^\/api\/providers\/([^/]+)\/test$/.exec(p)) && req.method === 'POST') {
        const c = state.providers.find((x) => x.id === m[1]);
        if (!c) return out(404, { error: 'Connection not found' });
        return out(200, c.id === 'p2' ? { valid: false, error: `Invalid API key ${SECRET}`, testedAt: '2026-11-27T09:00:00Z', accessToken: SECRET } : { valid: true, latencyMs: 120, testedAt: '2026-11-27T09:00:00Z' });
      }
      if (req.method === 'GET' && p === '/api/providers/catalog') return catalog ? out(200, { providers: catalog }) : out(404, { error: 'Connection not found' });
      if (req.method === 'GET' && p === '/api/usage/provider-limits') {
        return out(200, quota ? { caches: { p1: { plan: 'Pro', quotas: { session: { remainingPercentage: 62.4, resetAt: '2026-11-27T13:00:00Z', used: 38 }, weekly: { remaining: 10, total: 40, resetAt: 1796000000 } }, accessToken: SECRET }, p2: { plan: 'Free', quotas: { daily: { remainingPercentage: 90, resetAt: '2026-11-28T00:00:00Z' } } } }, intervalMinutes: 70 } : { caches: {} });
      }
      if ((m = /^\/api\/usage\/([^/]+)$/.exec(p)) && req.method === 'GET') return out(200, { plan: 'Pro', quotas: { session: { remainingPercentage: 50, resetAt: '2026-11-27T14:00:00Z' } } });
      if (req.method === 'GET' && p === '/api/combos') return out(200, { combos: state.combos, total: state.combos.length });
      if (req.method === 'POST' && p === '/api/combos') {
        if (!/^[a-zA-Z0-9_/.\-[\] ]+$/.test(json?.name || '')) return out(400, { error: { message: 'Invalid name' } });
        const c = { id: `c${++n + 1}`, name: json.name, models: json.models, strategy: json.strategy };
        state.combos.push(c);
        return out(201, c);
      }
      if ((m = /^\/api\/combos\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        const i = state.combos.findIndex((x) => x.id === m[1]);
        if (i < 0) return out(404, { error: 'Combo not found' });
        state.combos.splice(i, 1);
        return out(200, { success: true });
      }
      if (req.method === 'GET' && p === '/api/combos/builder/options') {
        return out(200, { schemaVersion: 1, providers: [
          { providerId: 'openai', displayName: 'OpenAI', activeConnectionCount: 1, models: [{ id: 'gpt-5', qualifiedModel: 'openai/gpt-5', name: 'GPT-5' }, { id: 'claude-sonnet-4-5', qualifiedModel: 'openai/claude-sonnet-4-5', name: 'Sonnet 4.5' }], connections: [{ id: 'p1', label: 'My OpenAI', lastError: SECRET }] },
          { providerId: 'gemini', displayName: 'Gemini', activeConnectionCount: 0, models: [{ id: 'gemini-3', qualifiedModel: 'gemini/gemini-3', name: 'Gemini 3' }] },
        ], comboRefs: [] });
      }
      if (req.method === 'GET' && p === '/api/keys') return out(200, { keys: state.keys, total: state.keys.length });
      if (req.method === 'POST' && p === '/api/keys') {
        const k = { id: `k${++n + 10}`, name: json.name, key: `sk-made-${n}-secretsecretsecret`, scopes: json.scopes || [] };
        state.keys.push({ ...k, key: 'sk-masked****' });
        if ((json.scopes || []).includes('manage')) state.bearers.set(k.key, k.id);
        return out(201, { key: k.key, name: k.name, id: k.id });
      }
      if ((m = /^\/api\/keys\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        const i = state.keys.findIndex((x) => x.id === m[1]);
        if (i < 0) return out(404, { error: 'Key not found' });
        state.keys.splice(i, 1);
        for (const [b, id] of [...state.bearers]) if (id === m[1]) state.bearers.delete(b);
        return out(200, { message: 'Key deleted successfully' });
      }
      if (req.method === 'POST' && p === '/api/auth/link') return authLink ? out(200, { url: `http://127.0.0.1:${srv.address().port}/login/link?code=${LINK_CODE}` }) : out(404, { error: 'not found' });
      if ((m = /^\/api\/oauth\/([^/]+)\/device-code$/.exec(p)) && req.method === 'GET') {
        return out(200, { device_code: 'dev-code-SECRET', user_code: 'ABCD-1234', verification_uri: 'https://example.com/device', interval: 5, expires_in: 600, codeVerifier: 'verifier-SECRET' });
      }
      if ((m = /^\/api\/oauth\/([^/]+)\/poll$/.exec(p)) && req.method === 'POST') {
        if (!json?.deviceCode) return out(400, { error: 'bad' });
        if (state.polls++ < pendingPolls) return out(200, { success: false, error: 'authorization_pending', pending: true });
        state.providers.push({ id: `p${++n + 2}`, provider: m[1], name: 'Signed in account', accessToken: SECRET, isActive: true });
        return out(200, { success: true, connection: { id: `p${n + 2}`, provider: m[1] } });
      }
      if ((m = /^\/api\/oauth\/([^/]+)\/authorize$/.exec(p)) && req.method === 'GET') {
        return out(200, { authUrl: `https://example.com/authorize?code_challenge=${CHALLENGE}&state=st-1&redirect_uri=${encodeURIComponent(url.searchParams.get('redirect_uri'))}`, state: 'st-1', codeVerifier: 'verifier-SECRET', redirectUri: url.searchParams.get('redirect_uri') });
      }
      if ((m = /^\/api\/oauth\/([^/]+)\/exchange$/.exec(p)) && req.method === 'POST') {
        if (!json?.code) return out(400, { error: { message: 'Invalid request' } });
        state.providers.push({ id: `p${++n + 2}`, provider: m[1], name: 'Linked account', accessToken: SECRET, isActive: true });
        return out(200, { success: true, connection: { id: `p${n + 2}`, provider: m[1], email: 'x@example.com' } });
      }
      return out(404, { error: 'no route' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, state, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); } };
}
