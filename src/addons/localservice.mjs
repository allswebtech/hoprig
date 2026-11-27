// One more local service reached from anywhere through a public link (such as a gateway's own dashboard on its
// port): which port it is, and whether it has a sign-in of its own. Without one, anyone who has its address can use
// it, so the page asks before it is made public.
//
// A sign-in page at / is not enough: a service can send / to its login and still answer its API without a key (an AI
// gateway's /v1/models, then its /v1/messages with the provider keys it holds). So the usual API paths are asked
// too, with no credential at all; one that answers 2xx always means a question to the owner.

import { OWN_PAGE, gatewayPort } from './trouteaipublic.mjs';

/** The port typed in the page: { port } or { error }. The dashboard's own port is not "another" service. */
export function checkPort(v, dashboardPort, { own = false } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: 'The port is a number from 1 to 65535.' };
  if (n === Number(dashboardPort)) return { error: 'That port is this dashboard itself.' };
  if (n === gatewayPort() && !own) return { error: OWN_PAGE };
  return { port: n };
}

// A path that is a sign-in page (a gateway's own dashboard: / → /dashboard → /login).
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|sign_in|auth|session\/new)(\/|$|\.)/i;
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** API paths an AI gateway or a similar service answers: OpenAI's and Anthropic's model lists, and a common prefix. */
export const API_PATHS = ['/v1/models', '/api/v1/models', '/api/models'];

/** The first API path that answers 2xx without any key, else null. Redirects are not followed: a login is not open. */
export async function openApi(port, { fetchImpl = fetch, paths = API_PATHS } = {}) {
  for (const p of paths) {
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}${p}`, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      if (r.status >= 200 && r.status < 300) return p;
    } catch {
      /* nothing there */
    }
  }
  return null;
}

/**
 * What the service on 127.0.0.1:<port> shows a stranger: { answers, login, openApi }. `login`: its first page asks
 * for a password; `openApi`: an API path that answers without a key (null when none does). A best guess from the
 * outside; `exposureQuestion` turns it into the question the page asks.
 */
export async function serviceLogin(port, { fetchImpl = fetch } = {}) {
  const page = await firstPage(port, fetchImpl);
  return { ...page, openApi: page.answers ? await openApi(port, { fetchImpl }) : null };
}

/** The question before the port is made public, or null when it has a sign-in page and no open API. */
export function exposureQuestion(port, look) {
  const why = [];
  if (!look.login) why.push('shows no sign-in page of its own');
  if (look.openApi) why.push(`answers its API (${look.openApi}) without a key`);
  return why.length ? `Port ${port} ${why.join(' and ')}: anyone who has its address can use it${look.openApi ? ', with whatever keys the service holds' : ''}.` : null;
}

/** Its first page, following its own redirects (at most 4): { answers, login } (401/403, a sign-in address, a password field). */
async function firstPage(port, fetchImpl) {
  let url = `http://127.0.0.1:${port}/`;
  for (let hop = 0; hop < 5; hop++) {
    let r;
    try {
      r = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
    } catch {
      return { answers: hop > 0, login: false };
    }
    if (r.status === 401 || r.status === 403 || r.headers.get('www-authenticate')) return { answers: true, login: true };
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      let next;
      try {
        next = new URL(loc, url);
      } catch {
        return { answers: true, login: false };
      }
      if (LOGIN_PATH.test(next.pathname)) return { answers: true, login: true };
      if (!LOCAL.has(next.hostname)) return { answers: true, login: false };
      url = next.href;
      continue;
    }
    const text = String(await r.text().catch(() => '')).slice(0, 200_000);
    return { answers: true, login: /type\s*=\s*["']?password/i.test(text) || LOGIN_PATH.test(new URL(url).pathname) };
  }
  return { answers: true, login: false };
}
