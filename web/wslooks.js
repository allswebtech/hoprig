// The upkeep's two looks on the Workspace page (Settings → Workspace, By itself): the same settings as
// automation.workspace.onlyHere and automation.workspace.servers (both off by default), saved through the route the
// other switches of that panel use (POST /api/automation/settings). They only read: src/workspace/onlyherelook.mjs.
import { toggle } from './shell.js';

export const ONLY_HERE_LABEL = 'Look once a day at what is only on this computer';
export const ONLY_HERE_HINT = 'Runs the check of "Before you format this computer" by itself, without asking any git server, and tells you when something exists only here. It changes nothing and uploads nothing.';
export const SERVERS_LABEL = 'Look once a week at the git servers';
export const SERVERS_HINT = 'Asks the git server of each repository of your map whether it still has it and still names its main branch as this computer knows it. It only reads, with your own git sign-in; nothing is fetched or changed.';

/** The two switches. `save(patch)` is the panel's own. */
export function looksToggles(w, save) {
  return [
    toggle(ONLY_HERE_LABEL, w.onlyHere === true, (v) => save({ onlyHere: v }), ONLY_HERE_HINT),
    toggle(SERVERS_LABEL, w.servers === true, (v) => save({ servers: v }), SERVERS_HINT),
  ];
}
