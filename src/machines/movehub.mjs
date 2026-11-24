// The hub's page for a computer it reaches by SSH, where Hoprig works as root: the move to an ordinary user there
// (src/setup/movecli.mjs) run over that SSH login as a job, with its lines.
//   look(name)          `hoprig move-to-user --dry-run --json` there → the look (the user, what runs, what is copied)
//   start(name)         `hoprig move-to-user --yes` there, its lines into the job; then a REAL login as the user
//                       (`ssh <user>@<host> hoprig version`). Only when that worked is the hub's entry switched to
//                       `<user>@<host>`, and the page says so; otherwise the entry stays as it was, and the line says why.
//   status(name, from)  { running, lines, next, result }
// The routes (index.mjs) are under /api/machines: never a computer token, never Tia's door, and with a confirmation
// that names the computer.
import { runHoprig, findJson } from './ssh.mjs';
import { getMachine, loadMachines, saveMachines } from './store.mjs';
import { USER_NAME_RE } from '../setup/rootfacts.mjs';

/** `user@host` (or `host`, `ssh://user@host:port`) with its login name changed to `user`. */
export function withUser(target, user) {
  const t = String(target || '');
  const m = /^(ssh:\/\/)?(?:[^@/]+@)?(.+)$/.exec(t);
  return m ? `${m[1] || ''}${user}@${m[2]}` : null;
}

class MoveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** o: { ssh (runSsh's options), extraOf(machine) → ssh options, run (runHoprig, tests), onSwitched(old, now) } */
export function createHubMove({ ssh = {}, extraOf = () => [], run = runHoprig, onSwitched = () => {} } = {}) {
  const jobs = new Map(); // name → { running, lines, result, user }
  const claimed = new Set(); // names whose press still looks: a second press at once is refused, not a second move
  const sshMachine = (name) => {
    const m = getMachine(name);
    if (!m) throw new MoveError(404, 'no such computer');
    if (m.via !== 'ssh') throw new MoveError(409, `${m.label || m.name} was not added by SSH: run hoprig move-to-user on it in its own terminal or page`);
    return m;
  };
  const opts = (m, more = {}) => ({ ...ssh, sshExtra: extraOf(m), ...more });

  async function look(name) {
    const m = sshMachine(name);
    const r = await run(m.target, ['move-to-user', '--dry-run', '--json'], opts(m, { timeoutMs: 120_000 }));
    // A look that stops exits 1 and still prints its JSON.
    const plan = r.ok ? findJson(r.result.stdout, 'move-plan') : null;
    if (!plan) return { plan: null, error: r.message || 'the computer gave no look (an older Hoprig there has no move-to-user: hoprig update there first)' };
    return { plan, error: null };
  }

  async function start(name, { noAdmin = false } = {}) {
    const m = sshMachine(name);
    if (claimed.has(name) || jobs.get(name)?.running) throw new MoveError(409, 'the move there is running already');
    // Claimed before the first await (as moveroutes.mjs does); a look that fails lets the claim go.
    claimed.add(name);
    let user;
    let fresh;
    let job;
    try {
      const l = await look(name);
      if (!l.plan) throw new MoveError(409, l.error);
      if (!l.plan.ok) throw new MoveError(409, l.plan.stops.join(' '));
      user = l.plan.user?.name;
      fresh = l.plan.make === true;
      if (!USER_NAME_RE.test(String(user || ''))) throw new MoveError(409, 'the look named no user to move to');
      job = { running: true, lines: [], result: null, user };
      jobs.set(name, job);
    } finally {
      claimed.delete(name);
    }
    const say = (x) => {
      job.lines.push(String(x).slice(0, 500));
      if (job.lines.length > 5000) job.lines.splice(0, job.lines.length - 5000);
    };
    (async () => {
      // The user the look named, by name: the user this hub logs in as next is the one the move there made or moved
      // to, never another the move picked on its own. When the look said the move makes that user, --new: a user of
      // that name that appeared there since, and that Hoprig did not make, stops the move instead of being moved into.
      const r = await run(m.target, ['move-to-user', '--yes', '--user', user, ...(fresh ? ['--new'] : []), ...(noAdmin === true ? ['--no-admin'] : [])], opts(m, { timeoutMs: 30 * 60_000, onLine: say }));
      if (!r.ok) {
        say(`The move on ${m.label || m.name} did not finish (${r.message || 'it failed'}). Its entry on this main computer stays as it was.`);
        job.result = { ok: false, switched: false };
        return;
      }
      // The hub reaches it as the user only after a real login as that user worked.
      const next = withUser(m.target, user);
      const t = await run(next, ['version'], opts(m, { timeoutMs: 30_000 }));
      if (!t.ok) {
        say(`A login as ${next} did not work (${t.message || 'no answer'}), so this main computer still reaches ${m.label || m.name} as ${m.target}. The move itself is done there: do not run it again. Add your SSH key to ${user}'s ~/.ssh/authorized_keys there, then remove ${m.label || m.name} on this main computer and add it again as ${next}.`);
        job.result = { ok: true, switched: false };
        return;
      }
      const list = loadMachines();
      const cur = list.find((x) => x.name === m.name && x.target === m.target);
      if (cur) {
        cur.target = next;
        saveMachines(list);
        onSwitched(m.name);
      }
      say(`A login as ${next} worked: this main computer now reaches ${m.label || m.name} as ${next}.`);
      job.result = { ok: true, switched: true, target: next };
    })()
      .catch((e) => {
        say(`The move stopped: ${e.message}`);
        job.result = { ok: false, switched: false };
      })
      .finally(() => (job.running = false));
    return { started: true, user };
  }

  const status = (name, from = 0) => {
    // A press that still looks there has claimed the computer: a move is starting, so it reads as running (no lines
    // yet), and a page that was refused follows it instead of offering the look again.
    if (claimed.has(name) && !jobs.get(name)?.running) return { running: true, lines: [], next: 0, result: null };
    const j = jobs.get(name) || { running: false, lines: [], result: null };
    return { running: j.running, lines: j.lines.slice(from), next: j.lines.length, result: j.result };
  };
  return { look, start, status, MoveError };
}
