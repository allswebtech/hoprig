// The presses that manage the gateway Hoprig sets up itself, as TRouteAI's own page uses them (#/providers/trouteai,
// web/trouteaipage.js): Start, Stop, Restart, Start at boot, Update, Remove, the Log, the Password. The same routes as
// Computer → Health → Gateways (src/addons/gatewayhost.mjs and the add-on jobs); only the place is new. Every press asks
// first, names the computer in its confirmation, sends `confirm` with the computer's name and writes what it did under
// the row it was pressed on (`out`). `ctx`: { g (the gateway's row of GET /api/gatewayhost), computer, out, reload }.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { add, api, btn, confirmSheet, fill, h, openSheet, promptSheet } from './lib.js';
import { errorBox, okBox } from './shell.js';
import { busy, cmdLine } from './joinlink.js';

/** What a press did, in its own lines ("Stopped TRouteAI's service. …"), else `plain`. */
export const said = (r, plain) => (r && Array.isArray(r.lines) && r.lines.length ? `${r.lines.join('. ')}.` : plain);

/** A start's first lines, shown once (a first password among them): never again after this page shows them. */
export function firstBox(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  return h('div.cp-first', h('p.hint', 'What it printed as it started, shown this once: copy a first password now. Hoprig keeps none of it.'), h('pre.output', lines.join('\n')));
}

/** The shortest password Hoprig sets for the gateway: the same as its own public link asks for. */
export const PASSWORD_MIN = 12;

const base = (ctx) => `/api/gatewayhost/${ctx.g.id}`;

/** One confirmed press: asks, sends, shows what happened, and draws the page again. */
async function press(ctx, { title, text, ok, path, body = {}, done }) {
  if (!(await confirmSheet({ title, text, ok: ok || title.replace(/\?$/, '') }))) return;
  fill(ctx.out, busy('Working on it…'));
  try {
    const r = await api(path, { ...body, confirm: ctx.computer });
    fill(ctx.out, done(r), firstBox(r.first));
  } catch (e) {
    return fill(ctx.out, errorBox(e), firstBox(e.data && e.data.first));
  }
  ctx.reload();
}

export const startIt = (ctx) => press(ctx, {
  title: `Start ${ctx.g.title} on ${ctx.computer}?`,
  text: `On port ${ctx.g.port}. Hoprig asks it to listen on ${ctx.computer} only (127.0.0.1).${ctx.g.marksFirst ? ' What it prints first is shown here once, and its first password is kept out of its log.' : ` What it prints goes to its log on ${ctx.computer}.`}`,
  path: `${base(ctx)}/start`,
  done: (r) => okBox(said(r, `${ctx.g.title} runs.`)),
});

export const stopIt = (ctx) => press(ctx, {
  title: `Stop ${ctx.g.title} on ${ctx.computer}?`,
  text: ctx.g.service.made ? 'It is stopped now; its service starts it again after a restart.' : 'Sessions that use it stop working until it runs again.',
  path: `${base(ctx)}/stop`,
  done: (r) => okBox(said(r, `${ctx.g.title} stopped.`)),
});

export const restartIt = (ctx) => press(ctx, {
  title: `Restart ${ctx.g.title} on ${ctx.computer}?`,
  text: 'It is stopped and started again, for a setting you changed in its own page. Sessions that use it wait a moment.',
  path: `${base(ctx)}/restart`,
  done: (r) => okBox(said(r, `${ctx.g.title} restarted.`)),
});

/** "Show what it printed first" after a start made elsewhere. */
export const showFirst = (ctx) => press(ctx, {
  title: `Show what ${ctx.g.title} printed first on ${ctx.computer}?`,
  text: 'It is shown this once, then Hoprig forgets it.',
  path: `${base(ctx)}/first`,
  done: () => null,
});

/** Update and Remove are the add-ons' own jobs: their lines show as they come. */
export async function addonJob(ctx, action, title, text, ok) {
  if (!(await confirmSheet({ title, text, ok, danger: action === 'remove' }))) return;
  const out = h('pre.output', { 'aria-live': 'polite' });
  fill(ctx.out, busy(`${{ update: 'Updating', remove: 'Removing' }[action] || 'Installing'} ${ctx.g.title}…`), out);
  try {
    await api(`/api/addons/${ctx.g.id}/${action}`, { confirm: ctx.computer });
    let from = 0;
    for (;;) {
      const j = await api(`/api/addons/${ctx.g.id}/job?from=${from}`);
      if (j.lines.length) add(out, `${j.lines.join('\n')}\n`);
      from = j.next;
      if (!j.running) {
        if (j.result && !j.result.ok) throw new Error(j.result.error || `${ctx.g.title} could not ${action}`);
        break;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    ctx.reload();
  } catch (e) {
    add(ctx.out, errorBox(e));
  }
}

export const updateIt = (ctx) => addonJob(ctx, 'update', `Update ${ctx.g.title} on ${ctx.computer}?`,
  `${ctx.g.copy === 'global' ? `${ctx.g.title} runs from a copy installed with npm there. The newest version is put into ${APP_NAME}'s own folder and started in its place if it runs; the npm copy is left as it was.` : `${ctx.g.title} is updated to the newest version with npm there, and started again if it runs.`} Its lines show here as they come.`,
  `Update on ${ctx.computer}`);

export const removeIt = (ctx) => addonJob(ctx, 'remove', `Remove ${ctx.g.title} from ${ctx.computer}?`,
  `It is stopped and its copy in ${APP_NAME}'s own folder is taken away. Its data (your providers and keys) and the provider ${ctx.g.title} made are kept, so a later Set up finds them.`,
  `Remove from ${ctx.computer}`);

export async function showLog(ctx) {
  fill(ctx.out, busy('Reading the log…'));
  try {
    const r = await api(`${base(ctx)}/log`);
    fill(ctx.out,
      r.lines.length ? h('pre.output', r.lines.join('\n')) : h('p.hint', 'The log is empty: nothing has been written yet.'),
      r.left ? h('p.hint', `${r.left} ${r.left === 1 ? 'line was' : 'lines were'} left out because they may hold a password or a key.`) : null);
  } catch (e) {
    fill(ctx.out, errorBox(e));
  }
}

export async function passwordSheet(ctx) {
  let where;
  try {
    where = await api(`${base(ctx)}/password`);
  } catch (e) {
    return fill(ctx.out, errorBox(e));
  }
  const say = where.exists
    ? `${ctx.g.title}'s first password is in the file ${where.file} on ${ctx.computer}.`
    : `${ctx.g.title}'s first password file is not there any more: you have set your own, or it was removed.`;
  const pw = await promptSheet({ title: `Set a new password for ${ctx.g.title}?`, text: `${say} At least ${PASSWORD_MIN} characters. Every browser signed in to ${ctx.g.title} is signed out. ${APP_NAME} does not keep it.`, ok: 'Set a new password', type: 'password', check: (v) => (v.length >= PASSWORD_MIN && v.length <= 200 ? '' : `At least ${PASSWORD_MIN} characters`) });
  if (!pw) return;
  try {
    const r = await api(`${base(ctx)}/password`, { password: pw, confirm: ctx.computer });
    fill(ctx.out, okBox(r.line));
    ctx.reload();
  } catch (e) {
    fill(ctx.out, errorBox(e));
  }
}

/** Start at boot: the file it writes is shown first. On: made; off: removed. */
export async function bootSheet(ctx) {
  const { g, computer } = ctx;
  const on = !g.service.made;
  let plan;
  try {
    plan = await api(`${base(ctx)}/service`);
  } catch (e) {
    return fill(ctx.out, errorBox(e));
  }
  const yes = await openSheet({ title: on ? `Start ${g.title} at boot on ${computer}?` : `Stop starting ${g.title} at boot on ${computer}?`, wide: true }, (close) => [
    h('p.sheet-text', on ? `${g.running ? `${g.title} is stopped now and started again as a service. ` : ''}It then starts by itself after a restart of ${computer}. This file is written there:` : 'It is stopped and this file is removed:'),
    h('code.cp-unitpath', plan.file),
    on ? h('pre.output.cp-unit', plan.text) : null,
    h('p.sheet-text', on ? 'Then these run there:' : 'Then:'),
    h('pre.output.cp-unit', (on ? plan.commands : [`stop and disable it, remove ${plan.file}`]).join('\n')),
    h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: () => close(true) }, on ? 'Turn on' : 'Turn off')),
  ]);
  if (yes !== true) return;
  fill(ctx.out, busy('Working on it…'));
  try {
    const r = await api(`${base(ctx)}/service`, { on, confirm: computer });
    fill(ctx.out, okBox(on ? `${g.title} starts at boot on ${computer}.` : `${g.title} no longer starts at boot.`), h('pre.output', r.lines.join('\n')));
  } catch (e) {
    fill(ctx.out, errorBox(e));
  }
  ctx.reload();
}

/** Services of this computer start only after a login: say so, with the one press that fixes it (or the line to type). */
export function lingerLine(d, out, reload) {
  if (d.linger !== 'off') return null;
  return h('p.banner.warn', icon('alert', { size: 18 }), h('span', `Services of ${d.computer} start only after you log in there, not after a restart.`),
    btn('small secondary', { label: 'Let them start after a restart', onclick: async () => {
      if (!(await confirmSheet({ title: `Let services of ${d.computer} start after a restart?`, text: `This needs administrator rights there. It runs: ${d.lingerCommand}`, ok: `Run it on ${d.computer}` }))) return;
      try {
        const r = await api('/api/gatewayhost/linger', { confirm: d.computer });
        if (r.ok) fill(out, okBox(`Services of ${d.computer} now start after a restart.`));
        else fill(out, errorBox(`sudo on ${d.computer} asks for a password, which this page never takes. Type this once in a terminal on ${d.computer}:`), cmdLine(r.command));
      } catch (e) {
        return fill(out, errorBox(e));
      }
      reload();
    } }));
}
