// Tia's administrator-rights level (src/assistant/herrights.mjs): set here from the owner's signed-in page and nowhere
// else. Like every feature route it sits behind the dashboard's login; it is no route of Tia's door (door.mjs refuses
// /api/herrights), and the level is no key her /api/settings door may send. A change of hers would raise her own
// rights, so the level is the owner's own choice, per computer.
//   GET  /api/herrights            → { level, sentence, sudoPresent, needsPassword, fullOffered }   (level 'off' when unset)
//   POST /api/herrights  { level } → { level }             set it to off | ask | full
// The GET carries what the owner's page needs to show every state without guessing (web/tia.js): the level, the
// sentence he types to turn Full on (fullConfirmSentence, no sudo), whether this computer has sudo at all (sudoPresent;
// false reads as "no sudo on this computer": only Off applies), whether its sudo asks for a password (needsPassword,
// for the Ask card's password field), and whether Full may be offered here (fullOffered: sudo present and no password).
// Turning on Full is guarded here: Full is offered ONLY where this computer's sudo needs no password (the
// product never keeps a password to make Full possible), and it needs a sentence typed on his page that names the
// computer (fullConfirmSentence) — so Full is a deliberate choice, never an accidental toggle. Whether sudo is there
// and asks a password is detected with the same reader set-up uses (sysFacts/sudoNeedsPassword): lazily for the page,
// and again when Full is turned on, so a change of the computer's sudo rules since the dashboard started is seen at
// that moment. A test or the demo hands in its own answer (sudoInfo, or sudoAsksPassword for needsPassword alone).
// Stored with the Hoprig version it was set under, for the version rule of Full (chosen under another version it reads
// as "Ask each time").
import { cleanHerRightsLevel, fullConfirmSentence, herRightsLevel } from '../assistant/herrights.mjs';
import { hoprigVersion } from '../handsoff.mjs';

export function herRightsFeature(ctx, { version = hoprigVersion(), sudoAsksPassword, sudoInfo } = {}) {
  // Whether this computer has sudo and whether it asks for a password (the Ask card's field, and whether Full may be
  // offered), with the construction set-up uses (never a second reader). The page's reads keep the first answer, so a
  // page load does not run sudo each time; info({ fresh: true }) asks again and keeps the new answer. A test or the
  // demo injects the whole answer (sudoInfo), or just needsPassword (sudoAsksPassword, sudo assumed present); an
  // injected answer is asked every time.
  let detected;
  const info = sudoInfo
    || (sudoAsksPassword ? async () => ({ present: true, needsPassword: await sudoAsksPassword() })
      : async ({ fresh = false } = {}) => {
        if (detected === undefined || fresh) {
          const { sysFacts } = await import('../pcsetup/detect.mjs');
          const { sudoNeedsPassword } = await import('../pcsetup/admin.mjs');
          const sys = await sysFacts();
          detected = { present: sys.has('sudo'), needsPassword: await sudoNeedsPassword(sys) };
        }
        return detected;
      });
  // Turning Full on asks sudo fresh: the page may have been read before the sudo rules changed.
  const asksPassword = async () => {
    const s = await info({ fresh: true });
    return !s.present || s.needsPassword;
  };
  const computerName = () => {
    const c = ctx.config().computer;
    return (c && typeof c.label === 'string' && c.label) || 'this computer';
  };
  return {
    name: 'herrights',
    routes: [
      ['GET', /^\/api\/herrights$/, async () => {
        const s = await info();
        const cfg = ctx.config();
        const stored = cfg && cfg.server && cfg.server.herRights;
        const level = herRightsLevel(cfg, version);
        // Full chosen under another Hoprig version reads as Ask: the page must say WHY, so the owner
        // knows his deliberate Full was turned off by an update and he must confirm it again under the new version.
        // Without this the page silently shows "Ask each time" with no hint that Full was ever chosen.
        const heldFromFull = !!(stored && stored.level === 'full' && level !== 'full');
        return {
          level,
          sentence: fullConfirmSentence(computerName()),
          sudoPresent: s.present,
          needsPassword: s.needsPassword,
          fullOffered: s.present && !s.needsPassword,
          heldFromFull,
        };
      }],
      ['POST', /^\/api\/herrights$/, async (req) => {
        // Changed only by a request from the owner's own signed-in page: never through Tia's door, a
        // token or another computer. The machines gate (TOKEN_FORBIDDEN) already refuses a token and a relayed
        // request; this is the same owner-page guard accounts.mjs and adopt use, so a change can never raise her rights.
        if (ctx.caller && ctx.caller(req) !== 'page') throw new ctx.HttpError(403, 'the administrator-rights level is set only by you, on this computer\'s own dashboard page: not by Tia, a token or another computer');
        const b = await ctx.readJson(req);
        let level;
        try {
          level = cleanHerRightsLevel(b && b.level);
        } catch (e) {
          throw new ctx.HttpError(400, e.message);
        }
        if (level === 'full') {
          // Full is offered only where sudo is there and needs no password: the product never writes a sudoers rule and
          // never keeps a password to make Full possible. Where sudo asks for one, the owner uses "Ask each
          // time". Asked fresh here, not from the answer the page was drawn with.
          if (await asksPassword()) {
            throw new ctx.HttpError(400, 'Full administrator rights are offered only where this computer\'s sudo needs no password: Hoprig never keeps a password to run a command without a card. Use "Ask each time".');
          }
          // A deliberate choice: a sentence that names the computer, typed on his page.
          const sentence = fullConfirmSentence(computerName());
          if (typeof b.confirm !== 'string' || b.confirm.trim() !== sentence) {
            throw new ctx.HttpError(400, `to turn on Full, type exactly: ${sentence}`);
          }
        }
        ctx.saveConfig({ server: { herRights: { level, version, at: Date.now() } } });
        return { level };
      }],
    ],
  };
}
