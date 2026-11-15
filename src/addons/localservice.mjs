// One more local service reached from anywhere through a public link (such as TRouteAI's own dashboard on port
// 20017): which port it is, and whether it has a sign-in of its own. Without one, anyone who has its address can use
// it, so the page asks before it is made public.

/** The port typed in the page: { port } or { error }. The dashboard's own port is not "another" service. */
export function checkPort(v, dashboardPort) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: 'The port is a number from 1 to 65535.' };
  if (n === Number(dashboardPort)) return { error: 'That port is this dashboard itself.' };
  return { port: n };
}

// A path that is a sign-in page (TRouteAI: / → /dashboard → /login).
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|sign_in|auth|session\/new)(\/|$|\.)/i;
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Ask the service on 127.0.0.1:<port> for its first page, following its own redirects (at most 4).
 * { answers, login }: login is true when it asks for a password (401/403, a sign-in address, or a password field).
 * It is a best guess from the outside, said as such in the page.
 */
export async function serviceLogin(port, { fetchImpl = fetch } = {}) {
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
