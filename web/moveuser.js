// Settings → Runs as root → Move Hoprig to an ordinary user (GET/POST /api/move, src/setup/moveroutes.mjs): the look
// (the user, what runs, what would be copied, the steps that run as administrator), one confirmation that names this
// server, then the move's lines as they come. Root's dashboard stops during the switch: the page keeps asking, and the
// user's dashboard on the same port answers with the same lines once it is up (the same password signs in).
import { add, api, btn, fill, h, promptSheet } from './lib.js';

const size = (b) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(b) || 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i += 1; }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${u[i]}`;
};
/** A step's words with each flag (--no-admin) kept whole on one line: a browser breaks at its hyphen. */
const withFlags = (t) => String(t).split(/(--[a-z][a-z-]*)/).map((x, i) => (i % 2 ? h('code.move-flag', x) : x));
const showArgv = (a) => a.map((x) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`)).join(' ');

/** The look as parts of the page. */
export function lookParts(plan) {
  if (!plan.user) return [h('p.banner.warn', h('span', plan.stops.join(' ')))];
  const r = plan.running;
  const terms = r.terminals.map((t) => t.session);
  return [
    plan.make
      ? h('p', `Hoprig moves from root to a new user `, h('b', plan.user.name), `, made by the move first (home ${plan.user.home}): an ordinary user with sudo and the key you use for root. Root's own login is not changed.`)
      : h('p', `Hoprig moves from root to the user `, h('b', plan.user.name), ` (home ${plan.user.home}).`),
    plan.again ? h('p.hint', plan.again.switchedAt || plan.again.used
      ? `An earlier move to ${plan.user.name} switched already: its copy is set aside beside it and made again from root's.`
      : `An earlier move to ${plan.user.name} began a copy and did not switch: that copy is taken away first and made again.`) : null,
    h('h4.move-h', 'What runs now'),
    h('ul.move-list',
      h('li', `Sessions working: ${r.working.length ? r.working.join(', ') : 'none'}`),
      h('li', `Terminals of root: ${terms.length ? `${terms.join(', ')} (ended after the switch, each by its own socket and session)` : 'none'}`),
      h('li', `Work: ${r.work ? `${r.work} running` : 'nothing running'}. Tia: ${r.assistant ? `${r.assistant} working` : 'nothing working'}.`)),
    h('h4.move-h', 'What is copied (root\'s copy stays as it is)'),
    h('ul.move-list', plan.parts.map((p) => h('li', h('span', `${p.what}: `), h('span.move-path', p.from), ` → `, h('span.move-path', p.to), `, ${p.entries} ${p.entries === 1 ? 'entry' : 'entries'}, ${size(p.bytes)}`))),
    h('p.hint', `In all ${plan.total.entries} ${plan.total.entries === 1 ? 'entry' : 'entries'}, ${size(plan.total.bytes)}. Free on ${plan.user.name}'s disk: ${plan.free === null ? 'unknown' : size(plan.free)}.`),
    h('h4.move-h', 'Steps that run as administrator'),
    h('ul.move-list', plan.admin.map((s) => h('li', ...withFlags(s.why), s.argv ? h('code.move-cmd', showArgv(s.argv)) : null))),
    // The user's own install needs the network: said before the yes, as the command line's look says it.
    plan.network ? h('p.hint', plan.network.line) : null,
    plan.stops.length ? h('div.banner.warn', { role: 'alert' }, h('span', plan.stops.join(' '))) : null,
  ];
}

/** His choice of administrator rights for a user the move makes, in plain words: { row, none() }. */
export function adminChoice() {
  const sel = h('select.field', { 'aria-label': 'Administrator rights for the user' },
    h('option', { value: 'sudo' }, 'sudo without a password, as cloud servers give their first user'),
    h('option', { value: 'none' }, 'no administrator rights'));
  return { row: h('label.field-row.move-admin', h('span.field-label', 'Administrator rights for the user'), sel), none: () => sel.value === 'none' };
}

/** The job's lines and its end: the lines as they came, then what it came to. No result yet is still running. */
export function jobParts(job, out) {
  out.textContent = job.lines.join('\n');
  out.hidden = !job.lines.length;
  // After the caller has put the box in the page: before that it has no height to scroll.
  queueMicrotask(() => (out.scrollTop = out.scrollHeight));
  // No result yet is still running (the process may not have written its first line).
  if (job.running || !job.result) return [h('p.hint', { 'aria-live': 'polite' }, 'The move runs. Root\'s dashboard stops for about half a minute during the switch: this page goes on by itself.'), out];
  if (job.result && job.result.ok) {
    return [out, h('div.banner.ok-box', { role: 'status' }, h('span', 'Hoprig runs as the ordinary user now. Root\'s copy is kept where it was; removing it is a later step of its own. Sign in with the same password if the page asks.'))];
  }
  return [out, h('div.banner.error-box', { role: 'alert' }, h('span', 'The move stopped. The lines above say where, what was made and how to take it away. Root\'s installation was left working.'))];
}

/** The part of the page: a button, then the look and the move from GET /api/move. */
export function moveBox() {
  const box = h('div.move-box');
  const out = h('pre.output.move-out', { 'aria-live': 'polite', tabindex: '0', hidden: true });
  let timer = null;
  let shown = 0;
  let waited = 0;
  const follow = async () => {
    clearTimeout(timer);
    let job = null;
    try {
      job = await api('/api/move/job');
      shown = 0;
    } catch {
      // Root's dashboard is stopping or the user's is starting: ask again in a moment.
      if (shown++ < 120) timer = setTimeout(follow, 2000);
      return;
    }
    fill(box, ...jobParts(job, out));
    // Running, or no result yet: ask again (bounded, about ten minutes without a result; the server ends a lost job).
    if (job.running || (!job.result && waited++ < 400)) timer = setTimeout(follow, 1500);
  };
  const draw = async () => {
    let v;
    try {
      v = await api('/api/move');
    } catch (e) {
      fill(box, h('p.form-error', e.message));
      return;
    }
    if (v.job && (v.job.running || v.job.result)) {
      fill(box, ...jobParts({ running: v.job.running, lines: v.job.lines, result: v.job.result }, out));
      if (v.job.running) follow();
      if (!v.job.running && v.plan) add(box, h('div.move-again', ...startParts(v)));
      return;
    }
    if (!v.plan) return fill(box);
    fill(box, ...startParts(v));
  };
  const admin = adminChoice();
  const startParts = (v) => [
    ...lookParts(v.plan),
    v.plan.make ? admin.row : null,
    h('div.move-actions',
      btn('primary', {
        icon: 'user', label: `Move to ${v.plan.user ? v.plan.user.name : 'an ordinary user'}`, disabled: !v.plan.ok,
        onclick: async () => {
          const typed = await promptSheet({
            title: `Move Hoprig on ${v.server} to ${v.plan.user.name}?`,
            text: `Root's dashboard stops for about half a minute while ${v.plan.user.name}'s starts. Root's copy is kept. Type the name of this server, ${v.server}, to go on.`,
            ok: 'Move it', label: 'The name of this server', check: (x) => (x.trim() === v.server ? '' : `Type ${v.server} as it is written`),
          });
          if (typed === null) return;
          try {
            await api('/api/move', { confirm: typed.trim(), noAdmin: v.plan.make && admin.none() });
          } catch (e) {
            add(box, h('p.form-error', { role: 'alert' }, e.message));
            return;
          }
          waited = 0;
          fill(box, ...jobParts({ running: true, lines: [], result: null }, out));
          follow();
        },
      })),
  ];
  // The look counts every entry of what would be copied: it runs when he asks, not at every open of Settings.
  fill(box, btn('secondary', { icon: 'search', label: 'Show what the move does', onclick: () => {
    fill(box, h('p.hint', { 'aria-live': 'polite' }, 'Looking: the user, what runs, and what would be copied…'));
    draw();
  } }));
  return box;
}

/**
 * The hub's page for a computer it reaches by SSH (GET/POST /api/machines/<name>/move, src/machines/movehub.mjs): the
 * look there on a press, one confirmation that names the computer, then the move's lines. The hub's login there
 * changes to the user only after a login as that user worked; the last line says which.
 */
export function hubMoveBox(name, label) {
  const box = h('div.move-box');
  const out = h('pre.output.move-out', { 'aria-live': 'polite', tabindex: '0', hidden: true });
  const base = `~/api/machines/${encodeURIComponent(name)}/move`;
  const follow = async () => {
    let j;
    try {
      j = await api(`${base}/job`);
    } catch (e) {
      add(box, h('p.form-error', { role: 'alert' }, e.message));
      return;
    }
    const r = j.result;
    // Not running and no result: the press it followed stopped at its look (no move started), so the look is shown again.
    if (!j.running && !r) return look();
    const end = j.running ? h('p.hint', { 'aria-live': 'polite' }, `The move runs on ${label}.`)
      : r && r.ok && r.switched ? h('div.banner.ok-box', { role: 'status' }, h('span', `Done. This main computer now reaches ${label} as ${r.target}.`))
        : r && r.ok ? h('div.banner.warn', { role: 'status' }, h('span', `The move on ${label} is done, but this main computer still uses the old login there: the last line says why.`))
          : h('div.banner.error-box', { role: 'alert' }, h('span', `The move on ${label} stopped. The lines say where and what to take away; its installation was left working.`));
    out.textContent = j.lines.join('\n');
    out.hidden = !j.lines.length;
    fill(box, out, end);
    out.scrollTop = out.scrollHeight;
    if (j.running) setTimeout(follow, 1500);
  };
  // A move that runs there already (started in another tab, or by a press a moment ago) is followed: its lines and
  // its end, never the look with a button that would only be refused. → true when one runs.
  const followRunning = async () => {
    try {
      if (!(await api(`${base}/job`)).running) return false;
    } catch {
      return false; // the press or the look says what is wrong
    }
    follow();
    return true;
  };
  const look = async () => {
    if (await followRunning()) return;
    fill(box, h('p.hint', { 'aria-live': 'polite' }, `Asking ${label} what the move would do…`));
    let v;
    try {
      v = await api(base);
    } catch (e) {
      return fill(box, h('p.form-error', { role: 'alert' }, e.message));
    }
    if (!v.plan) return fill(box, h('p.banner.warn', h('span', v.error)));
    const admin = adminChoice();
    fill(box, ...lookParts(v.plan), v.plan.make ? admin.row : null, h('div.move-actions', btn('primary', {
      icon: 'user', label: `Move to ${v.plan.user ? v.plan.user.name : 'an ordinary user'}`, disabled: !v.plan.ok,
      onclick: async () => {
        const typed = await promptSheet({
          title: `Move Hoprig on ${label} to ${v.plan.user.name}?`,
          text: `${label}'s dashboard stops for about half a minute while ${v.plan.user.name}'s starts. Root's copy there is kept. Type ${name} to go on.`,
          ok: 'Move it', label: 'The name of the computer', check: (x) => (x.trim() === name ? '' : `Type ${name} as it is written`),
        });
        if (typed === null) return;
        try {
          await api(base, { confirm: name, noAdmin: v.plan.make && admin.none() });
        } catch (e) {
          if (e.status === 409 && (await followRunning())) return;
          add(box, h('p.form-error', { role: 'alert' }, e.message));
          return;
        }
        follow();
      },
    })));
  };
  fill(box, btn('secondary', { icon: 'search', label: 'Show what the move does', onclick: look }));
  followRunning();
  return box;
}
