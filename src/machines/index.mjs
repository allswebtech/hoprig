// Several computers in one dashboard: the part the HTTP server calls.
//
// The server calls `handle(req, res)` at the top of every request and `upgrade(req, socket, head)` at the top of
// every WebSocket upgrade. Each resolves true when it answered, false when the server goes on as usual. After
// them, `authedByToken(req)` tells the server that a request came with a valid bearer token: such a request needs
// no cookie and no Origin check (it is not an ambient browser credential) and goes through the same validators.
//
// What a bearer token may reach: /api/* and /ws/term, except pairing, the token list, the machine list and relay
// (/m/..., so no chains: a machine never relays further), the password, login and logout.
//
// Routes answered here:
//   bearer or login  GET  /api/machine                       this computer: host name, OS, versions
//   bearer           POST /api/tokens/self/revoke            the token gives up its own right
//   login            GET  /api/joins, POST /api/joins { target } or { url, code, insecure, fingerprint } or { line, insecure }, POST /api/joins/<id>/leave
//                    POST /api/links/code, GET /api/links/code?id=  a code for a computer that connects by itself
//   link secret      POST /api/link/claim (the code instead), POST /api/link/leave, WebSocket /api/link
//                                                            this computer connecting by itself to another dashboard
//   no login         GET  /api/link/ca                       this hub's own certificate authority (public; hubcert.mjs)
//   no login         POST /api/pair/claim                    a pairing code for a token (rate-limited)
//   login            GET  /api/machines                      the other computers and their state
//                    POST /api/machine/label                 this computer's name next to the others
//                    GET  /api/machines/sessions             the sessions of every computer, in parallel
//                    POST /api/machines/ssh                  add by SSH: { target, name?, label? }
//                    POST /api/machines/url                  add by address + code: { url, code, name?, label? }
//                    POST /api/machines/install              install hoprig there over SSH: { target }
//                    GET  /api/machines/install?from=N       its output so far
//                    POST /api/machines/<name>/rename|remove|test
//                    GET  /api/tokens, POST /api/tokens/<id>/revoke   who may control this computer
//                    POST /api/pair/code, GET /api/pair/code?id=      a code for the page to show
//                    /m/<name>/api/*, /m/<name>/ws/term      relayed to that computer
//                    /m/<name>/<page or file>                this dashboard's own page (rewritten, see below)
import { RateLimiter } from '../server/auth.mjs';
import { createHub, HubError } from './hub.mjs';
import { JoinKeeper, joinByAddress, joinHub, leaveHub, loadJoined, publicJoined } from './join.mjs';
import { LinkHub, createLinkCode, linkCodeStatus } from './link.mjs';
import { loadConfig, saveConfig } from '../config.mjs';
import { hubCertificate, joinCommand } from './hubcert.mjs';
import { reachable } from '../addons/reach.mjs';
import { joinLine, parseJoinLine } from './joinline.mjs';
import { label as cleanLabel, machineName, tokenName } from './names.mjs';
import { claimCode, codeStatus, createCode, machineInfo } from './pairing.mjs';
import { errorBody, relayHttp, relayUpgrade, rejectUpgrade } from './relay.mjs';
import { getMachine } from './store.mjs';
import { legEncrypted, relayLeg } from './legs.mjs';
import { auditToken } from './tokenaudit.mjs';
import { bearerOf, createToken, listTokens, revokeToken, touchToken, verifyToken } from './tokens.mjs';

const BODY_MAX = 64 * 1024;
const TOKEN = Symbol('hoprig.token');

// Never reachable with a token, even where the server has the route.
const TOKEN_FORBIDDEN = [/^\/api\/assistant(?!\/run$)(\/|$)/, /^\/api\/machine\/label$/, /^\/api\/(login|logout|me)(\/|$)/, /^\/api\/settings\/password$/, /^\/api\/pair(\/|$)/, /^\/api\/tokens(\/|$)/, /^\/api\/machines(\/|$)/, /^\/api\/joins(\/|$)/, /^\/api\/links?(\/|$)/, /^\/api\/accounts(\/|$)/];
// The one token-list change a token may make: revoke itself (a hub that removes this computer gives its right back).
export const SELF_REVOKE = '/api/tokens/self/revoke';
/** The id of the machine token a request came with (after the gate let it in), or null: the owner's own login. */
export const tokenIdOf = (req) => (req && req[TOKEN] ? req[TOKEN].id : null);
export const tokenMayReach = (p) => p === SELF_REVOKE || (p.startsWith('/api/') && !TOKEN_FORBIDDEN.some((re) => re.test(p)));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return reject(new HubError(415, 'send JSON'));
    if (Number(req.headers['content-length'] || 0) > BODY_MAX) return reject(new HubError(413, 'too large'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(new HubError(413, 'too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(b && typeof b === 'object' && !Array.isArray(b) ? b : {});
      } catch {
        reject(new HubError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Claude Code's version on this computer, looked up at most every 10 minutes and waited for at most 4 s. */
function claudeVersionLookup() {
  let cache = null;
  let pending = null;
  return async () => {
    if (cache && Date.now() - cache.at < 10 * 60_000) return cache.v;
    pending ||= import('../claudecode.mjs')
      .then((cc) => cc.claudeInfo())
      .then((i) => (cache = { at: Date.now(), v: i.installed || null }).v)
      .catch(() => null)
      .finally(() => (pending = null));
    return Promise.race([pending, new Promise((r) => setTimeout(() => r(cache ? cache.v : null), 4000).unref())]);
  };
}

/**
 * The machines feature for the server's feature list (server.mjs): built from the server's ctx. `trusted(req)` tells
 * the server a request came with a valid bearer token.
 */
export function machinesFeature(ctx, opts = {}) {
  const m = createMachines({ authed: ctx.authed, originOk: ctx.originOk, clientIp: ctx.clientIp, localState: ctx.state, ...opts });
  // start: the reverse tunnels of the hubs this computer joined, kept by the service (they survive reboots).
  return { name: 'machines', handle: m.handle, upgrade: m.upgrade, trusted: m.authedByToken, start: () => m.joins.start(), close: m.close, machines: m };
}

/**
 * @param {object} o
 * @param {(req) => boolean} o.authed      the browser's login (cookie) is valid
 * @param {(req) => boolean} o.originOk    the request comes from this site (server's Origin check, with its proxy settings)
 * @param {(req) => string}  [o.clientIp]  the client address for the pairing rate limit
 * @param {() => Promise<object>} [o.localState]  this computer's /api/state, for the sessions of all computers
 * @param {object} [o.hub]                  a hub (createHub) or its options; tests pass fake ssh and timeouts here
 * @param {() => Promise<string|null>} [o.claudeVersion]
 * @param {number} [o.relayIdleMs]        how long a relayed request may sit with nothing moving
 */
export function createMachines({ authed, originOk, clientIp = (req) => (req.socket && req.socket.remoteAddress) || 'unknown', localState = null, hub: hubOpt = {}, claudeVersion = claudeVersionLookup(), pairLimiter = new RateLimiter(), relayIdleMs = 30_000, join: joinOpt = {}, certOf: certStandIn = null } = {}) {
  // Computers linked directly (link.mjs): their WebSocket, and the hub's local port for each while it is up.
  const links = new LinkHub({ clientIp, ...(hubOpt.link || {}) });
  // This hub's own certificate, for the join line: Caddy's authority as the link routes hand it out.
  // `certOf` (the demo, tests): a stand-in for what this hub's certificate is, without looking at a real one.
  const certOf = certStandIn || ((base) => hubCertificate(base, { root: () => links.authorityPem() }));
  const hub = typeof hubOpt.probe === 'function' ? hubOpt : createHub({ ...hubOpt, onRemove: (m) => m.via === 'link' && links.drop(m.linkId), linkEncrypted: (id) => links.encrypted(id) });
  const joinSsh = joinOpt.ssh || hubOpt.ssh || {};
  const joins = new JoinKeeper({ ssh: joinSsh, ...joinOpt });
  const info = async () => ({ ...machineInfo(), claude: await claudeVersion() });

  /** A request with a bearer token: answer it here when it must not go further, else mark it and let it pass. */
  function gate(req, p) {
    const entry = verifyToken(bearerOf(req));
    if (!entry) return { status: 401, body: { error: 'this computer does not accept that token (unknown or revoked)', code: 'token' } };
    if (!tokenMayReach(p) && p !== '/ws/term') return { status: 403, body: { error: 'not allowed from another dashboard', code: 'token-forbidden' } };
    req[TOKEN] = entry;
    touchToken(entry.id);
    return null;
  }

  async function claim(req, res) {
    const ip = clientIp(req);
    const wait = pairLimiter.retryAfter(ip);
    if (wait > 0) return send(res, 429, { error: `Too many tries. Wait ${Math.ceil(wait / 60000)} min.` }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
    const b = await readJson(req);
    pairLimiter.fail(ip); // counted before the check, as for the login
    const name = tokenName(b.name) || 'another computer';
    if (!claimCode(b.code, name)) return send(res, 403, { error: 'wrong or expired code', code: 'bad-code' });
    pairLimiter.succeed(ip);
    const { id, token } = createToken(name);
    return send(res, 200, { hoprig: 'pair', ...(await info()), token, tokenId: id });
  }

  // ---- routes behind the login: [method, regex, handler(req, match, query)] ----
  const routes = [
    ['GET', /^\/api\/machine$/, () => info()],
    ['GET', /^\/api\/machines$/, async (req, m, q) => ({ self: { ...(await info()), label: hub.hubLabel() }, hubName: hub.hubName, machines: await hub.list({ fresh: q.get('fresh') === '1' }) })],
    ['POST', /^\/api\/machine\/label$/, async (req) => {
      const b = await readJson(req);
      const l = cleanLabel(b.label);
      if (!l) throw new HubError(400, 'the name must be 1 to 40 characters on one line');
      saveConfig({ server: { machineLabel: l } });
      return { label: l };
    }],
    ['GET', /^\/api\/machines\/sessions$/, () => hub.sessions(localState)],
    ['POST', /^\/api\/machines\/ssh$/, async (req) => hub.addBySsh(await readJson(req))],
    ['POST', /^\/api\/machines\/url$/, async (req) => hub.addByUrl(await readJson(req))],
    ['POST', /^\/api\/machines\/install$/, async (req) => hub.install((await readJson(req)).target)],
    ['GET', /^\/api\/machines\/install$/, async (req, m, q) => hub.installStatus(Math.max(0, Number(q.get('from')) || 0))],
    ['POST', /^\/api\/machines\/([^/]+)\/rename$/, async (req, m) => hub.rename(m[1], await readJson(req))],
    ['POST', /^\/api\/machines\/([^/]+)\/remove$/, async (req, m) => {
      await readJson(req);
      return hub.remove(m[1]);
    }],
    ['POST', /^\/api\/machines\/([^/]+)\/test$/, async (req, m) => {
      await readJson(req);
      const mm = getMachine(m[1]);
      if (!mm) throw new HubError(404, 'no such computer');
      return { machine: await hub.probe(mm, { fresh: true }) };
    }],
    // ---- this computer joining another dashboard (join.mjs) ----
    ['GET', /^\/api\/joins$/, async () => ({ joined: loadJoined().map((h) => publicJoined(h, joins.status(h.id))) })],
    ['POST', /^\/api\/joins$/, async (req) => {
      const b = await readJson(req);
      // By the one pasted line ("Link to my main Hoprig"), by address and code (the direct link), or by SSH.
      if (b.line !== undefined) {
        const p = parseJoinLine(b.line);
        if (!p) throw new HubError(400, 'paste the whole line your main Hoprig shows, like https://pc.example.com#join=K7QM-4XP2');
        Object.assign(b, { url: p.url, code: p.code, fingerprint: p.fingerprint });
      }
      const h = b.url !== undefined
        ? await joinByAddress(b.url, b.code, { keeper: joins, insecure: b.insecure === true, fingerprint: typeof b.fingerprint === 'string' && b.fingerprint.trim() ? b.fingerprint.trim() : null })
        : await joinHub(b.target, { keeper: joins, ssh: joinSsh });
      return { joined: publicJoined(h, joins.status(h.id)), replaced: h.replaced === true };
    }],
    // ---- "Add a computer that connects by itself": the code it types (link.mjs) ----
    ['POST', /^\/api\/links\/code$/, async (req) => {
      await readJson(req);
      // With the line to type there: the hub's address and, for a hub with its own certificate, its fingerprint.
      const c = createLinkCode();
      // How this computer is reached from anywhere: the set public address, else the public link's (reach.mjs).
      // `via` 'temporary': the address changes whenever Hoprig or the computer restarts, and a computer linked to it must be linked again.
      const { url: base, via } = reachable();
      const cert = base ? await certOf(base) : null;
      const made = cert ? joinCommand(base, c.code, cert) : { line: null, note: null };
      const { line } = made;
      let { note } = made;
      // A public link's address has Cloudflare's publicly trusted certificate: a failed self-check there only means
      // the address does not answer yet (a new one can take a moment), never that a fingerprint is needed.
      if ((via === 'temporary' || via === 'custom') && cert && cert.kind !== 'own') note = cert.kind === 'unknown' ? 'This address did not answer here yet; a new one can take a minute. If linking fails, show a new line in a minute.' : null;
      const pin = cert && cert.kind === 'own' ? cert.pin : null;
      return { ...c, url: cert ? base : null, via: cert ? via : null, certificate: cert ? cert.kind : null, fingerprint: pin, command: line, line: cert ? joinLine(base, c.code, pin) : null, note };
    }],
    ['GET', /^\/api\/links\/code$/, async (req, m, q) => {
      const st = linkCodeStatus(String(q.get('id') || ''));
      return typeof st === 'string' ? { status: st } : { status: 'claimed', by: st.by };
    }],
    ['POST', /^\/api\/joins\/([0-9a-f]{12})\/leave$/, async (req, m) => {
      await readJson(req);
      return leaveHub(m[1], { keeper: joins, ssh: joinSsh });
    }],
    ['GET', /^\/api\/tokens$/, async () => ({ tokens: listTokens() })],
    ['POST', /^\/api\/tokens\/([0-9a-f]{12})\/revoke$/, async (req, m) => {
      await readJson(req);
      const gone = revokeToken(m[1]);
      if (!gone.length) throw new HubError(404, 'no such token');
      return { revoked: gone };
    }],
    ['POST', /^\/api\/pair\/code$/, async (req) => {
      await readJson(req);
      return createCode();
    }],
    ['GET', /^\/api\/pair\/code$/, async (req, m, q) => {
      const s = codeStatus(String(q.get('id') || ''));
      return typeof s === 'string' ? { status: s } : { status: 'claimed', by: s.claimedBy };
    }],
  ];
  const OURS = /^\/api\/(machine|machines|tokens|pair|joins|links)(\/|$)/;

  async function own(req, res, url, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) return send(res, 403, { error: 'cross-site request refused' });
    if (!authed(req)) return send(res, 401, { error: 'log in first' });
    for (const [method, re, fn] of routes) {
      const m = re.exec(p);
      if (m && method === req.method) return send(res, 200, await fn(req, m, url.searchParams));
    }
    return send(res, 404, { error: 'not found' });
  }

  /** /m/<name>/...: relay the API, answer login questions here, serve this dashboard's own page for the rest. */
  async function machinePath(req, res, url, name, rest) {
    if (!machineName(name)) return send(res, 404, { error: 'no such computer' });
    if (rest === '/api/me') return send(res, 200, { authed: authed(req) });
    if (rest === '/api/login' || rest === '/api/logout' || rest === '/login') {
      // The login is this dashboard's own: hand the request to the server under its plain path.
      req.url = rest + url.search;
      return false;
    }
    if (!rest.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      if (authed(req) && !getMachine(name)) return send(res, 404, { error: 'no such computer' });
      // The page for another computer is this dashboard's own page; its script sees /m/<name>/ in the address and
      // sends every API call there (web/lib.js BASE). So /m/<name>/app.js is just /app.js.
      req.url = (rest || '/') + url.search;
      return false;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) return send(res, 403, { error: 'cross-site request refused' });
    if (!authed(req)) return send(res, 401, { error: 'log in first' });
    const m = getMachine(name);
    if (!m) return send(res, 404, { error: 'no such computer' });
    // A Setup job's password never crosses a plain leg (legs.mjs).
    const leg = await relayLeg(req, m, legEncrypted(m, (id) => links.encrypted(id)), { path: rest });
    if (leg.refused) return send(res, leg.refused.status, leg.refused.body);
    let ep;
    try {
      ep = await hub.endpoint(m);
    } catch (e) {
      const { status, body } = errorBody(m.label || name, e);
      req.resume();
      return send(res, status, body);
    }
    await relayHttp(leg.req, res, ep, { machine: m.label || name, path: rest + url.search, token: m.token, headers: leg.headers, idleMs: /\/upload$|^\/api\/code\/git\/(commit|stage|unstage|discard)$/.test(rest) ? Math.max(150_000, relayIdleMs) : relayIdleMs });
    return true;
  }

  return {
    hub,
    joins,
    links,

    /** Resolves true when this module answered the request; false to let the server handle it. */
    async handle(req, res) {
      let url;
      try {
        url = new URL(req.url, 'http://x');
      } catch {
        return false; // the server answers "bad url"
      }
      const p = url.pathname;
      try {
        if (bearerOf(req) !== null) {
          const refused = gate(req, p);
          if (refused) {
            send(res, refused.status, refused.body);
            return true;
          }
          if (p === '/api/machine' && req.method === 'GET') {
            send(res, 200, await info());
            return true;
          }
          if (p === SELF_REVOKE && req.method === 'POST') {
            send(res, 200, { revoked: revokeToken(req[TOKEN].id) });
            return true;
          }
          auditToken(req, res, p, req[TOKEN]); // a change it makes goes into this computer's Activity log
          return false;
        }
        // The direct link's public requests: the code (claim) and leaving, each proven by what they carry.
        if (await links.handle(req, res, p, readJson, send)) return true;
        if (p === '/api/pair/claim' && req.method === 'POST') {
          await claim(req, res);
          return true;
        }
        const mm = /^\/m\/([^/]+)(\/.*)?$/.exec(p);
        if (mm) {
          if (mm[2] === undefined) {
            res.writeHead(302, { Location: `/m/${machineName(mm[1]) ? mm[1] : ''}/` });
            res.end();
            return true;
          }
          const answered = await machinePath(req, res, url, mm[1], mm[2]);
          return answered !== false;
        }
        if (OURS.test(p)) {
          await own(req, res, url, p);
          return true;
        }
        return false;
      } catch (e) {
        const status = Number.isInteger(e.status) ? e.status : 500;
        if (status === 500) console.error(`${req.method} ${p}: ${e.message}`);
        if (!res.headersSent) {
          const extra = {};
          for (const k of ['code', 'installCommand', 'canInstall']) if (e[k] !== undefined) extra[k] = e[k];
          send(res, status, { error: e.message || 'server error', ...extra });
        } else res.end();
        return true;
      }
    },

    /** Resolves true when this module took the upgrade (relayed or refused it); false to let the server handle it. */
    async upgrade(req, socket, head) {
      let url;
      try {
        url = new URL(req.url, 'http://x');
      } catch {
        return false;
      }
      const p = url.pathname;
      if (bearerOf(req) !== null) {
        const refused = gate(req, p);
        if (refused) {
          rejectUpgrade(socket, refused.status, refused.status === 401 ? 'Unauthorized' : 'Forbidden', JSON.stringify(refused.body));
          return true;
        }
        if (p !== '/ws/term') {
          rejectUpgrade(socket, 403, 'Forbidden');
          return true;
        }
        return false;
      }
      // A linked computer's WebSocket: the link secret in a header is its only credential (no cookie, no Origin).
      if (p === '/api/link') return links.upgrade(req, socket, head);
      const mm = /^\/m\/([^/]+)(\/.*)?$/.exec(p);
      if (!mm) return false;
      if (mm[2] !== '/ws/term' || !machineName(mm[1])) {
        rejectUpgrade(socket, 404, 'Not Found');
        return true;
      }
      if (!originOk(req)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return true;
      }
      if (!authed(req)) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return true;
      }
      const m = getMachine(mm[1]);
      if (!m) {
        rejectUpgrade(socket, 404, 'Not Found');
        return true;
      }
      try {
        const ep = await hub.endpoint(m);
        await relayUpgrade(req, socket, head, ep, { machine: m.label || m.name, path: `/ws/term${url.search}`, token: m.token });
      } catch (e) {
        const { status, body } = errorBody(m.label || m.name, e);
        rejectUpgrade(socket, status, 'Bad Gateway', JSON.stringify(body));
      }
      return true;
    },

    /** True when handle()/upgrade() found a valid bearer token on this request. */
    authedByToken: (req) => !!(req && req[TOKEN]),

    close() {
      hub.close();
      joins.close();
      links.close();
    },
  };
}
