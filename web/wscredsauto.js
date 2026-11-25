// The upkeep's switch "credentials" on the Workspace page (Settings → Workspace, By itself): the same setting as
// `hoprig workspace auto --credentials on|off` (automation.workspace.credentials, off by default), saved through the
// route the other switches of that panel use (POST /api/automation/settings, checked by cleanSettingsPatch as the
// command checks it). Shown only when the credentials folder is a repository (GET /api/workspace/credentials).
import { toggle } from './shell.js';

export const CREDS_LABEL = 'Save and upload the credentials by itself';
export const CREDS_HINT = 'At each look of the upkeep, every change in the credentials folder is saved and uploaded to its repository, by itself, only while that repository is private. Whoever can read that repository reads every key in it.';

/** Whether the credentials folder is a repository here (the switch is shown only then). */
export const credsIsRepo = (api) => api('/api/workspace/credentials').then((c) => !!c && c.folder === 'repository', () => false);

/** The switch, or null while the credentials folder is not a repository. `save(patch)` is the panel's own. */
export function credsToggle(w, save) {
  if (!w.credsRepo) return null;
  return toggle(CREDS_LABEL, w.credentials === true, (v) => save({ credentials: v }), CREDS_HINT);
}
