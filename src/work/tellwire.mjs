// The dashboard's side of "Tia writes my digest" (tellwords.mjs): her provider and model as Settings → Tia has them,
// her engine's environment (no instructions or memory of the owner), her usage record, and the sample of his
// language: the start of the last message he wrote to her, kept by her feature in her state folder ONLY while this
// setting is on (src/assistant/feature.mjs). Tia turned off, no provider for her, or no sample: the plain digest.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { tellSettings } from './tellsettings.mjs';
import { SAMPLE_MAX, digestWorder, tiaCall } from './tellwords.mjs';

export const sampleFile = () => path.join(stateDir(), 'assistant', 'language-sample.txt');

/** Keep the start of his message as the sample of his language, only while "Tia writes my digest" is on. */
export function keepSample(cfg, text) {
  const file = sampleFile();
  if (!tellSettings(cfg).tiaWords) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, String(text).slice(0, SAMPLE_MAX), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

const readSample = () => {
  try {
    return fs.readFileSync(sampleFile(), 'utf8').slice(0, SAMPLE_MAX) || null;
  } catch {
    return null;
  }
};

/**
 * The word function the teller gets: resolves her provider only when it is called (the setting is on). On a provider
 * billed by use the call runs by itself, so it is money like her own turn (src/assistant/spend.mjs): only inside the
 * daily limit for paid use he set (Settings → Tia), a hold taken right before the call, the call's budget what is
 * left of the limit, and the hold settled by what the call reported it cost. No limit, or no room: no call, the plain
 * digest, and the reason in the log. `ledger`: tests only (her ledger in this state folder otherwise).
 */
export function tiaWorder({ cfg, log, ledger = null }) {
  return async (t) => {
    const c = cfg() || {};
    const { resolveTia, tiaRaw } = await import('../assistant/tia.mjs');
    const { listProfiles, publicProfile } = await import('../profiles.mjs');
    const { getAutoSwitch } = await import('../autoswitch.mjs');
    // A stored sign-in on a key billed by use counts as billed by use (routerstate.mjs billedLogin), as on the page.
    const { billedLogin } = await import('../routerstate.mjs');
    const accounts = { profiles: listProfiles().map((p) => ({ ...publicProfile(p), ...(billedLogin(p) ? { paid: true } : {}) })), autoSwitch: getAutoSwitch() };
    const tia = resolveTia(tiaRaw(c), accounts);
    if (!tia.enabled || !tia.runsOn) return null;
    const { paidName } = await import('../assistant/spend.mjs');
    const { ledger: keptLedger } = await import('../operator/money.mjs');
    const spend = paidName(tia.runsOn, accounts) ? ledger || keptLedger() : null;
    if (spend && !tia.dailyCapUsd) {
      log?.('the digest was sent in plain words: Tia\'s provider is billed by use, and no daily limit for paid use is set (Settings → Tia)');
      return null;
    }
    const { claudeCommand, engineEnv } = await import('../assistant/engine.mjs');
    const { recordUsage, turnUsage } = await import('../assistant/usage.mjs');
    const env = await engineEnv(tia.runsOn);
    // Her call works in a folder of its own in the state folder, as her engine does: never the dashboard's folder.
    const cwd = path.join(stateDir(), 'assistant', 'digest');
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const call = (prompt, system) => {
      // The check and the hold in one step, right before the call (spend.take): two at once never pass the last room.
      const hold = spend ? `digest-${crypto.randomBytes(6).toString('hex')}` : null;
      const why = spend ? spend.take(tia.dailyCapUsd, { id: hold }) : null;
      if (why) return Promise.reject(new Error(`her provider is billed by use, and ${why}`));
      const record = (d) => {
        // Settled by its own cost; a call that reported none keeps its hold for the day (the safe side).
        if (spend && Number.isFinite(d.costUsd)) spend.spent(d.costUsd, 'digest', hold);
        recordUsage(turnUsage(d, { conversation: 'digest' }));
      };
      const budgetUsd = spend ? Math.max(0.01, spend.left(tia.dailyCapUsd, hold)) : null;
      return tiaCall({ env, cwd, model: tia.model, budgetUsd, command: (args) => claudeCommand(args, env), record })(prompt, system);
    };
    return digestWorder({ call, sample: readSample, log })(t);
  };
}
