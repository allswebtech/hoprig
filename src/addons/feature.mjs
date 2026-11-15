// Add-ons in the dashboard (Settings → Add-ons), as a server feature: { name, routes }.
//
//   GET  /api/addons                         every add-on with its state: { addons: [{ id, title, summary, homepage,
//                                            installed, version, running, url, job }] }
//   POST /api/addons/<id>/<action>           install | update | start | stop: runs in the background, one at a time
//                                            per add-on; answers { started: true }
//   GET  /api/addons/<id>/job?from=N         that job's output: { running, lines, next, result }
// Making a provider of a gateway is done on the Providers page (Add provider), in the page; `hoprig addons setup <id>`
// does the same in a terminal.
import { ADDONS } from './index.mjs';

const ACTIONS = ['install', 'update', 'start', 'stop'];
const LINES_MAX = 2000;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** `opts.addons`: the add-on list (tests pass fakes). */
export function addonsFeature(sctx, opts = {}) {
  const list = () => opts.addons || ADDONS;
  const jobs = new Map(); // id → { running, lines, result }

  const addonOf = (m) => {
    const a = list().find((x) => x.id === decodeURIComponent(m[1]));
    if (!a) throw fail(404, 'no such add-on');
    return a;
  };

  function run(a, action) {
    const job = { running: true, lines: [], result: null };
    jobs.set(a.id, job);
    const onLine = (l) => {
      job.lines.push(String(l));
      if (job.lines.length > LINES_MAX) job.lines.splice(0, job.lines.length - LINES_MAX);
    };
    const go = action === 'install' || action === 'update' ? a[action]({ onLine }) : a[action]();
    return Promise.resolve(go)
      .then((r) => {
        job.result = { ok: Boolean(r && r.ok), error: (r && r.error) || null, url: (r && r.url) || null };
        if (r && r.error) onLine(r.error);
      })
      .catch((e) => {
        job.result = { ok: false, error: e.message, url: null };
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
      run(a, m[2]);
      return { started: true };
    }],
    ['GET', /^\/api\/addons\/([^/]+)\/job$/, async (req, m, q) => {
      const a = addonOf(m);
      const job = jobs.get(a.id) || { running: false, lines: [], result: null };
      const from = Math.max(0, Math.min(job.lines.length, Number(q && q.get('from')) || 0));
      return { running: job.running, lines: job.lines.slice(from), next: job.lines.length, result: job.result };
    }],
  ];

  return { name: 'addons', routes, jobs };
}
