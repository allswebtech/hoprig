// How another device reaches this dashboard from anywhere: the one helper that the join line of a computer link
// (src/machines) and the sign-in link use. Read from files only (config.json, the switch's record, the Custom
// set-up), so a command in a terminal gets the same answer as the running dashboard.
import { loadConfig } from '../config.mjs';
import { alive, linkRecordFile, readFixed, readJsonFile } from './cloudflared.mjs';

// An http(s) address without its trailing "/"; `origin`: only scheme, host and port.
const clean = (u, { origin = false } = {}) => {
  try {
    const x = new URL(String(u));
    if (!/^https?:$/.test(x.protocol)) return null;
    return origin ? x.origin : x.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
};

/**
 * How this computer is reached from anywhere: { url, via } with via 'set' (server.publicUrl, a hub behind its own
 * proxy; kept with its path), 'custom' (the Custom address while the public link is on as Custom) or 'temporary'
 * (the Temporary address while its cloudflared runs, connected); { url: null, via: null } when there is none. No trailing "/".
 */
export function reachable(cfg = loadConfig()) {
  const none = { url: null, via: null };
  const set = (cfg.server || {}).publicUrl ? clean(cfg.server.publicUrl) : null;
  if (set) return { url: set, via: 'set' };
  const p = cfg.publicLink;
  if (!p || p.on !== true) return none;
  if (p.kind === 'custom') {
    const f = readFixed();
    const url = f && f.mode && f.hostname ? clean(`https://${f.hostname}`, { origin: true }) : null;
    return url ? { url, via: 'custom' } : none;
  }
  // The Temporary address only while its cloudflared runs and is connected: while it starts again after a crash the
  // record still holds the old address, which no longer leads here.
  const rec = readJsonFile(linkRecordFile()) || {};
  const url = rec.kind === 'temporary' && rec.url && rec.connected === true && alive(rec.pid) ? clean(rec.url, { origin: true }) : null;
  return url ? { url, via: 'temporary' } : none;
}

/** reachable()'s address alone, or null. */
export const reachableUrl = (cfg) => reachable(cfg).url;
