// Add-ons in the dashboard (Settings → Add-ons), as a server feature: { name, routes }.
//
//   GET  /api/addons                         every add-on with its state: { addons: [{ id, title, summary, homepage,
//                                            installed, version, running, url, job }] }
//   POST /api/addons/<id>/<action>           install | update | start | stop: runs in the background, one at a time
//                                            per add-on; answers { started: true }
//   GET  /api/addons/<id>/job?from=N         that job's output: { running, lines, next, result }
//   POST /api/addons/<id>/do/<action>        one of the add-on's own `actions` (the public link: its fixed address,
//                                            another service) with the JSON body, as a job like the ones above. Its
//                                            result may carry `confirm`: a question the page asks before it is sent
//                                            again with { confirmed: true }.
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
import { recordHubActivity } from '../machines/tokenaudit.mjs';
import { onRevoke, storedTokens } from '../machines/tokens.mjs';
import { ADDONS } from './index.mjs';

const ACTIONS = ['install', 'update', 'start', 'stop'];
const LINES_MAX = 2000;
const SWEEP_MS = 15_000;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The live tokens: id → { name }. */
const liveTokens = () => new Map(storedTokens().map((t) => [t.id, { name: t.name }]));

/** `opts.addons`: the add-on list (tests pass fakes). `opts.record`, `opts.sweepMs`: for tests. */
export function addonsFeature(sctx, opts = {}) {
  const list = () => opts.addons || ADDONS;
  const jobs = new Map(); // id → { running, lines, result }

  const addonOf = (m) => {
    const a = list().find((x) => x.id === decodeURIComponent(m[1]));
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
    const go = ACTIONS.includes(action)
      ? (action === 'install' || action === 'update' ? a[action]({ onLine }) : action === 'start' ? a.start({ by }) : a[action]())
      : a.actions[action](body, { onLine, by });
    return Promise.resolve(go)
      .then((r) => {
        job.result = { ok: Boolean(r && r.ok), error: (r && r.error) || null, url: (r && r.url) || null, confirm: (r && typeof r.confirm === 'string' && r.confirm) || null };
        if (r && r.error) onLine(r.error);
      })
      .catch((e) => {
        job.result = { ok: false, error: e.message, url: null, confirm: null };
        onLine(e.message);
      })
      .finally(() => {
        job.running = false;
      });
  }

  const routes = [
    ['GET', /^\/api\/addons$/, async () => ({
      addons: await Promise.all(list().map(async (a) => {
        const st = await Promise.resolve(a.status()).catch(() => ({ installed: false, running: false }));
        const job = jobs.get(a.id);
        return { id: a.id, title: a.title, summary: a.summary, homepage: a.homepage, ...st, job: job ? { running: job.running, result: job.result } : null };
      })),
    })],
    ['POST', /^\/api\/addons\/([^/]+)\/(install|update|start|stop)$/, async (req, m) => {
      await sctx.readJson(req);
      const a = addonOf(m);
      if (!ACTIONS.includes(m[2])) throw fail(400, 'unknown action');
      if (jobs.get(a.id)?.running) throw fail(409, `${a.title} is busy with something else; wait until it finishes`);
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
      return { running: job.running, lines: job.lines.slice(from), next: job.lines.length, result: job.result };
    }],
  ];

  const each = (fn) => Promise.all(list().map((a) => Promise.resolve().then(() => fn(a)).catch((e) => console.error(`add-on ${a.id}: ${e.message}`))));

  // ---- what a revoked token opened ends with it ----
  const record = opts.record || recordHubActivity;
  let known = new Map(); // the tokens at the last look (their names, for the lines below)
  let sweeping = Promise.resolve();
  let timer = null;
  let stopListening = null;
  const who = (id) => (known.has(id) ? `the hub ${known.get(id).name}` : 'a linked hub');
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
