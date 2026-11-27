// Settings → "Allow bypass permissions mode" (bypassgate.mjs says what it gates). The one-time step for a dashboard
// that had no such switch runs when the dashboard starts listening, before the open App sessions are made (this
// feature comes before the chat in server.mjs's list), so a session in bypass keeps it.
//   GET  /api/settings/bypass        → { allow, kept (when the one-time step kept bypass on: Home says it once),
//                                    terminals (terminal sessions running in bypass now) }
//   POST /api/settings/bypass        { allow, confirm }   on: only with confirm: true (the page asks first); off: the
//                                    open App sessions in bypass go to Manual, and New sessions stop naming it
//   POST /api/settings/bypass/everything   { confirm: true }   "Allow everything" accepted once on this computer (the sheet
//                                    the page shows the first time): only the owner's own page; Tia's door and another
//                                    computer's token get 403, a switch that is off 409. GET says `everything` (true once accepted) while Bypass is allowed.
//   POST /api/settings/bypass/seen   Home's note about the one-time step was read: it goes
import path from 'node:path';
import { ALL, BYPASS, allAllowed, bypassAllowed, bypassInArgs, firstLook } from '../bypassgate.mjs';
import { NOT_OWNER_LINE, SWITCH_OFF_LINE } from '../allguard.mjs';
import { fromHerDoor } from './herdoor.mjs';
import { stateDir } from '../paths.mjs';
import { listRuns } from '../runs.mjs';

/** o: { chat (the chat feature: bypassOff()), chatsFile, runs } (tests) */
export function bypassFeature(ctx, o = {}) {
  const cfg = () => ctx.config();
  const runs = o.runs || (() => listRuns({ usage: false }));
  // Terminal sessions running in bypass now: turning the switch off reaches them only at their next start.
  const terminals = () => {
    try {
      return (runs() || []).filter((r) => r && bypassInArgs(r.carryArgs)).length;
    } catch {
      return 0;
    }
  };
  // Root as the dashboard knows it (ctx.root, the same fact as the start sheet's): as root nothing is "kept allowed".
  const root = () => (typeof ctx.root === 'boolean' ? ctx.root : undefined);
  const allowed = () => bypassAllowed(cfg(), root());
  const view = () => ({ allow: allowed(), kept: allowed() && Number.isFinite(cfg().bypassKept) ? cfg().bypassKept : null, terminals: terminals(), ...(allowed() ? { everything: allAllowed(cfg(), root()) } : {}) });
  return {
    name: 'bypass',
    start() {
      firstLook({ cfg: cfg(), save: ctx.saveConfig, chatsFile: o.chatsFile || path.join(stateDir(), 'chats.json'), runs, marker: o.marker || path.join(stateDir(), 'bypass-first-look.json') });
    },
    routes: [
      ['GET', /^\/api\/settings\/bypass$/, async () => view()],
      ['POST', /^\/api\/settings\/bypass$/, async (req) => {
        const b = await ctx.readJson(req);
        if (typeof b.allow !== 'boolean') throw new ctx.HttpError(400, 'say allow: true or false');
        if (b.allow && b.confirm !== true) throw new ctx.HttpError(400, 'turning on bypass permissions mode needs your confirmation');
        if (b.allow) {
          ctx.saveConfig({ allowBypass: true, bypassKept: null });
          o.chat?.bypassChanged?.(); // an open App page offers Bypass permissions at once
          return { ...view(), changed: 0 };
        }
        const d = cfg().sessionDefaults || {};
        const off = d.permissionMode === BYPASS || d.permissionMode === ALL; // a default of either goes with the switch
        ctx.saveConfig({ allowBypass: false, bypassKept: null, ...(off ? { sessionDefaults: { ...d, permissionMode: undefined } } : {}) });
        const changed = o.chat && o.chat.bypassOff ? await o.chat.bypassOff() : 0;
        o.chat?.bypassChanged?.(); // …and stops offering it
        ctx.poke?.();
        return { ...view(), changed, defaults: off };
      }],
      ['POST', /^\/api\/settings\/bypass\/everything$/, async (req) => {
        // The owner's own page only: not Tia's door ('self'), not another computer's token ('computer').
        if (fromHerDoor(ctx, req)) throw new ctx.HttpError(403, NOT_OWNER_LINE);
        if (ctx.caller(req) !== 'page') throw new ctx.HttpError(403, NOT_OWNER_LINE);
        const b = await ctx.readJson(req);
        if (b.confirm !== true) throw new ctx.HttpError(400, 'accepting Allow everything needs your confirmation');
        if (!allowed()) throw Object.assign(new ctx.HttpError(409, SWITCH_OFF_LINE), { code: 'bypass-off', details: { code: 'bypass-off' } });
        ctx.saveConfig({ allowEverythingAt: Date.now() });
        o.chat?.bypassChanged?.();
        return view();
      }],
      ['POST', /^\/api\/settings\/bypass\/seen$/, async (req) => {
        await ctx.readJson(req);
        ctx.saveConfig({ bypassKept: null });
        return view();
      }],
    ],
  };
}
