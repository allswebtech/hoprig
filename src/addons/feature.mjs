// Add-ons in the dashboard (Settings → Add-ons), as a server feature: { name, routes }.
//
//   GET  /api/addons                         every add-on with its state: { addons: [{ id, title, summary, homepage,
//                                            installed, version, running, url, job }], skipped: [{ id, error }] (the
//                                            owner's gateway definitions that were not loaded, and why) }
//   POST /api/addons/<id>/<action>           install | update | start | stop: runs in the background, one at a time
//                                            per add-on; answers { started: true }
//   GET  /api/addons/<id>/job?from=N         that job's output: { running, lines, next, result }
//   POST /api/addons/<id>/do/<action>        one of the add-on's own `actions` (the public link: its fixed address,
//                                            another service) with the JSON body, as a job like the ones above. Its
//                                            result may carry `confirm`: a question the page asks before it is sent
//                                            again with { confirmed: true }.
// The public link has a page of its own (Settings → Public link): its routes are in linkroutes.mjs, served here. The
// owner's own gateways are added and removed through gatewayroutes.mjs (/api/gateways/defined/…), served here too.
// A gateway the owner defined carries `defined: true`, `command` (what it runs) and `page` (its own page, or null when
// it has none: its url is only its API); a program that is not a package carries `installable: false` (no Install or
// Update), and `needsConfirm` ('changed' | 'no-fingerprint') while it is not started until the owner confirms its
// program again (/api/gateways/defined/confirm). The shipped gateway's entry is as it was: its page is its url.
// Making a provider of a gateway is done on the Providers page (Add provider), in the page; `hoprig addons setup <id>`
// does the same in a terminal.
// An add-on's attach() runs when the dashboard starts and detach() when it stops (the fixed address runs with it).
//
// A linked hub may run these with its machine token. Then start() and the actions get `by`, the token's id, and an
// add-on that opens something to the network with it (the public link) records that id. When the token is revoked,
// closeOpenedBy(gone) closes exactly what it opened; what the owner opened with his own login is never touched. The
// sweep runs at once after a revoke in this process, when the dashboard starts, and every SWEEP_MS, which catches a
// revoke by another process (`hoprig tokens revoke`). The revoke itself is logged by revokeToken (tokens.mjs).
import { tokenIdOf } from '../machines/index.mjs';
import { defaultHubLabel } from '../machines/hub.mjs';
import { ownersPress } from '../server/ownerpress.mjs';
import { recordHubActivity } from '../machines/tokenaudit.mjs';
import { onRevoke, storedTokens } from '../machines/tokens.mjs';
import { gatewayRoutes } from './gatewayroutes.mjs';
import { gatewayBusy, onePress } from './gatewayhost.mjs';
import { definedGateways } from './gateways.mjs';
import { allAddons } from './index.mjs';
import { noteStarted, noteStopped } from './stopmark.mjs';
import { publicLink } from './linkaddon.mjs';
import { linkRoutes } from './linkroutes.mjs';

const ACTIONS = ['install', 'update', 'start', 'stop'];
const LINES_MAX = 2000;
const SWEEP_MS = 15_000;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The live tokens: id → { name }. */
const liveTokens = () => new Map(storedTokens().map((t) => [t.id, { name: t.name }]));

/** `opts.addons`: the add-on list (tests pass fakes). `opts.record`, `opts.sweepMs`: for tests. */
export function addonsFeature(sctx, opts = {}) {
  const list = () => opts.addons || allAddons();
  const computer = opts.computer || (() => defaultHubLabel()); // the name a confirmation must give
  const jobs = new Map(); // id → { running, lines, result }

  // An add-on is named by its own plain spelling only: "public%2Dlink" is not "public-link" here, so no check in front
  // of this route (Tia's door) can be passed by a spelling that this route reads as another add-on.
  const addonOf = (m) => {
    const a = list().find((x) => x.id === m[1]);
    if (!a) throw fail(404, 'no such add-on');
    return a;
  };

  function run(a, action, body = {}, by = null) {
    const job = { running: true, lines: [], result: null };
    jobs.set(a.id, job);
    const onLine = (l) => {
      job.lines.push(String(l));
      if (job.lines.length > LINES_MAX) job.lines.splice(0, job.lines.length - LINES_MAX);
    };
    const act = () => (ACTIONS.includes(action)
      ? (action === 'install' || action === 'update' ? a[action]({ onLine }) : action === 'start' ? a.start({ by }) : a[action]())
      : a.actions[action](body, { onLine, by }));
    // A gateway: the same one press at a time as Health's routes (gatewayhost.mjs), so the two never run beside each other.
    const go = a.gateway ? onePress(a.id, act, () => new Error(`${a.title} is busy with another press: wait until it finishes`)) : act();
    return Promise.resolve(go)
      .then((r) => {
        // The owner's own stop is remembered (the Operator's gateway rule leaves such a gateway stopped); a start ends it.
        if (r && r.ok && action === 'stop') noteStopped(a.id);
        if (r && r.ok && action === 'start') noteStarted(a.id);
        // A start's first lines (a first password among them): handed to the job's first reader, once (the job route).
        if (action === 'start' && a.firstLines) {
          const lines = a.firstLines.take();
          job.first = lines.length ? { at: Date.now(), lines } : null;
        }
        job.result = { ok: Boolean(r && r.ok), error: (r && r.error) || null, url: (r && r.url) || null, confirm: (r && typeof r.confirm === 'string' && r.confirm) || null, need: (r && typeof r.need === 'string' && r.need) || null };
        if (r && r.error) onLine(r.error);
      })
      .catch((e) => {
        job.result = { ok: false, error: e.message, url: null, confirm: null, need: null };
        onLine(e.message);
      })
      .finally(() => {
        job.running = false;
      });
  }

  const routes = [
    ['GET', /^\/api\/addons$/, async () => ({
      computer: computer(), // what the page's confirmation names, and what it sends back as confirm
      // The owner's definitions that config.json holds but that do not pass the check (a hand edit, a port given to
      // another gateway since): { id, error } each, so the page can say why one is missing.
      skipped: opts.addons ? [] : definedGateways().skipped.map(({ id, error }) => ({ id, error })),
      // The loopback names the owner is signed in under: a gateway's page link takes another (web/gateways.js).
      signedIn: typeof sctx.signedInHosts === 'function' ? sctx.signedInHosts() : [],
      addons: await Promise.all(list().map(async (a) => {
        const st = await Promise.resolve(a.status()).catch(() => ({ installed: false, running: false }));
        const job = jobs.get(a.id);
        return { id: a.id, title: a.title, summary: a.summary, homepage: a.homepage, ...(a.gateway ? { gateway: true } : {}), ...(a.installable === false ? { installable: false } : {}), ...(a.builds ? { builds: a.builds, installCommand: a.installHint() } : {}), ...(a.defined ? { defined: true, command: a.command(), page: a.page() } : {}), ...st, job: job ? { running: job.running, result: job.result } : null };
      })),
    })],
    ['POST', /^\/api\/addons\/([^/]+)\/(install|update|start|stop)$/, async (req, m) => {
      const b = await sctx.readJson(req);
      const a = addonOf(m);
      if (!ACTIONS.includes(m[2])) throw fail(400, 'unknown action');
      // A gateway's install and update change what is installed here: the owner's press (start and stop stay as they were).
      if (a.gateway && (m[2] === 'install' || m[2] === 'update')) {
        ownersPress(sctx, req, b, { name: computer(), what: `${m[2] === 'install' ? 'Installing' : 'Updating'} ${a.title}`, card: (c) => c.tool === 'manage_computer' && c.input.action === 'addon' && c.input.addon === a.id && c.input.addon_action === m[2] });
      }
      if (jobs.get(a.id)?.running || (a.gateway && gatewayBusy(a.id))) throw fail(409, `${a.title} is busy with something else; wait until it finishes`);
      run(a, m[2], {}, tokenIdOf(req));
      return { started: true };
    }],
    ['POST', /^\/api\/addons\/([^/]+)\/do\/([a-z-]{1,40})$/, async (req, m) => {
      const body = await sctx.readJson(req);
      const a = addonOf(m);
      if (!a.actions || !Object.hasOwn(a.actions, m[2])) throw fail(404, 'no such action');
      if (body !== null && body !== undefined && (typeof body !== 'object' || Array.isArray(body))) throw fail(400, 'send a JSON object');
      if (jobs.get(a.id)?.running) throw fail(409, `${a.title} is busy with something else; wait until it finishes`);
      run(a, m[2], body || {}, tokenIdOf(req));
      return { started: true };
    }],
    ['GET', /^\/api\/addons\/([^/]+)\/job$/, async (req, m, q) => {
      const a = addonOf(m);
      const job = jobs.get(a.id) || { running: false, lines: [], result: null };
      const from = Math.max(0, Math.min(job.lines.length, Number(q && q.get('from')) || 0));
      // Once, and for ten minutes at most: after that Hoprig has forgotten them.
      const first = !job.running && job.first && Date.now() - job.first.at <= 10 * 60_000 ? job.first.lines : null;
      job.first = null;
      return { running: job.running, lines: job.lines.slice(from), next: job.lines.length, result: job.result, ...(first ? { first } : {}) };
    }],
    ...linkRoutes(sctx, { run, jobs, addon: opts.link || publicLink }),
    ...gatewayRoutes(sctx),
  ];

  const each = (fn) => Promise.all(list().map((a) => Promise.resolve().then(() => fn(a)).catch((e) => console.error(`add-on ${a.id}: ${e.message}`))));

  // ---- what a revoked token opened ends with it ----
  const record = opts.record || recordHubActivity;
  let known = new Map(); // the tokens at the last look (their names, for the lines below)
  let sweeping = Promise.resolve();
  let timer = null;
  let stopListening = null;
  const who = (id) => (known.has(id) ? `the main computer ${known.get(id).name}` : 'a linked main computer');
  async function sweepNow(ev) {
    if (ev) known.set(ev.id, { name: ev.name });
    const live = liveTokens();
    const gone = (id) => typeof id === 'string' && !live.has(id);
    await each(async (a) => {
      for (const c of (await a.closeOpenedBy?.(gone)) || []) record(c.say(who(c.by)));
    });
    known = live;
  }
  // One at a time, and never a failure that reaches the caller.
  const sweep = (ev) => (sweeping = sweeping.then(() => sweepNow(ev)).catch((e) => console.error(`add-ons: ${e.message}`)));

  return {
    name: 'addons', routes, jobs, sweep: () => sweep(),
    start: () => {
      each((a) => a.attach?.()).then(() => sweep());
      stopListening = onRevoke((ev) => sweep(ev));
      timer = setInterval(() => sweep(), opts.sweepMs || SWEEP_MS);
      timer.unref();
    },
    close: async () => {
      clearInterval(timer);
      stopListening?.();
      await sweeping;
      return each((a) => a.detach?.());
    },
  };
}
