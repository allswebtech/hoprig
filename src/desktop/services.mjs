// The Services app: the services of this computer (systemd on Linux, launchd on macOS, read-only on Windows) with
// their state, start / stop / restart, and the last lines of a service's log.
//
// The rules, in the order they are checked:
//   - the scope, the action and the name are checked here (the name against the OS's own pattern, and it follows a
//     "--" in the argv);
//   - Windows: read-only (administrator rights cannot be handed to a program with a password there);
//   - this dashboard's own service, and a unit it runs inside, are refused: stopping one would cut the page off;
//   - stopping or restarting SSH (and on Linux the network's and the sign-in's own units) asks for its name to be
//     typed first (`confirm`): it can cut the computer off;
//   - the system's services go through sudo with the computer's password, as Setup does it (pcsetup/admin.mjs): the
//     password goes to sudo's input only, is checked first, is never kept, and is scrubbed from the output. From
//     another dashboard it is accepted only over an encrypted leg (machines/legs.mjs), like Setup's.
//   - wrong passwords are counted per caller (a browser's address, or a hub's token): after a few in a short time
//     the next try waits, so a run of guesses cannot lock the owner's account where the system locks one after
//     failed sudo tries (pam_faillock).
import { asAdmin, checkPassword, scrubber } from '../pcsetup/admin.mjs';
import { RateLimiter } from '../server/auth.mjs';

export const ACTIONS = ['start', 'stop', 'restart'];
const fail = (status, message) => Object.assign(new Error(message), { status });

/** The password as the page sends it: 1 to 512 characters, no line break (sudo reads one line). */
export function passwordOf(v) {
  if (typeof v !== 'string' || !v.length || v.length > 512 || /[\r\n\0]/.test(v)) throw fail(400, 'that password cannot be used here');
  return v;
}

/** The last lines of a program's output, for an error in the page. */
const tail = (s, n = 6) => String(s || '').trim().split('\n').slice(-n).join('\n');

/**
 * The services part. `os`: the OS part (platform/*-system.mjs); `io`: { run, stream, readFile }; `adminNeeded()`
 * → true when sudo would ask for a password; `root`: this server runs as root (no sudo at all); `plainLeg(req)`:
 * the request came from another dashboard over a leg that is not encrypted.
 */
export function servicesPart({ os, io, adminNeeded, root = false, plainLeg = () => false, callerOf = () => 'here', wrongPasswords = new RateLimiter({ perIp: 3, global: 6 }) }) {
  const S = os.services;
  const scopeOf = (v) => {
    const s = v === undefined || v === null || v === '' ? S.scopes[0] : v;
    if (!S.scopes.includes(s)) throw fail(400, `scope is one of: ${S.scopes.join(', ')}`);
    return s;
  };
  const SSH_WHY = 'Stopping SSH can cut this computer off: nobody can sign in to it over the network until it runs again.';
  const warnOf = (name) => (S.cutsOff ? S.cutsOff(name) : S.isSsh(name) ? SSH_WHY : null);
  const nameOf = (v) => {
    if (!S.nameOk(v)) throw fail(400, 'that is not a service name');
    return v;
  };

  async function list(scope) {
    const sc = scopeOf(scope);
    const own = S.own(io);
    const r = await S.list(io, sc);
    return {
      scope: sc,
      scopes: S.scopes,
      readOnly: S.readOnly,
      available: r.available,
      note: r.note,
      services: r.services.map((x) => ({ ...x, own: own.has(x.name), ssh: S.isSsh(x.name), critical: warnOf(x.name) !== null })),
    };
  }

  /** b: { scope, name, action, password?, confirm? }. Answers { ok, output } or a question (needsPassword, needsConfirm). */
  async function act(b, req) {
    const scope = scopeOf(b.scope);
    const name = nameOf(b.name);
    if (!ACTIONS.includes(b.action)) throw fail(400, `action is one of: ${ACTIONS.join(', ')}`);
    if (S.readOnly) throw fail(409, 'Services are read-only on this computer: change one in a terminal opened as administrator.');
    if (S.own(io).has(name)) throw fail(409, 'That is the service this dashboard runs in: changing it here would cut this page off. Use the terminal for it.');
    const why = b.action === 'start' ? null : warnOf(name);
    if (why && b.confirm !== name) return { needsConfirm: true, why };
    const argv = S.argv(scope, b.action, name);
    if (argv[0] !== 'sudo') {
      const r = await io.run(argv[0], argv.slice(1), { timeout: 60_000 });
      if (!r.ok) throw fail(409, tail(r.stderr || r.stdout) || `${b.action} failed`);
      return { ok: true, output: tail(r.stdout) };
    }
    // The system's services: as root without sudo; else sudo, with the password when it asks for one.
    if (root) return done(await io.stream(argv.slice(1), { input: null }), null, b.action);
    const plain = plainLeg(req);
    if (plain && b.password !== undefined) return { needsPassword: true, plainLeg: true };
    let password = null;
    if (await adminNeeded()) {
      if (b.password === undefined) return plain ? { needsPassword: true, plainLeg: true } : { needsPassword: true };
      password = passwordOf(b.password);
      const who = callerOf(req);
      const wait = wrongPasswords.retryAfter(who);
      if (wait) throw fail(429, `Several wrong passwords in a short time: try again in ${Math.ceil(wait / 60_000)} min, so the computer does not lock your account.`);
      const c = await checkPassword(password, io.stream);
      if (!c.ok) {
        if (!c.notAllowed) wrongPasswords.fail(who);
        return { needsPassword: true, wrong: !c.notAllowed, notAllowed: c.notAllowed };
      }
    }
    const r = await io.stream(asAdmin(argv, Boolean(password)), { input: password ? `${password}\n` : null, env: { ...process.env, LC_ALL: 'C' } });
    return done(r, password, b.action);
  }

  function done(r, password, action) {
    const clean = scrubber(password);
    const output = clean(r.output || '');
    if (!r.ok) throw fail(409, tail(output) || `${action} failed`);
    return { ok: true, output: tail(output) };
  }

  async function logs(scope, name, lines) {
    return S.logs(io, scopeOf(scope), nameOf(name), lines);
  }

  return { list, act, logs };
}
