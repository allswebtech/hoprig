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
 * server.publicUrl when it is set (a hub behind its own proxy; kept with its path), else the Custom address while the
 * public link is on as Custom, else the Temporary address while it runs; null when there is none. No trailing "/".
 */
export function reachableUrl(cfg = loadConfig()) {
  const set = (cfg.server || {}).publicUrl ? clean(cfg.server.publicUrl) : null;
  if (set) return set;
  const p = cfg.publicLink;
  if (!p || p.on !== true) return null;
  if (p.kind === 'custom') {
    const f = readFixed();
    return f && f.mode && f.hostname ? clean(`https://${f.hostname}`, { origin: true }) : null;
  }
  // The Temporary address only while its cloudflared runs: after a restart it is a new one.
  const rec = readJsonFile(linkRecordFile()) || {};
  return rec.kind === 'temporary' && rec.url && alive(rec.pid) ? clean(rec.url, { origin: true }) : null;
}
