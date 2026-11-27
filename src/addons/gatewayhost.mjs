// The gateways of this computer as Health → Gateways shows them, from this computer's own page or from a hub that
// controls it (its token, relayed at /m/<name>/api/gatewayhost/…), never from Tia's door:
//
//   GET  /api/gatewayhost                         { computer, platform, linger, lingerCommand, gateways: [{ id, title,
//                                                 defined, installed, running, copy ('own' | 'global'), note (another
//                                                 user's program on its port), problem (a damaged copy), foreign, port, service: { kind, made, active,
//                                                 sentence } }] }
//   GET  /api/gatewayhost/<id>/service            what Run as a service would add: { kind, file, text, commands } or
//                                                 { kind, sentence }
//   POST /api/gatewayhost/<id>/start|stop { confirm }        start or stop it now (through its service once one is made)
//   POST /api/gatewayhost/<id>/service { confirm, on }       make (on: true; the copy Hoprig started is stopped first) or
//                                                            remove (on: false) its service
//   POST /api/gatewayhost/linger { confirm }      turn lingering on (sudo -n): { ok } or { needsPassword, command }
//   POST /api/gatewayhost/<id>/restart { confirm }           stop it and start it again (for a setting changed in its own
//                                                            page), through its service where one is made: { ok, lines }
//   GET  /api/gatewayhost/<id>/log                { lines, left, listens }: the last 100 lines of its log file, a line that
//                                                 may hold a secret left out (left counts them), and in one line how it
//                                                 listens (this computer only, or the network; nothing to set)
//   POST /api/gatewayhost/<id>/setup { confirm }         Set up in one press, as a background job (one at a time, a
//                                                            second press is refused 409): installs it when it is missing,
//                                                            starts it, waits until it is ready, makes the key "Hoprig
//                                                            sessions (<computer>)", writes the provider and runs the first
//                                                            check → { started: true }
//   GET  /api/gatewayhost/<id>/setup/job?from=N          the job's lines: { running, lines, next, result } (result:
//                                                            { ok, error } with one plain sentence and the next step)
//   GET  /api/gatewayhost/<id>/password                  { file, exists }: where its own first password is kept (the file
//                                                            is never read here)
//   POST /api/gatewayhost/<id>/password { confirm, password }   its own reset-password command with the same data folder;
//                                                            the password goes by its standard input and is never kept,
//                                                            logged or answered → { ok, line }
//   GET  /api/gatewayhost/trouteai/public               its public address: { state, hostname, url, answers, told, linkOn, need, why }
//   POST /api/gatewayhost/trouteai/public { confirm, on }  turn it on or off (src/addons/trouteaipublic.mjs): only the owner's own
//                                                            browser, never a linked computer's token, Tia or a session
// Every route of this list answers the owner's page and a linked main computer, never Tia or a coding session (caller
// "self": 403), and every change carries `confirm`. Nothing that comes back holds a provider's key, token or sign-in.
//
// `confirm` is this computer's name as the list gave it (`computer`): the page's confirmation names it and the request
// carries it back, so a request without it, or for another computer, changes nothing. Install, update and remove stay on the
// add-ons' own jobs (/api/addons/<id>/install|update|remove). Nothing here runs by itself.
import fs from 'node:fs';
import path from 'node:path';
import { gatewayAddons } from './gateways.mjs';
import { hasSetUp, listensSentence, logFileOf, lastLines, ownProgramCommand, scrub, setupShippedGateway } from '../gateway/trouteai.mjs';
import { lingerCommand, lingerOf, makeService, removeService, serviceNow, servicePlan, serviceState } from './gatewayservice.mjs';
import { defaultHubLabel } from '../machines/hub.mjs';
import { tokenIdOf } from '../machines/index.mjs';
import { fromHerDoor } from '../server/herdoor.mjs';
import { fixedMarkTold } from './fixedlink.mjs';
import { stateOf as publicState, turnOff as publicOff, turnOn as publicOn } from './trouteaipublic.mjs';
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

/** A copy is installed (its status says so) but the service search cannot find its program: say that, never "not installed". */
const missingProgram = (title, copy) => `Hoprig cannot find the program of this copy of ${title} to run it as a service.${copy === 'global' ? " Press Install here: a copy in Hoprig's own folder can run as a service." : copy === 'own' ? ' Install it again.' : ''}`;

/** One look from this computer at the public address's sign-in page: does it answer (any HTTP answer below 500)? */
async function look(url) {
  try {
    const r = await fetch(`${url}/login`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export function gatewayHostFeature(ctx, opts = {}) {
  const run = opts.run || ((argv) => capture(argv, { timeout: 30_000 }));
  const list = opts.addons || (() => gatewayAddons());
  const name = opts.computer || (() => defaultHubLabel());
  const planOf = opts.plan || ((a) => servicePlan(a));
  const setup = opts.setup || setupShippedGateway;
  const baseOf = async () => opts.base || (await import('../gateway/trouteaibase.mjs'));
  const input = opts.runInput || ((argv, text) => capture(argv, { timeout: 30_000, input: text }));
  const logOf = opts.logFile || logFileOf;
  const jobs = new Map(); // gateway id → { running, lines, result } of its Set up
  const fail = (status, message, extra = {}) => Object.assign(new ctx.HttpError(status, message), extra);

  /** The owner's page or a hub's token, never Tia's door; and the confirmation that names this computer. */
  const ownerOnly = (req) => {
    if (fromHerDoor(ctx, req)) throw fail(403, 'a gateway on a computer is started, stopped or made a service only by its owner, on the page');
  };
  async function checked(req) {
    ownerOnly(req);
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
  /** The shipped gateway that Hoprig sets up and manages itself; one the owner defined is not. */
  const shippedOnly = (a) => {
    if (!hasSetUp(a)) throw fail(404, `${a.title} has nothing to set up here`);
    return a;
  };
  const busy = (a) => () => Object.assign(fail(409, `${a.title} is busy with another press: wait until it finishes`), { details: { code: 'busy' } });
  const shown = (plan) => (plan.commands ? { kind: plan.kind, file: plan.file, text: plan.text, commands: plan.commands.map(showCommand) } : { kind: plan.kind, sentence: plan.sentence });

  /** One start or stop of `a` that acts on what really runs: the copy on its port, whoever started it, and its service. */
  async function act(a, plan, kind) {
    if (!(await serviceState(plan, { run })).made) {
      const x = kind === 'start' ? await startHere(a) : await a.stop();
      if (!x.ok) return x;
      if (x.already) return { ...x, lines: [kind === 'start' ? `${a.title} was running already` : x.note || `${a.title} was not running`] };
      return { ...x, lines: [kind === 'start' ? `Started ${a.title}` : `Stopped ${a.title}`] };
    }
    const st = await statusOf(a);
    if (kind === 'start') {
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
  }

  /** Stop it (when it runs) and start it again, each through its service where one is made: { ok, lines } or { ok: false, error }. */
  async function bounce(a, plan) {
    const was = await statusOf(a);
    const lines = [];
    if (was.running) {
      const x = await act(a, plan, 'stop');
      if (!x.ok) return x;
      lines.push(...(x.lines || []));
    }
    const y = await act(a, plan, 'start');
    if (!y.ok) return y;
    return { ok: true, lines: [...lines, ...(y.lines || [])] };
  }
  /** The owner's own browser: its sign-in cookie, no machine token, not one of Tia's in-process requests. */
  const ownBrowser = (req) => !(ctx.caller && ctx.caller(req) === 'self') && (opts.tokenOf || tokenIdOf)(req) === null && Boolean(req.headers && req.headers.cookie);
  const told = (a) => {
    if (hasSetUp(a)) (opts.markTold || fixedMarkTold)();
  };
  const pub = opts.public || {};
  /** What the public address looks at, each one overridable by a test. */
  async function publicDeps(a) {
    const folder = (await baseOf()).dataFolder();
    return {
      fixed: pub.fixed,
      link: pub.link || (async () => (await import('./linkswitch.mjs')).status({ why: false })),
      gateway: pub.gateway || (async () => {
        const st = await statusOf(a);
        return { installed: Boolean(st.installed), running: Boolean(st.running), version: st.version || null };
      }),
      firstFile: pub.firstFile || (() => path.join(folder, 'initial-admin-password.txt')),
      signIn: pub.signIn || (async () => {
        try {
          return await (opts.gatewayCall || (await import('../gateway/trouteaimanage.mjs')).callGateway)('GET', '/api/settings/require-login', { port: Number(a.gateway.port()), folder });
        } catch {
          return null;
        }
      }),
      openApi: pub.openApi,
      step: pub.step || (async (n, b, o) => (await import('./linkswitch.mjs')).customStep(n, b, o)),
    };
  }

  return {
    name: 'gatewayhost',
    routes: [
      ['GET', /^\/api\/gatewayhost$/, async () => {
        const gateways = await Promise.all(list().map(async (a) => {
          const st = await Promise.resolve(a.status()).catch(() => ({ installed: false, running: false }));
          const plan = planOf(a);
          return { id: a.id, title: a.title, marksFirst: a.marksFirst === true, firstWaiting: Boolean(a.firstLines && a.firstLines.waiting()), defined: a.defined === true, manage: hasSetUp(a), listens: hasSetUp(a) ? listensSentence(a) : null, installed: !!st.installed, running: !!st.running, ...(st.version ? { version: st.version } : {}), ...(st.newer === true ? { newer: true } : {}), ...(st.copy ? { copy: st.copy } : {}), ...(st.note ? { note: st.note } : {}), ...(st.restart ? { restart: st.restart } : {}), ...(st.problem ? { problem: st.problem } : {}), ...(st.foreign ? { foreign: true } : {}), port: a.gateway ? Number(a.gateway.port()) : null, service: { kind: plan.kind, ...(plan.sentence ? { sentence: plan.kind === 'missing' && st.installed ? missingProgram(a.title, st.copy) : plan.sentence } : {}), ...(await serviceState(plan, { run })) } };
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
        const r = await onePress(a.id, () => act(a, plan, m[2]), busy(a));
        // What this start printed first (a first password among it), shown once on this answer, failed or not.
        if (r.ok && m[2] === 'start') told(a);
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
        if (b.on) told(a);
        return { ok: true, already: r.already === true, stopped, lines: r.lines, linger: b.on ? await lingerOf({ run }).catch(() => null) : null };
      }],
      // Stop it and start it again, for a setting changed in the gateway's own page: both as one press.
      ['POST', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/restart$/, async (req, m) => {
        await checked(req);
        const a = addonOf(m[1]);
        const plan = planOf(a);
        const r = await onePress(a.id, async () => bounce(a, plan), busy(a));
        if (r.ok) told(a);
        const first = a.firstLines ? a.firstLines.take() : [];
        if (!r.ok) throw fail(409, r.error || `${a.title} did not restart`, first.length ? { details: { first } } : {});
        return { ok: true, lines: r.lines || [`Restarted ${a.title}`], ...(first.length ? { first } : {}) };
      }],
      // Its log file's last lines, and how it listens: one look when the owner opens it, nothing runs by itself.
      ['GET', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/log$/, async (req, m) => {
        ownerOnly(req);
        const a = addonOf(m[1]);
        let text = '';
        try {
          const fd = fs.openSync(logOf(a.id), 'r');
          try {
            const size = fs.fstatSync(fd).size;
            const from = Math.max(0, size - 65_536);
            const buf = Buffer.alloc(size - from);
            fs.readSync(fd, buf, 0, buf.length, from);
            text = buf.toString('utf8');
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          /* nothing written yet */
        }
        return { ...lastLines(text), listens: listensSentence(a) };
      }],
      // Set up in one press, as a background job like an add-on's install (one at a time).
      ['POST', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/setup$/, async (req, m) => {
        await checked(req);
        const a = shippedOnly(addonOf(m[1]));
        if (gatewayBusy(a.id) || jobs.get(a.id)?.running) throw busy(a)();
        const job = { running: true, lines: [], result: null };
        jobs.set(a.id, job);
        const onLine = (l) => {
          job.lines.push(String(l));
          if (job.lines.length > 500) job.lines.splice(0, job.lines.length - 500);
        };
        onePress(a.id, () => setup({ addon: a, onLine, computer: name() }), busy(a))
          .then((r) => {
            job.result = r && r.ok ? { ok: true, error: null, kept: r.kept === true, name: r.name || null } : { ok: false, error: (r && r.error) || `${a.title} could not be set up` };
            onLine(r && r.ok ? `${a.title} is set up.` : job.result.error);
          })
          .catch((e) => {
            job.result = { ok: false, error: `${a.title} could not be set up: ${scrub(e.message)}` };
            onLine(job.result.error);
          })
          .finally(() => {
            job.running = false;
          });
        return { started: true };
      }],
      ['GET', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/setup\/job$/, async (req, m, q) => {
        ownerOnly(req);
        const a = shippedOnly(addonOf(m[1]));
        const job = jobs.get(a.id) || { running: false, lines: [], result: null };
        const from = Math.max(0, Math.min(job.lines.length, Number(q && q.get('from')) || 0));
        return { running: job.running, lines: job.lines.slice(from), next: job.lines.length, result: job.result };
      }],
      // Its own first password: where the file is (never read here), and a new one through its own command.
      ['GET', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/password$/, async (req, m) => {
        ownerOnly(req);
        shippedOnly(addonOf(m[1]));
        const file = path.join((await baseOf()).dataFolder(), 'initial-admin-password.txt');
        return { file, exists: fs.existsSync(file) };
      }],
      ['POST', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/password$/, async (req, m) => {
        const b = await checked(req);
        const a = shippedOnly(addonOf(m[1]));
        const pw = b.password;
        if (typeof pw !== 'string' || pw.length < 12 || pw.length > 200 || /[\r\n]/.test(pw)) throw fail(400, 'The new password has 12 to 200 characters on one line.');
        const plan = ownProgramCommand(a, ['reset-password', '--password-stdin'], (await baseOf()).dataFolder());
        if (!plan) throw fail(409, `${a.title}'s program was not found: set it up first.`);
        const r = await onePress(a.id, () => input([plan.command, ...plan.args], pw), busy(a));
        if (!r.ok) throw fail(409, `${a.title} did not take the new password${r.stderr ? ` (${scrub(String(r.stderr).split('\n').filter(Boolean).pop())})` : ''}. Next step: stop ${a.title}'s page, start it again from Hoprig, then try again.`);
        // The first password in its file is no longer the password: the file goes, so nothing still says it is.
        fs.rmSync(path.join((await baseOf()).dataFolder(), 'initial-admin-password.txt'), { force: true });
        return { ok: true, line: `The new password is set. Every browser that was signed in to ${a.title} is signed out.` };
      }],
      // Its public address (trouteaipublic.mjs): read by the page, turned on or off only by the owner's own browser.
      ['GET', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/public$/, async (req, m) => {
        ownerOnly(req);
        const a = shippedOnly(addonOf(m[1]));
        return publicState(await publicDeps(a));
      }],
      ['POST', /^\/api\/gatewayhost\/([a-z][a-z0-9-]{0,30})\/public$/, async (req, m) => {
        if (!ownBrowser(req)) throw fail(403, 'TRouteAI\'s public address is turned on and off only by you, in your own browser on this computer\'s page: not by Tia, a session, another computer or the command line.');
        const b = await checked(req);
        const a = shippedOnly(addonOf(m[1]));
        if (typeof b.on !== 'boolean') throw fail(400, 'say on: true to turn the public address on, on: false to turn it off');
        if ((opts.linkBusy || (() => false))()) throw Object.assign(fail(409, 'The public link is busy with something else; wait until it finishes.'), { details: { need: 'busy' } });
        const deps = await publicDeps(a);
        const plan = planOf(a);
        const r = await onePress(a.id, async () => {
          const was = b.on ? await publicState(deps) : null;
          const x = b.on ? await publicOn(deps) : await publicOff(deps);
          if (!x.ok) return x;
          const lines = [...x.lines];
          // Nothing changed (no name to take out, or the name is there and TRouteAI was told): no restart, sessions are not made to wait.
          if (x.already && (!b.on || was.told)) return { ok: true, lines, answers: null };
          // The service file names the address (its environment): written again when its text changed, then TRouteAI starts with it.
          if ((await serviceState(plan, { run })).made) lines.push(...(await makeService(planOf(a), { run })).lines);
          const st = await statusOf(a);
          if (st.running) {
            const y = await bounce(a, planOf(a));
            if (!y.ok) return { ok: false, need: 'restart', error: `The name is set, but ${a.title} did not restart: ${y.error || 'no reason given'}` };
            lines.push(...(y.lines || []));
            if (b.on) told(a);
          }
          let answers = null;
          if (b.on && x.url) {
            answers = await (pub.look || look)(x.url);
            lines.push(answers ? `${x.url} answers.` : `${x.url} does not answer yet: the new name can take a minute to be known. Look again in a moment.`);
          }
          return { ok: true, lines, answers };
        }, busy(a));
        if (!r.ok) throw Object.assign(fail(409, r.error), { details: { need: r.need } });
        return { ok: true, lines: r.lines, answers: r.answers };
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
