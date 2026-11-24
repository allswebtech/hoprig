// Sending field reports to the product's developers: the owner's choice alone (docs/FIELD-REPORTS.md).
//
// Nothing is sent while the address is empty (the default, and the public code's), while he has not chosen, or with
// "never". With "ask each time" a report goes only when he presses Send for it; with "always" each report made after
// his choice goes. What goes is the report's file itself, byte for byte what the page shows. The delivery is the
// product's own pinned one (src/work/hooks.mjs postPinned): https only, the checked address only, no redirect, no proxy
// of the environment, ten seconds at most. Each send and each failure is one Activity line (by "field", status only).
// A send that fails is kept and tried again with the next send (never by a timer, never in a loop), TRIES_MAX tries.
import { postPinned } from '../work/hooks.mjs';
import { recordActivity } from './activity.mjs';
import { findReport, listReports } from './report.mjs';
import { TRIES_MAX, changeFieldState, madeAfterChoice, readFieldSettings, readFieldState, sendChoice } from './settings.mjs';

export const SEND_TIMEOUT_MS = 10_000;

// A state folder that cannot be written is said once in Activity, not at every tick: again only after a try was noted.
let unnotedSaid = false;

/** Reports he has not answered yet, made after his choice: those "ask each time" waits on, newest first. */
export function waitingReports({ settings = readFieldSettings(), state = readFieldState() } = {}) {
  if (sendChoice(settings) !== 'ask' || state.broken) return [];
  return listReports().reports.filter((x) => madeAfterChoice(x.report.time, settings) && !state.answered[x.report.id]);
}

/** One POST of one report's text. → { ok, status }. */
async function post(settings, text, o) {
  return postPinned(settings.sendTo, text, { ownNetwork: settings.ownNetwork, userAgent: 'Hoprig-Field-Report', timeoutMs: SEND_TIMEOUT_MS, ...o });
}

/**
 * Send these reports (ids), and before them the ones kept from a failed send. Only what the choice allows: with
 * "never" (or no address, no choice) nothing at all. `o`: { lookup, ca } for tests. → [{ id, ok, status }].
 */
export async function sendReports(ids, o = {}) {
  const settings = readFieldSettings();
  const choice = sendChoice(settings);
  if (choice === 'never') return [];
  const state = readFieldState();
  if (state.broken) return []; // what was sent is not known: nothing goes (said once in Activity by settings.mjs)
  const order = [...Object.keys(state.kept), ...ids.filter((id) => !Object.hasOwn(state.kept, id))];
  const out = [];
  for (const id of order) {
    const found = findReport(id);
    // The try is noted BEFORE the POST, as if it fails: a state that cannot be written (a full disk, a folder of
    // another owner) then stops the send before anything goes, instead of posting the same report at every tick.
    try {
      if (!found || !madeAfterChoice(found.report.time, settings)) {
        changeFieldState((s) => (delete s.kept[id], s));
        continue;
      }
      changeFieldState((s) => {
        const tries = (s.kept[id] || 0) + 1;
        delete s.kept[id];
        if (tries < TRIES_MAX) s.kept[id] = tries;
        else s.answered[id] = 'given-up';
        return s;
      });
      unnotedSaid = false;
    } catch {
      if (!unnotedSaid) recordActivity('Field reports were not sent: this computer could not note the try; they go when it can', 'failed: its state folder could not be written');
      unnotedSaid = true;
      return out;
    }
    const r = await post(settings, found.text, o);
    out.push({ id, ok: r.ok, status: r.status });
    if (r.ok) {
      try {
        changeFieldState((s) => {
          delete s.kept[id];
          s.answered[id] = 'sent';
          return s;
        });
      } catch {
        /* noted as a try already: it goes again with the next send, within TRIES_MAX */
      }
    }
    recordActivity(r.ok ? 'A field report was sent' : 'A field report could not be sent; it is tried again with the next one',
      r.ok ? 'ok' : `failed: ${r.status ? `status ${r.status}` : r.refused ? 'its address was refused' : 'no answer'}`);
  }
  return out;
}

/** "Don't send" for a report waiting with "ask each time". */
export function dontSend(id) {
  changeFieldState((s) => {
    s.answered[id] = 'not-sent';
    delete s.kept[id];
    return s;
  });
}

/** After a report is made: with "always", it goes (and what was kept goes with it). Never throws. */
export async function afterReport(r, o = {}) {
  try {
    if (sendChoice() === 'always') return await sendReports([r.id], o);
  } catch {
    /* a send never fails the work */
  }
  return [];
}
