// `hoprig profiles map <name> [on|off] [--yes]`: the owner's own switch for a provider's model map in every session
// and chat on it (the profile's MAPSESSIONS). Without on or off it says what a session would be renamed to and whether
// the map is on. Turning it on asks first (it changes what new sessions send); --yes says yes without asking.

import { metaOf, readProfile, validName, writeProfile } from '../profiles.mjs';
import { needsYes } from '../yes.mjs';
import { mapPreview } from './sessionmap.mjs';

export const USAGE = 'usage: hoprig profiles map <name> [on|off] [--yes]';

/** What turning the map on changes, in the words the page uses too. */
export const MAP_CHANGES = 'New sessions and chats on this provider, and the agents inside them, send these names instead. Sessions already open keep what they have, and Auto mode is not changed by it.';

export async function mapCommand(args, { out = console.log, err = console.error } = {}) {
  const yes = args.includes('--yes') || args.includes('-y');
  const [name, what, ...extra] = args.filter((a) => a !== '--yes' && a !== '-y');
  if (!name || extra.length || name.startsWith('-') || (what && what !== 'on' && what !== 'off')) {
    err(USAGE);
    return 2;
  }
  const p = validName(name) ? readProfile(name) : null;
  if (!p) {
    out(`There is no profile "${name}".`);
    return 1;
  }
  const rules = mapPreview(p).rules;
  if (!what) {
    if (!p.models) {
      out(`"${p.label}" has no model map (MODELS): sessions send the names Claude Code chooses.`);
      return 0;
    }
    out(`The model map of "${p.label}" is ${p.mapSessions ? 'ON for every session and chat on it' : 'OFF for sessions and chats (Auto mode uses it all the same)'}.`);
    out(p.mapSessions ? 'Sessions send:' : 'With it on, sessions would send:');
    for (const r of rules) out(`  ${r.from} -> ${r.to}${r.by === 'yours' ? '  (from your own Claude Code settings)' : ''}`);
    if (!rules.length) out('  (nothing: its rules rename no name Claude Code sends)');
    if (!p.mapSessions) out(`Turn it on: hoprig profiles map ${name} on`);
    return 0;
  }
  const on = what === 'on';
  if (on && !p.models) {
    out(`"${p.label}" has no model map (MODELS) to use: nothing was changed.`);
    return 1;
  }
  if (on === p.mapSessions) {
    out(`The model map of "${p.label}" is ${on ? 'on' : 'off'} already.`);
    return 0;
  }
  if (on) {
    out(MAP_CHANGES);
    for (const r of rules) out(`  ${r.from} -> ${r.to}`);
    const no = await needsYes({ yes, command: 'hoprig profiles map', act: `Turning on the model map of "${p.label}"`, question: 'Turn it on?', done: 'changed' });
    if (no !== null) return no;
  }
  writeProfile(p.name, { ...metaOf(p), mapSessions: on, env: p.env });
  out(on ? `The model map of "${p.label}" is on: new sessions and chats on it send these names.` : `The model map of "${p.label}" is off: new sessions and chats on it send the names Claude Code chooses.`);
  return 0;
}
