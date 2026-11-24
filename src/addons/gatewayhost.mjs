// The gateways of this computer as Health → Gateways shows them, from this computer's own page or from a hub that
// controls it (its token, relayed at /m/<name>/api/gatewayhost/…), never from Tia's door:
//
//   GET  /api/gatewayhost                         { computer, platform, linger, lingerCommand, gateways: [{ id, title,
//                                                 defined, installed, running, port, service: { kind, made, active,
//                                                 sentence } }] }
//   GET  /api/gatewayhost/<id>/service            what Run as a service would add: { kind, file, text, commands } or
//                                                 { kind, sentence }
//   POST /api/gatewayhost/<id>/start|stop { confirm }        start or stop it now (through its service once one is made)
//   POST /api/gatewayhost/<id>/service { confirm, on }       make (on: true; the copy Hoprig started is stopped first) or
//                                                            remove (on: false) its service
//   POST /api/gatewayhost/linger { confirm }      turn lingering on (sudo -n): { ok } or { needsPassword, command }
//
// `confirm` is this computer's name as the list gave it (`computer`): the page's confirmation names it and the request
// carries it back, so a request without it, or for another computer, changes nothing. Install and update stay on the
// add-ons' own jobs (/api/addons/<id>/install|update). Nothing here runs by itself.
import { gatewayAddons } from './gateways.mjs';
import { lingerCommand, lingerOf, makeService, removeService, serviceNow, servicePlan, serviceState } from './gatewayservice.mjs';
import { defaultHubLabel } from '../machines/hub.mjs';
import { capture, showCommand } from '../setup/system.mjs';

/** Start a gateway here from Health: its own start(), which listens as every start does (localgateway.mjs listenRule). */
export const startHere = (addon) => addon.start();

// The press that runs now for each gateway (start, stop, service; the add-ons' own routes too, feature.mjs): a second
// press while one runs is refused, never run beside it (two starts at once spawned it twice and broke both).
const running = new Map();
/** Is a press for gateway `id` running now? */
export const gatewayBusy = (id) => running.has(id);
/** Run `fn` as the one press for gateway `id`, or refuse with `busy()` (an error to throw) while another runs. */
export async function onePress(id, fn, busy) {
  if (running.has(id)) throw busy();
  const p = Promise.resolve().then(fn);
  running.set(id, p);
  try {
    return await p;
  } finally {
    running.delete(id);
  }
}

export function gatewayHostFeature(ctx, opts = {}) {
  const run = opts.run || ((argv) => capture(argv, { timeout: 30_000 }));
  const list = opts.addons || (() => gatewayAddons());
  const name = opts.computer || (() => defaultHubLabel());
  const planOf = opts.plan || ((a) => servicePlan(a));
  const fail = (status, message, extra = {}) => Object.assign(new ctx.HttpError(status, message), extra);

  /** The owner's page or a hub's token, never Tia's door; and the confirmation that names this computer. */
  async function checked(req) {
    if (ctx.caller && ctx.caller(req) === 'self') throw fail(403, 'a gateway on a computer is started, stopped or made a service only by its owner, on the page');
    const b = await ctx.readJson(req);
    if (typeof b.confirm !== 'string' || b.confirm !== name()) throw Object.assign(fail(400, `confirm it for this computer: send confirm with its name (${name()})`), { details: { code: 'confirm' } });
    return b;
  }
  const addonOf = (id) => {
    const a = list().find((x) => x.id === id);
    if (!a) throw fail(404, 'there is no such gateway on this computer');
    return a;
  };
  const statusOf = (a) => Promise.resolve(a.status({ version: false })).catch(() => ({}));
  // A service starts its program and returns at once: the answer waits until the gateway answers on its port (as a
  // start without a service does), so the list drawn after it shows what runs. [] when it answers, else one line.
  const waitMs = opts.answerWaitMs ?? 15_000;
  async function answered(a) {
    if (typeof a.answering !== 'function') return [];
    for (const end = Date.now() + waitMs; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
      if ((await Promise.resolve(a.answering()).catch(() => ({}))).mine) return [];
    }
    return [`${a.title} does not answer on port ${a.gateway ? a.gateway.port() : '?'} yet: press Refresh in a moment`];
  }
  const busy = (a) => () => Object.assign(fail(409, `${a.title} is busy with another press: wait until it finishes`), { details: { code: 'busy' } });
  const shown = (plan) => (plan.commands ? { kind: plan.kind, file: plan.file, text: plan.text, commands: plan.commands.map(showCommand) } : { kind: plan.kind, sentence: plan.sentence });

  return {
    name: 'gatewayhost',
    routes: [
      ['GET', /^\/api\/gatewayhost$/, async () => {
        const gateways = await Promise.all(list().map(async (a) => {
          const st = await Promise.resolve(a.status()).catch(() => ({ installed: false, running: false }));
          const plan = planOf(a);
          return { id: a.id, title: a.title, marksFirst: a.marksFirst === true, firstWaiting: Boolean(a.firstLines && a.firstLines.waiting()), defined: a.defined === true, installed: !!st.installed, running: !!st.running, port: a.gateway ? Number(a.gateway.port()) : null, service: { kind: plan.kind, ...(plan.sentence ? { sentence: plan.sentence } : {}), ...(await serviceState(plan, { run })) } };
        }));
        const linger = await lingerOf({ run }).catch(() => null);
        const signedIn = typeof ctx.signedInHosts === 'function' ? ctx.signedInHosts() : [];
        return { computer: name(), platform: process.platform, linger, lingerCommand: linger === 'off' ? showCommand(lingerCommand()) : null, signedIn, gateways };
      }],
      ['GET', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/service$/, async (req, m) => shown(planOf(addonOf(m[1])))],
      ['POST', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/(start|stop)$/, async (req, m) => {
        await checked(req);
        const a = addonOf(m[1]);
        const plan = planOf(a);
        // Each acts on what really runs: the copy on its port, whoever started it, and its service where that is made.
        const r = await onePress(a.id, async () => {
          if (!(await serviceState(plan, { run })).made) {
            const x = m[2] === 'start' ? await startHere(a) : await a.stop();
            if (!x.ok) return x;
            if (x.already) return { ...x, lines: [m[2] === 'start' ? `${a.title} was running already` : x.note || `${a.title} was not running`] };
            return { ...x, lines: [m[2] === 'start' ? `Started ${a.title}` : `Stopped ${a.title}`] };
          }
          const st = await statusOf(a);
          if (m[2] === 'start') {
            // A copy started outside its service (Settings, Tia, a session) holds the port: left as it is, and said.
            if (st.running && !st.byService) return { ok: true, already: true, outside: true, lines: [`${a.title} runs already, started outside its service, and was left as it is. To run it through its service, stop it here and start it again.`] };
            const x = await serviceNow(plan, 'start', { run });
            if (!x.ok) return x;
            if (st.running) return { ok: true, service: true, lines: [`${a.title}'s service runs already`] };
            return { ok: true, service: true, lines: [`Started ${a.title}'s service`, ...(await answered(a))] };
          }
          const x = await serviceNow(plan, 'stop', { run });
          if (!x.ok) return x;
          const lines = [`Stopped ${a.title}'s service`];
          const after = await statusOf(a);
          if (after.running && !after.byService) {
            const y = await a.stop();
            if (!y.ok) return { ok: false, error: `${a.title}'s service was stopped, but the copy started outside it was not: ${y.error || 'no reason given'}` };
            lines.push(`Stopped the copy of ${a.title} that was started outside its service`);
          }
          return { ok: true, service: true, lines };
        }, busy(a));
        // What this start printed first (a first password among it), shown once on this answer, failed or not.
        const first = m[2] === 'start' && a.firstLines ? a.firstLines.take() : [];
        if (!r.ok) throw fail(409, r.error || `${a.title} did not ${m[2]}`, first.length ? { details: { first } } : {});
        return { ok: true, already: r.already === true, service: r.service === true, ...(r.outside ? { outside: true } : {}), lines: r.lines || [], ...(first.length ? { first } : {}) };
      }],
      // What a start made elsewhere (Settings, Tia, a session) printed first: shown once, on his press.
      ['POST', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/first$/, async (req, m) => {
        await checked(req);
        const a = addonOf(m[1]);
        return { first: a.firstLines ? a.firstLines.take() : [] };
      }],
      ['POST', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/service$/, async (req, m) => {
        const b = await checked(req);
        if (typeof b.on !== 'boolean') throw fail(400, 'say on: true to make the service, on: false to remove it');
        const a = addonOf(m[1]);
        const plan = planOf(a);
        let stopped = false;
        const r = await onePress(a.id, async () => {
          if (!b.on) return removeService(plan, { run });
          // A copy outside the service holds the port: stopped first, so the service's copy is the one that runs. Not
          // where the service is made and may run it (launchd cannot say whether it is active): a second press changes nothing.
          const svc = await serviceState(plan, { run });
          const st = await statusOf(a);
          if (st.running && !st.byService && (!svc.made || svc.active === false)) {
            const s0 = await a.stop();
            if (!s0.ok) return { ok: false, lines: [`${a.title} could not be stopped first: ${s0.error || 'no reason given'}`] };
            stopped = true;
          }
          const made = await makeService(plan, { run });
          const wait = made.ok && !made.already ? await answered(a) : [];
          return stopped ? { ...made, lines: [`Stopped the ${a.title} Hoprig had started`, ...made.lines, ...wait] } : { ...made, lines: [...made.lines, ...wait] };
        }, busy(a));
        if (!r.ok) throw fail(409, r.lines.join(' · '));
        return { ok: true, already: r.already === true, stopped, lines: r.lines, linger: b.on ? await lingerOf({ run }).catch(() => null) : null };
      }],
      ['POST', /^\/api\/gatewayhost\/linger$/, async (req) => {
        await checked(req);
        const cmd = lingerCommand();
        // -n: sudo never asks; where it would need a password the owner gets the command to type himself.
        const r = await run([cmd[0], '-n', ...cmd.slice(1)]);
        if (r.ok) return { ok: true };
        if (/password is required|a terminal is required|no tty present/i.test(r.stderr || '')) return { ok: false, needsPassword: true, command: showCommand(cmd) };
        throw fail(409, `${showCommand(cmd)} did not work: ${(r.stderr || r.stdout || 'no reason given').trim().split('\n').pop()}`);
      }],
    ],
  };
}
