// What `hoprig move-to-user` says about the public link and what the person must do once after the move, from the
// copied settings' own facts. Nothing here changes anything.
// - The public link runs as a process of the dashboard's user, so after the switch the user's dashboard brings it up
//   itself (the choice publicLink is in the copied settings). A Custom link's tunnel files are in Hoprig's add-ons
//   folder, so the copy carries them and the address stays: Cloudflare lets several cloudflared processes ("replicas")
//   serve one named tunnel at once (developers.cloudflare.com, Cloudflare Tunnel, "Deploy cloudflared replicas"). A
//   Temporary link gets a new address at every start: the new one is said, and the user's dashboard sends it to the
//   owner's notifications as it does at any start.
// - Root keeps a system-wide Hoprig when one was installed (left alone); the user's own comes first on its PATH.
// - Bypass permissions mode needs its switch in Settings when the default names that mode and the switch is off; Tia
//   on a provider billed by use does not answer until a daily limit for paid use is set.
import fs from 'node:fs';
import path from 'node:path';
import { isPayPerUse, parseEnv } from '../profiles.mjs';

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** The link of a dashboard's settings and state: { on, kind, url, connected } (url only while it runs). */
export function linkOf(configDir, stateDir) {
  const cfg = readJson(path.join(configDir, 'config.json')) || {};
  const want = cfg.publicLink && typeof cfg.publicLink === 'object' ? cfg.publicLink : {};
  const rec = readJson(path.join(stateDir, 'addons', 'link.json')) || {};
  return { on: want.on === true, kind: want.kind === 'custom' ? 'custom' : 'temporary', url: typeof rec.url === 'string' ? rec.url : null, connected: rec.connected === true };
}

/** The lines about the link after the switch: whether its address stayed, and the new one. */
export function linkLines(before, after) {
  if (!before.on) return [];
  if (!after || !after.connected || !after.url) return [`The public link (${before.kind === 'custom' ? 'Custom' : 'Temporary'}) has not come up as the user yet: hoprig public status says when it does.`];
  if (after.url === before.url) return [`The public link runs as the user now, at the same address: ${after.url}`];
  return [`The public link runs as the user now, at a NEW address: ${after.url}${before.url ? ` (it was ${before.url})` : ''}. It is sent to your notifications too.`];
}

/** The line said before root's dashboard stops, for a person who reached it through the link. */
export function linkWarning(before) {
  if (!before.on) return null;
  return before.kind === 'custom'
    ? "Root's dashboard stops in a moment; the Custom link keeps its address, and the page answers there again once the user's dashboard is up (about half a minute)."
    : "Root's dashboard stops in a moment, and with it this Temporary link's address. The user's dashboard brings up a new address: it is sent to your notifications and shown by hoprig public status.";
}

/** The system-wide Hoprig root may keep (left alone), as a line, or null. `exists` is handed in by tests. */
export function systemWideLine(user, { exists = fs.existsSync } = {}) {
  const found = ['/usr/lib/node_modules/hoprig', '/usr/local/lib/node_modules/hoprig', '/usr/bin/hoprig', '/usr/local/bin/hoprig'].filter((p) => exists(p));
  if (!found.length) return null;
  return `Root still has the old system-wide Hoprig (${found.join(', ')}). It is left alone and is not the one in use: ${user.name}'s own Hoprig comes first on its PATH.`;
}

/** The things to do once after the move, from the user's copied settings and provider files. */
export function onceLines(configDir) {
  const cfg = readJson(path.join(configDir, 'config.json')) || {};
  const out = [];
  if (cfg.sessionDefaults?.permissionMode === 'bypassPermissions' && cfg.allowBypass !== true) {
    out.push('Your default for new sessions is bypass permissions mode, and its switch is off: turn it on once in Settings → New sessions (it was refused as root).');
  }
  const tia = cfg.assistant || {};
  if (tia.enabled === true && typeof tia.runsOn === 'string' && !(Number.isFinite(tia.dailyCapUsd) && tia.dailyCapUsd > 0)) {
    let paid = false;
    try {
      paid = isPayPerUse(parseEnv(fs.readFileSync(path.join(configDir, 'profiles', `${path.basename(tia.runsOn)}.env`), 'utf8')));
    } catch {
      /* no such provider file */
    }
    if (paid) out.push(`Tia thinks on ${tia.runsOn}, a provider billed by use, and has no daily limit for paid use: she does not answer until you set one in Settings → Tia.`);
  }
  return out;
}
