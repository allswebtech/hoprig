// The owner's own gateways in the page (Settings → Add-ons → Add a gateway), part of the add-ons feature:
//
//   POST /api/gateways/defined/add { definition, confirmed? }
//        definition: as in gateways.mjs (id, title, port, npm | bin, args, dashboard). Without confirmed: true the
//        answer is { ok: false, confirm, runs } (the exact program and arguments Hoprig will run); the page shows
//        them and asks, then sends it again with confirmed: true and the `pin` it was given (the program's file and
//        fingerprint, so a yes counts only for what it was shown) → { ok: true, id }.
//   POST /api/gateways/defined/confirm { id, confirmed?, pin? }   its program changed (an update; also one that moved a
//        link to a new folder: what the owner typed when he added it is looked up again) or config.json keeps no
//        fingerprint of it: the question first ({ ok: false, confirm, runs, pin }: the file as it is now, its
//        fingerprint), then with confirmed: true and that pin Hoprig keeps the program as it is now; the definition,
//        its sharing and other computers' keys stay → { ok: true }. { ok: true, already: true } when there is nothing
//        to confirm.
//   POST /api/gateways/defined/remove { id, confirmed? }   the same question first (which providers start it), then
//        it is stopped and forgotten → { ok: true }
//
// A gateway the owner defines is a program Hoprig will run, so these take a browser signed in to this computer's own
// dashboard (its cookie: any such browser, a phone through the public link too, as for everything the password allows),
// never a linked hub's machine token, never one of Tia's requests (src/assistant/door.mjs refuses the path too).
import { tokenIdOf } from '../machines/index.mjs';
import { confirmQuestion, runsLines } from './gatewaycli.mjs';
import { removeService, servicePlan, serviceState } from './gatewayservice.mjs';
import { SHIPPED, addDefinition, checkNew, confirmProgram, gatewayAddons, notLoadedReason, providersOf, removeDefinition, repinned } from './gateways.mjs';

/** A gateway's service taken away before the gateway is: [] when it has none, else what was done. Shared with the command. */
export async function serviceGone(g, { plan = servicePlan(g) } = {}) {
  if (!(await serviceState(plan)).made) return [];
  const r = await removeService(plan);
  return r.lines;
}

export function gatewayRoutes(sctx) {
  const fail = (code, message) => new sctx.HttpError(code, message);
  const ownBrowserOnly = (req) => {
    if (tokenIdOf(req) !== null || !req.headers.cookie) throw fail(403, 'A gateway of your own is added or removed only in a browser signed in to this computer\'s own dashboard (Settings → Add-ons), not through another computer, or with hoprig gateways in its terminal.');
  };
  return [
    ['POST', /^\/api\/gateways\/defined\/add$/, async (req) => {
      ownBrowserOnly(req);
      const b = await sctx.readJson(req);
      const raw = b && b.definition;
      const checked = await checkNew(raw);
      // Which field it is about, for the page to mark it and write its own label: { field, hint }.
      if (checked.error) throw Object.assign(fail(400, checked.error), checked.field ? { details: { field: checked.field, hint: checked.hint } } : {});
      const runs = runsLines(checked.def, { typed: raw.bin });
      // `pin`: the file the question names and its fingerprint. The yes must carry it back: a yes given for another
      // file (one PATH or a link leads to now, or one changed in between) adds nothing.
      const pin = { bin: checked.def.bin, sha256: checked.def.sha256 };
      if (b.confirmed !== true) return { ok: false, confirm: `${checked.def.title} is a program Hoprig will run on this computer.`, runs, pin };
      if (!b.pin || typeof b.pin !== 'object') throw fail(400, 'check the gateway first: the yes names the program it was shown');
      const r = await addDefinition(raw, { expect: { bin: b.pin.bin, sha256: b.pin.sha256 } });
      if (!r.ok) throw Object.assign(fail(400, r.error), r.field ? { details: { field: r.field, hint: r.hint } } : {});
      return { ok: true, id: r.def.id };
    }],
    ['POST', /^\/api\/gateways\/defined\/confirm$/, async (req) => {
      ownBrowserOnly(req);
      const b = await sctx.readJson(req);
      const id = b && typeof b.id === 'string' ? b.id : '';
      const r = repinned(id);
      if (r.error) throw fail(400, r.error);
      if (!r.was) return { ok: true, already: true };
      if (b.confirmed !== true) {
        return {
          ok: false,
          confirm: confirmQuestion(r),
          runs: runsLines(r.def, { typed: r.def.typed, fingerprint: true }),
          pin: { bin: r.def.bin, sha256: r.def.sha256 },
        };
      }
      if (!b.pin || typeof b.pin !== 'object') throw fail(400, 'check the program first: the yes names the program it was shown');
      const c = confirmProgram(id, { expect: { bin: b.pin.bin, sha256: b.pin.sha256 } });
      if (!c.ok) throw fail(400, c.error);
      return { ok: true };
    }],
    ['POST', /^\/api\/gateways\/defined\/remove$/, async (req) => {
      ownBrowserOnly(req);
      const b = await sctx.readJson(req);
      const id = b && typeof b.id === 'string' ? b.id : '';
      if (SHIPPED.some((g) => g.id === id)) throw fail(400, `The gateway ${id} is one Hoprig ships: it cannot be removed`);
      const g = gatewayAddons().find((a) => a.id === id && a.defined);
      // A definition that was not loaded has no add-on: it is only taken out of config.json.
      const notLoaded = g ? null : notLoadedReason(id);
      if (!g && !notLoaded) throw fail(404, 'There is no such gateway of yours');
      if (b.confirmed !== true) {
        const users = providersOf(id);
        return {
          ok: false,
          confirm: `${g ? `${g.title} is stopped if it runs${(await serviceState(servicePlan(g))).made ? ', its service is removed' : ''}, and forgotten.` : `The gateway ${id} is taken out of config.json. It was not loaded (${notLoaded}), so Hoprig does not stop it.`}${users.length ? ` The ${users.length === 1 ? 'provider' : 'providers'} ${users.join(', ')} start${users.length === 1 ? 's' : ''} it: ${users.length === 1 ? 'its' : 'their'} sessions will not start until you change or remove ${users.length === 1 ? 'it' : 'them'}.` : ''}`,
        };
      }
      // What is really there goes first: its service (stopped, disabled, its file removed), then a copy that still runs.
      const lines = g ? await serviceGone(g) : [];
      const stopped = g ? await g.stop() : { ok: true };
      if (!stopped.ok) throw Object.assign(fail(409, stopped.error || `${g.title} did not stop`), stopped.code ? { details: { code: stopped.code } } : {});
      const r = removeDefinition(id);
      if (!r.ok) throw fail(400, r.error);
      // What the service step did, only when it did something: a gateway without a service answers as before.
      return { ok: true, ...(lines.length ? { lines } : {}) };
    }],
  ];
}
