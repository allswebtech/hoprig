// Tia's administrator rights, in three levels the owner chooses on his own page, per computer.
// Off is the default and what an install or an update leaves. The level is read here; it is changed only through the
// owner's signed-in page (src/server/herrights.mjs), never through Tia's door, a token, another computer or a session:
// it is no key of change_setting and no key her /api/settings door may send (src/assistant/door.mjs refuses both, and
// /api/herrights itself), so a change of hers can never raise her own rights.
//
//   off   an administrator command through run_command is refused with no card, as today (owner-tools.mjs HIS_ALONE)
//   ask   one confirmation card per administrator command, the exact argv shown, his password where sudo needs one
//   full  her administrator commands run without a card, each in the audit log
//
// Stored under config server.herRights = { level, version, at }. Whatever the level, a mistake of hers may cost a day,
// never the work: no level ever lets a command change who may be administrator or switch a safety rule off.

import { hoprigVersion } from '../handsoff.mjs';

export const HER_RIGHTS_LEVELS = ['off', 'ask', 'full'];
export const HER_RIGHTS_DEFAULT = 'off';

// Full's hour's limit, as data: at Full her administrator commands run with no card, but at most this
// many an hour. Beyond it a command falls back to the owner's Ask card (his tap), so a runaway at Full still cannot
// cost the work — a mistake of hers may cost a day, never the work. The count is the
// administrator run_command acts in the audit log of the last hour (core.mjs facts), read by the dashboard, never
// from the model.
export const FULL_ADMIN_PER_HOUR = 50;

/**
 * The exact sentence the owner types on his page to turn Full on: it names the
 * computer. The page shows it and the owner types it back; src/server/herrights.mjs accepts the Full
 * turn-on only when the typed sentence matches, so Full is never an accidental toggle. The computer is named by its
 * label (the owner's own short name for it); an unlabelled computer reads as "this computer".
 */
export function fullConfirmSentence(computer) {
  return `Turn on full administrator rights for ${computer || 'this computer'}`;
}

/**
 * The stored admin-rights level of a computer's config, or 'off' when it is unset or not a level we know. Full is
 * stamped with the Hoprig version it was chosen under (src/server/herrights.mjs): chosen under another version it
 * reads as 'Ask each time', so an update never silently keeps no-card administrator rights for her
 * sessions — the owner chooses Full again under the new version. Off and Ask do not depend on the version. The
 * version is a parameter (default the running one) so every reader — the session-hold gate and the GET route — gets
 * the same answer and it stays testable.
 */
export function herRightsLevel(cfg, version = hoprigVersion()) {
  const hr = cfg && cfg.server && cfg.server.herRights;
  const v = hr && hr.level;
  const level = HER_RIGHTS_LEVELS.includes(v) ? v : HER_RIGHTS_DEFAULT;
  if (level === 'full' && (!hr || hr.version !== version)) return 'ask';
  return level;
}

/** A level as the owner's page sends it, or an Error with the one message the page shows. */
export function cleanHerRightsLevel(v) {
  if (!HER_RIGHTS_LEVELS.includes(v)) throw new Error(`the administrator-rights level is one of: ${HER_RIGHTS_LEVELS.join(', ')}`);
  return v;
}
