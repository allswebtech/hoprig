// What `serve` listens on, and the unattended first start: decisions kept apart from the server so they can be
// tested, and so a process manager that is not systemd (a hosting panel, Docker, a PaaS) can run the dashboard
// with nothing but environment variables.
//
//   address   --host / --port  >  HOST / PORT (the convention of panels and PaaS)  >  config.json "server"  >  default
//   password  no password set yet and a password file named (--password-file or HOPRIG_PASSWORD_FILE): a password
//             already in that file is used; an empty or missing file gets a new random one (mode 600). Either way only
//             its scrypt hash goes into config.json, and the server starts instead of refusing.
import fs from 'node:fs';
import path from 'node:path';

const portOf = (v, where) => {
  const p = Number(v);
  if (!Number.isInteger(p) || p < 1 || p > 65535 || !/^\d+$/.test(String(v).trim())) throw new Error(`${where} must be a port number, 1-65535 (got "${v}")`);
  return p;
};

/** { host, port } with the precedence above. Throws on a PORT that is not a port. */
export function resolveListen({ flags = {}, env = process.env, server = {}, defaults }) {
  const host = flags.host ?? (env.HOST && env.HOST.trim() ? env.HOST.trim() : undefined) ?? server.host ?? defaults.host;
  let port = flags.port;
  if (port === undefined && env.PORT !== undefined && String(env.PORT).trim() !== '') port = portOf(env.PORT, 'PORT');
  if (port === undefined) port = server.port ?? defaults.port;
  return { host, port };
}

/** The password file for an unattended first start, or null. */
export function passwordFileFrom({ flags = {}, env = process.env } = {}) {
  const f = flags.passwordFile || (env.HOPRIG_PASSWORD_FILE && env.HOPRIG_PASSWORD_FILE.trim()) || null;
  return f ? path.resolve(f) : null;
}

/**
 * Make sure a password exists, from `file`. Returns { created: boolean, reused: boolean }.
 * `setPassword(pw)` stores the hash; `generate()` makes a new password.
 */
export async function firstPassword(file, { setPassword, generate }) {
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (existing.length >= 8) {
    await setPassword(existing);
    return { created: false, reused: true };
  }
  if (existing) throw new Error(`${file} holds a password shorter than 8 characters`);
  const pw = generate();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, pw + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  await setPassword(pw);
  return { created: true, reused: false };
}

/**
 * Behind a hosting panel's or PaaS's HTTPS proxy, the public address comes from the environment
 * (HOPRIG_PUBLIC_URL, e.g. SixPanel's ${SITE_URL}): the proxy is trusted, its origin allowed, links use it.
 * Returns the server settings to save, or null when nothing changes (or the value is not an https URL).
 */
export function publicUrlSettings(value, server = {}) {
  let u;
  try {
    u = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const origin = u.origin;
  const allowed = [...new Set([...(server.allowedOrigins || []), origin])];
  const next = { trustProxy: true, allowedOrigins: allowed, publicUrl: `${origin}/` };
  const same = server.trustProxy === true && server.publicUrl === next.publicUrl && (server.allowedOrigins || []).includes(origin);
  return same ? null : next;
}
