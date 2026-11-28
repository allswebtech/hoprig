// The acts adapter of the real dashboard (plans.mjs actsAdapter): a plan's step is run, taken back and read by the same
// route calls the catalog tools make for one act, through the door (door.mjs), so a step is checked at its route exactly
// like an act done alone. A step that changes something runs inside the owner's confirmed plan card (confirmed.mjs); a
// wait reads inside a look.
import { actsAdapter } from './plans.mjs';
import { callOf, keep, rowById, urlOf } from './catalog.mjs';
import { runAsLook } from './confirmed.mjs';
import { LOCAL } from './shown.mjs';
import { backRowOf, inverseOf } from './inverse.mjs';
import { herArgs } from './herbody.mjs';

/** A step's args without "computer" (it names where the call goes, not a field of the act). */
export const splitArgs = (args) => {
  const { computer, ...rest } = args && typeof args === 'object' ? args : {};
  return { computer: computer && computer !== LOCAL ? computer : null, rest };
};

/** `ops`: the dashboard's ops (routeCall). */
export function dashboardActs(ops) {
  return actsAdapter({
    async run(id, args) {
      const row = rowById(id);
      if (!row) return { ok: false, summary: `there is no act ${String(id).slice(0, 64)}` };
      const { computer, rest } = splitArgs(args);
      const call = callOf(row, herArgs(row, rest));
      // A read passes the door only inside a look; a change only on the confirmed card of this plan.
      const send = () => ops.routeCall(computer, call.method, urlOf(call), call.body);
      const answer = call.method === 'GET' ? await runAsLook(send) : await send();
      const { data } = keep(row, answer);
      // The way back (inverse.mjs) is made now, from this step's own values and what it answered.
      const back = inverseOf(row, rest, answer);
      return { ok: true, summary: `${String(row.what).replace(/\.$/, '')}: done`.slice(0, 160), data, undo: back ? { ...back, computer, ...(row.id === 'ship.p.live' && answer && typeof answer.id === 'string' ? { liveId: answer.id } : {}) } : null };
    },
    // A step is taken back by its inverse act, as the same confirmed card's act (the door binds it to the card's step).
    async undo(token) {
      const row = token && rowById(token.act);
      if (!row) return { ok: false, summary: 'this step has no way back by itself' };
      const call = callOf(row, token.args || {});
      // The back act takes back the project's LAST go-live: only when that is the one this plan started (a later one is his).
      if (row.id === 'ship.p.back') {
        const look = rowById('ship.p');
        const mine = typeof token.liveId === 'string' && look && token.args && typeof token.args.target === 'string';
        let last = null;
        if (mine) {
          try {
            const c = callOf(look, { target: token.args.target });
            const view = await runAsLook(() => ops.routeCall(token.computer || null, 'GET', urlOf(c)));
            last = view && view.last && view.last.id;
          } catch { /* unreadable: not proven to be this plan's */ }
        }
        if (!mine || last !== token.liveId) return { ok: false, summary: 'the last go-live is not this plan\'s: left as it is' };
      }
      await ops.routeCall(token.computer || null, call.method, urlOf(call), call.body);
      return { ok: true, summary: `${String(row.what).replace(/\.$/, '')}: done` };
    },
    backOf: backRowOf,
    async fact(id, args) {
      const row = rowById(id);
      if (!row) throw new Error(`there is no act ${String(id).slice(0, 64)}`);
      const { computer, rest } = splitArgs(args);
      const call = callOf(row, rest);
      return runAsLook(() => ops.routeCall(computer, 'GET', urlOf(call)));
    },
  });
}
