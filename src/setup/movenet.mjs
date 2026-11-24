// What the user's own install needs from the network, and a bounded look whether it can be reached. The move keeps
// root's build (this package, packed), but the user's install.sh fetches nvm, Node.js, the package's dependencies and
// Claude Code, as any install does: a server with no way out cannot be moved, so the move asks first, before it makes
// or copies anything (runMove in moverun.mjs), and stops with one line naming what could not be reached.
import fs from 'node:fs';
import path from 'node:path';

/** Each host gets one request, all at once, each with this limit. */
export const REACH_MS = 10_000;

const NPM_REGISTRY = 'https://registry.npmjs.org/';

/** The registry the user's npm will use: root's ~/.npmrc is copied to the user before the install (moveplan.mjs). */
function registryOf(rootHome, readFile) {
  let text = '';
  try {
    text = String(readFile(path.posix.join(rootHome, '.npmrc'), 'utf8'));
  } catch {
    return NPM_REGISTRY;
  }
  const m = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(text);
  return m ? m[1] : NPM_REGISTRY;
}

/**
 * The hosts the user's install cannot do without, each { host, url }: the npm registry it will use, the place Node.js
 * comes from (nodejs.org, through nvm), nvm's own script (raw.githubusercontent.com) and nvm itself (github.com: nvm's
 * installer clones it where git is installed), and Claude Code (claude.ai's installer, which reads downloads.claude.ai):
 * the move copies Claude Code's settings, not the program, and the user's set-up ends with exit 1 when it cannot
 * install it. `url` is the host's origin only: a registry address with a name and password in it never leaves the look.
 * The registry's entry has `npm: true` (only npm asks it, so only npm's own proxy covers it: toCheck).
 */
export function networkNeeds(rootHome, { readFile = fs.readFileSync } = {}) {
  const out = [];
  for (const [i, u] of [registryOf(rootHome, readFile), 'https://nodejs.org/', 'https://raw.githubusercontent.com/', 'https://github.com/', 'https://claude.ai/', 'https://downloads.claude.ai/'].entries()) {
    let url;
    try {
      url = new URL(u);
    } catch {
      url = new URL(NPM_REGISTRY);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') url = new URL(NPM_REGISTRY);
    if (!out.some((n) => n.host === url.host)) out.push({ host: url.host, url: `${url.protocol}//${url.host}/`, ...(i === 0 && { npm: true }) });
  }
  return out;
}

/**
 * The proxy this server reaches out through, by the name of its setting (never its value: it may hold a password), or
 * null: HTTPS_PROXY / HTTP_PROXY (either case) in the move's environment, which the user's install inherits, or
 * proxy= / https-proxy= in root's ~/.npmrc, which is copied to the user. Node's fetch (the look's) does not go through
 * such a proxy, while curl, nvm and npm do: a look without it would stop a server whose install works.
 */
export function proxyOf(rootHome, { env = process.env, readFile = fs.readFileSync } = {}) {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) if (String(env[k] || '').trim()) return k;
  let text = '';
  try {
    text = String(readFile(path.posix.join(rootHome, '.npmrc'), 'utf8'));
  } catch {
    return null;
  }
  const m = /^\s*(https-proxy|proxy)\s*=\s*\S+/m.exec(text);
  return m ? `${m[1]}${NPMRC}` : null;
}

/** The end of proxyOf's name for a proxy set only for npm (in ~/.npmrc). */
const NPMRC = ' in ~/.npmrc';

/** A proxy only npm uses (~/.npmrc): nvm, Node.js's download (curl or wget) and Claude Code's installer go out without it. */
export const npmOnly = (proxy) => typeof proxy === 'string' && proxy.endsWith(NPMRC);

/**
 * The hosts the move's look asks: all of them with no proxy; none behind a proxy of the environment (every part of the
 * install inherits it, and Node's fetch cannot use it); with a proxy only npm uses, all but the registry.
 */
export const toCheck = (needs, proxy) => (!proxy ? needs : npmOnly(proxy) ? needs.filter((n) => !n.npm) : []);

/** "a", "a and b", "a, b and c". */
export const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** The one line of the look (the dry run and the page's job). `proxy`: the setting of a proxy, which is not checked. */
export const NETWORK_LINE = (user, needs, proxy = null) => `The user ${user}'s own install needs the network (Node.js and the packages come from there): ${listed(needs.map((n) => n.host))}. ${npmOnly(proxy)
  ? `npm goes out through a proxy (${proxy}), so the move does not check ${listed(needs.filter((n) => n.npm).map((n) => n.host))} itself; it checks the others before it makes or copies anything (nvm, Node.js's download and Claude Code's installer do not use that proxy).`
  : proxy
    ? `This server goes out through a proxy (${proxy}), so the move does not check them itself: the install goes through that proxy.`
    : 'The move checks them before it makes or copies anything.'}`;

/** The line of the move when a proxy is set: the look is skipped (or, for npm's own proxy, the registry's), said once. */
export const PROXY_LINE = (proxy, needs = []) => (npmOnly(proxy)
  ? `${listed(needs.filter((n) => n.npm).map((n) => n.host)) || 'The registry'} was not checked: npm goes out through a proxy (${proxy}). The other hosts are checked, because nvm, Node.js's download and Claude Code's installer do not use it.`
  : `The network was not checked: this server goes out through a proxy (${proxy}), which the user's install uses.`);

/**
 * The one line of the stop, with what to do next. `again`: an earlier run's copy (and the user it made) are here, so
 * nothing MORE was made, and the lines after this one say what is left and how to go on.
 */
export const NO_NETWORK = (user, hosts, { again = false } = {}) => `The move needs the network for the user ${user}'s own install, and ${listed(hosts)} could not be reached: ${again
  ? 'nothing more was made or copied. Check that this server can reach the internet (its firewall or its provider), then go on as the lines below say.'
  : `nothing was made or copied, and root's Hoprig works as before. Check that this server can reach the internet (its firewall or its provider), then run the move again: hoprig move-to-user --yes --user ${user}`}`;

/**
 * A TLS error about the host's certificate: the host answered, with a certificate Node does not trust (a private
 * registry's own authority, which npm trusts through cafile= or strict-ssl=false in .npmrc).
 */
const CERT_RE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/;
const certError = (e) => CERT_RE.test(String(e?.cause?.code || e?.code || ''));

/**
 * Ask each host once, all at once, each within `ms`: any HTTP answer counts as reached (a registry may say 401 to a
 * plain request), and so does a certificate Node does not trust (certError); only no answer at all does not.
 * → { ok, unreached: [host] }. `fetch` is handed in by tests.
 */
export async function reachAll(needs, { fetch = globalThis.fetch, ms = REACH_MS } = {}) {
  const answered = await Promise.all(needs.map(async (n) => {
    try {
      await fetch(n.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(ms) });
      return true;
    } catch (e) {
      return certError(e);
    }
  }));
  const unreached = needs.filter((n, i) => !answered[i]).map((n) => n.host);
  return { ok: unreached.length === 0, unreached };
}
