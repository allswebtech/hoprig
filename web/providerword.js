// A provider in the Automations page's sentences ("start a chat in ~/shop on Claude Max"): by the name the owner
// gave it. The names come with the first look at the computer; until then a sentence says "its provider", never
// the short name the owner did not type, and says the name as soon as it is known.
import { h } from './lib.js';
import { store } from './store.js';

/** A provider's display name ("Claude Max"; "Auto mode" for auto) among `profiles`; not known yet: "its provider". */
export function providerWord(name, profiles) {
  if (name === 'auto') return 'Auto mode';
  if (!Array.isArray(profiles)) return 'its provider';
  const p = profiles.find((x) => x.name === name);
  return (p && p.label) || name;
}

/** The same on the open computer, as known now. */
export const accountLabel = (name) => providerWord(name, store.data && store.data.profiles);

/** A line with `sentence(accountLabel)`, said again once the providers are known if they are not yet. */
export function providerLine(sentence) {
  const line = h('span', sentence(accountLabel));
  if (store.data && store.data.profiles) return line;
  let done = false;
  let off = null;
  off = store.subscribe((d) => {
    if (done || !(d && d.profiles)) return;
    done = true;
    line.textContent = sentence(accountLabel);
    if (off) off();
  });
  if (done) off();
  return line;
}
