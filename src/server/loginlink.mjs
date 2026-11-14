// One-time sign-in links: `hoprig link` (and Settings → "Sign in another device") make an address that logs
// the browser opening it in once, so a phone is signed in by scanning a QR code instead of typing the password.
//
// The secret travels in the address's #fragment: browsers never send a fragment to a server, so it stays out of
// proxy logs and Referer headers, and a chat app's link preview (which fetches the address) cannot use up the
// link. The login page reads it and sends it once to POST /api/login/link, which sets the cookie like a login.
// 32 random bytes, 15 minutes by default, one use; only its hash is stored (<stateDir>/login-links.json).
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { OneTimeStore } from '../machines/onetime.mjs';

const links = new OneTimeStore('login-links', { salt: 'login-link' });
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const LINK_PREFIX = 'link='; // the fragment is "#link=<token>"

/**
 * A new sign-in link for the dashboard at `baseUrl` (http or https, as the other device reaches it).
 * Returns { url, expires, id }.
 */
export function createLoginLink({ baseUrl, minutes = 15, now = Date.now() } = {}) {
  let u;
  try {
    u = new URL(String(baseUrl));
  } catch {
    throw new Error('the dashboard address is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('the dashboard address must start with http:// or https://');
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error('a link lives 1 minute to 24 hours');
  const token = crypto.randomBytes(32).toString('base64url');
  const { id, expires } = links.add(token, Math.round(minutes * 60_000), { now });
  const base = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  return { url: `${base}/login#${LINK_PREFIX}${token}`, expires, id };
}

/** True once for a valid, unexpired link token (it stops working at that moment); false for anything else. */
export function useLoginLink(token, { now = Date.now() } = {}) {
  return links.take(typeof token === 'string' && TOKEN_RE.test(token) ? token : null, 'browser', { now }) !== null;
}

/**
 * The QR code of `text` as rows of '1' (dark) and '0', for the page to draw. Null when the QR package is missing
 * (the page then shows the link only).
 */
export function qrRows(text) {
  let QRCode;
  let level;
  try {
    const require = createRequire(import.meta.url);
    QRCode = require('qrcode-terminal/vendor/QRCode');
    level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel').L;
  } catch {
    return null;
  }
  const qr = new QRCode(-1, level);
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (qr.isDark(r, c) ? '1' : '0')).join(''));
}

/** 'pending' | 'expired' | 'used' for the link made with id `id` (so the CLI can say "signed in"). */
export function loginLinkStatus(id, { now = Date.now() } = {}) {
  const s = links.status(id, { now });
  return typeof s === 'string' ? s : 'used';
}
