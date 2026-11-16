// The routes of Settings → Public link (part of the add-ons feature, feature.mjs):
//
//   GET  /api/public-link                        the state: { on, kind, state, url, error, progress, password,
//                                                kinds (each explained), visitor, custom (its set-up), service }
//   POST /api/public-link { on, kind?, password? }
//                                                switch it. On needs a strong dashboard password: when it cannot be
//                                                turned on the answer is { ok: false, need, error } with a plain reason
//                                                and what the page asks for in place (need: password, check-password,
//                                                stronger-password, custom-setup). `password`: the current password,
//                                                typed once when the stored one was never judged (need: check-password).
//                                                Answers at once; the start goes on (state: installing, starting, on).
//   POST /api/public-link/custom/<step>          the Custom set-up: sign-in | cancel | create | token | forget |
//                                                add-service | remove-service, as a job (like an add-on's actions)
//   POST /api/public-link/temporary/<step>       add-service | remove-service: a second temporary address, as a job
//   GET  /api/public-link/job?from=N             that job's output
//
// A linked hub may use them with its machine token: what it turns on is recorded, and ends when the token is revoked.
import { verifyPassword, RateLimiter } from '../server/auth.mjs';
import { loadConfig } from '../config.mjs';
import { notePassword } from '../server/strength.mjs';
import { tokenIdOf } from '../machines/index.mjs';
import { KINDS, status, turnOff, turnOn } from './linkswitch.mjs';

const CUSTOM = ['sign-in', 'cancel', 'create', 'token', 'forget', 'add-service', 'remove-service'];
const TEMPORARY = { 'add-service': 'quick-service-start', 'remove-service': 'quick-service-stop' };

/** `run(addon, action, body, by)` and `jobs`: the add-ons feature's jobs; `addon`: the public link's add-on object. */
export function linkRoutes(sctx, { run, jobs, addon, limiter = new RateLimiter() }) {
  const fail = (code, message) => new sctx.HttpError(code, message);
  const busy = () => {
    if (jobs.get(addon.id)?.running) throw fail(409, 'The public link is busy with something else; wait until it finishes.');
  };
  return [
    ['GET', /^\/api\/public-link$/, async () => status()],
    ['POST', /^\/api\/public-link$/, async (req) => {
      const b = await sctx.readJson(req);
      if (typeof b.on !== 'boolean') throw fail(400, 'send { on: true | false }');
      if (b.kind !== undefined && !KINDS.includes(b.kind)) throw fail(400, 'kind must be "temporary" or "custom"');
      if (b.password !== undefined && (typeof b.password !== 'string' || !b.password || b.password.length > 1024)) throw fail(400, 'password must be a string');
      if (!b.on) return turnOff();
      if (b.password !== undefined) {
        // The stored password was never judged: the owner types it once. Limited like the sign-in.
        const ip = sctx.clientIp(req);
        const wait = limiter.retryAfter(ip);
        if (wait > 0) throw fail(429, `Too many tries. Wait ${Math.ceil(wait / 60000)} min.`);
        limiter.fail(ip);
        const hash = loadConfig().server.passwordHash;
        if (!(await verifyPassword(b.password, hash))) throw fail(403, 'That is not the dashboard password.');
        limiter.succeed(ip);
        notePassword(b.password, hash);
      }
      return turnOn(b.kind || status().kind, { by: tokenIdOf(req) });
    }],
    ['POST', /^\/api\/public-link\/(custom|temporary)\/([a-z-]{1,20})$/, async (req, m) => {
      const body = await sctx.readJson(req);
      const action = m[1] === 'custom' ? (CUSTOM.includes(m[2]) ? `fixed-${m[2]}` : null) : TEMPORARY[m[2]] || null;
      if (!action) throw fail(404, 'no such step');
      busy();
      run(addon, action, body || {}, tokenIdOf(req));
      return { started: true };
    }],
    ['GET', /^\/api\/public-link\/job$/, async (req, m, q) => {
      const job = jobs.get(addon.id) || { running: false, lines: [], result: null };
      const from = Math.max(0, Math.min(job.lines.length, Number(q && q.get('from')) || 0));
      return { running: job.running, lines: job.lines.slice(from), next: job.lines.length, result: job.result };
    }],
  ];
}
