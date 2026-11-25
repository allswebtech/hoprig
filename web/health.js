// One computer's Health part (#/computer/health, #/m/<computer>/computer/health): its checks (the doctor's) with a Fix
// on each line that has one, Hoprig's and the coding tools' versions, its service, where it listens, load, memory and
// disks, and its gateways: install, start, stop, run as a service, open its page. Read when the part opens or Refresh
// is pressed, never on a timer. Another computer's health comes through this dashboard's own link to it
// (~/api/machines/<name>/health); one that does not answer says since when, never that it is fine.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { MACHINE_STATE, add, ago, api, btn, bytes, confirmSheet, fill, h, link, machine, openSheet, toast, wayLink } from './lib.js';
import { errorBox, groupHead, okBox } from './shell.js';
import { startSetup } from './setupjob.js';
import { busy, cmdLine } from './joinlink.js';
import { claudeLoginButton } from './claudelogin.js';

const MARK = { ok: 'check', fail: 'x', warn: 'alert', info: 'info' };
// The parts of the page a check names as the place it is done (src/machines/health.mjs ASKED and DONE_ON).
const PLACES = { 'Setup → Git and GitHub': '#/computer/setup', 'Settings → Runs as root': '#/settings/root', Providers: '#/providers', Skills: '#/skills' };
// Why a line with administrator rights is his to type: the page never takes the computer's password.
export const ADMIN_WHY = 'It needs administrator rights, so the computer asks for your password, which only you type.';
export const ENTER_HINT = 'Press Enter in the terminal to run it.';
const row = (ic, title, sub, end = null) => h('div.row.static', h('span.row-icon', icon(ic)), h('span.row-main', h('span.row-title', title), sub ? h('span.row-sub', sub) : null), end);
const local = () => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);
/**
 * The host name of a plain link to a gateway on this computer (it listens on 127.0.0.1): never the page's own, so the
 * dashboard's sign-in cookie (kept per host name, not per port) is never sent to the gateway and it is another site.
 * The same rule as src/machines/forward.mjs otherLoopback.
 */
export const otherLoopback = (pageHost) => (['localhost', '[::1]', '::1'].includes(String(pageHost || '').toLowerCase()) ? '127.0.0.1' : 'localhost');

/**
 * The host name of a plain link to a gateway on this computer: a loopback name the page is not on and the owner is not
 * signed in under (`signedIn`), since a browser sends a name's cookie to every port of it. Null when there is none.
 */
export function plainHost(pageHost, signedIn = []) {
  const own = String(pageHost || '').toLowerCase();
  return ['localhost', '127.0.0.1'].find((n) => n !== own && !signedIn.includes(n)) || null;
}

/** The one sentence for a computer linked without SSH: why its page cannot be opened from here, and where. */
export const noForwardWords = (title, label, port) => `${title}'s page cannot be opened from here, because ${label} is linked to this dashboard without SSH and so this dashboard has no way to reach that page: open it in a browser on ${label} itself, at http://127.0.0.1:${port}/.`;

/** "Load 0.4 of 4 processors · Memory 2.1 GB of 8 GB used · / 20 GB of 100 GB used": the figures as one line each. */
export function figures(hl) {
  const out = [];
  if (hl.load && Number.isFinite(hl.load[0]) && hl.cpus) out.push(['Load', `${hl.load[0].toFixed(2)} on ${hl.cpus} processor${hl.cpus === 1 ? '' : 's'} (the last minute)`]);
  if (hl.memory && hl.memory.total) out.push(['Memory', `${bytes(hl.memory.total - hl.memory.available)} of ${bytes(hl.memory.total)} used`]);
  for (const d of hl.disks || []) out.push([d.mount === '/' ? 'Main disk' : `Disk ${d.mount}`, `${bytes(d.used)} of ${bytes(d.size)} used, ${bytes(d.avail)} free`]);
  return out;
}

/** What a Fix's confirmation says: whether it needs administrator rights there, and the commands it runs. */
export function fixText(c, computer) {
  const runs = c.commands && c.commands.length ? c.commands.join(' · ') : c.fix || 'the setup of that part';
  return `${c.admin ? `This needs administrator rights on ${computer}. ` : ''}It runs on ${computer}: ${runs}`;
}

/** What a gateway's press did, in its own lines ("Stopped Relay's service. Stopped the copy …"), else `plain`. */
export const said = (r, plain) => (r && Array.isArray(r.lines) && r.lines.length ? `${r.lines.join('. ')}.` : plain);

/** A start's first lines, shown once (a first password among them): never again after this page shows them. */
export function firstBox(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  return h('div.cp-first', h('p.hint', 'What it printed as it started, shown this once: copy a first password now. Hoprig keeps none of it.'), h('pre.output', lines.join('\n')));
}

/** The words for a computer that did not answer: since when, or never. */
export const notReached = (label, seenAt) => (seenAt ? `${label} was not reached since ${new Date(seenAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (${ago(seenAt)}).` : `${label} was never reached from here.`);

/**
 * The red box and the line under the reason when another computer's health could not be read ({ state, seenAt } of
 * ~/api/machines/<name>/health). A computer that answers but no longer lets this dashboard in is named by its state, as
 * the Computers list names it: it was reached, so "never reached" and "until it answers" would be untrue.
 */
export function unreachedWords(r, label) {
  if (r.state === 'unauthorised') {
    return { head: `${label}: ${MACHINE_STATE.unauthorised}.`, hint: 'Nothing here is shown as fine while it does not let this dashboard in. Do what the line above says, then press Refresh.', way: wayLink({ code: 'computer-not-allowed' }) };
  }
  return {
    head: notReached(label, r.seenAt),
    hint: r.state === 'hostkey'
      ? 'Nothing is sent to it until you choose: Advanced → Its host key shows both prints and lets you keep the new one.'
      : !r.state || r.state === 'offline'
        ? 'Nothing here is shown as fine until it answers. Check that it is on and online, then press Refresh.'
        : 'Nothing here is shown as fine until it answers. Do what the line above says, then press Refresh.',
  };
}

export function healthSection(ctx) {
  const name = machine.current;
  const top = h('div', { role: 'status' }, busy('Asking for its health…'));
  const gwBox = h('div');
  // The answer to the last press stays while the list under it is drawn again.
  const msg = h('div', { role: 'status' });
  const refresh = btn('secondary small', { icon: 'refresh', label: 'Refresh', onclick: () => load() });
  let computerName = null; // the name that computer gives itself (its health answer): a Fix's confirmation sends it
  let signedIn = []; // the loopback names the owner is signed in under here (GET /api/gatewayhost)

  // Health's "Open a terminal with this line": only the check's id goes; that computer types its own line, no Enter.
  async function lineTerminal(c) {
    try {
      const r = await api('/api/health/line', { id: c.id, confirm: computerName });
      location.hash = link(`#/s/${encodeURIComponent(r.session)}`);
      toast(ENTER_HINT, { ms: 8000 });
    } catch (e) {
      fill(msg, errorBox(e));
    }
  }

  // What a check that is not fine offers: a press where the page does it, else its line (and for a line that needs
  // administrator rights, why, and a terminal with the line typed in it where that computer can open one).
  function fixOf(c, line) {
    if (c.where) return h('a.btn.small.secondary', { href: link(PLACES[c.where] || '#/computer/setup') }, `Set it under ${c.where}`);
    if (c.fixId) return btn('small primary', { label: 'Fix', onclick: () => fix(c) });
    const signIn = c.action === 'claude-login' ? claudeLoginButton(() => load()) : null;
    if (signIn) return signIn;
    if (!c.fix) return null;
    if (!c.admin) return h('div.cp-fixline', h('span.hint', `Type this in a terminal on ${ctx.label()}:`), cmdLine(c.fix));
    return h('div.cp-fixline',
      h('span.hint', `${ADMIN_WHY} ${line ? 'Open a terminal with this line, then press Enter there:' : `Open a terminal on ${ctx.label()} and type this line:`}`),
      cmdLine(c.fix),
      line ? h('div', btn('small secondary', { icon: 'terminal', label: 'Open a terminal with this line', onclick: () => lineTerminal(c) })) : null);
  }

  async function fix(c) {
    // Always asked first, with what it runs there (its kit's plan, as that computer read it).
    if (!(await confirmSheet({ title: `Fix "${c.label}" on ${ctx.label()}?`, text: fixText(c, ctx.label()), ok: `Run it on ${ctx.label()}` }))) return;
    if (!(await startSetup('/api/pcsetup/fix', { id: c.fixId, confirm: computerName }))) return;
    fill(msg, busy(`The fix runs on ${ctx.label()}…`));
    // When the job ends: its last line here, and Health read again, so the line shows what is true now.
    let j = null;
    for (let i = 0; i < 900; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      j = await api('/api/pcsetup/job').catch(() => null);
      if (!j || !j.running) break;
    }
    const last = j && j.lines && j.lines.length ? j.lines[j.lines.length - 1] : null;
    fill(msg, j && j.result && j.result.ok ? okBox(`The fix ended on ${ctx.label()}.${last ? ` ${last}` : ''}`) : errorBox(`The fix did not end well on ${ctx.label()}.${last ? ` ${last}` : ''} Its lines are under Setup.`));
    load();
  }

  function checks(all, line = false) {
    // The service is shown once, at the top ("Runs as a service"), not again as a check.
    const list = all.filter((c) => c.id !== 'service');
    const bad = list.filter((c) => c.status === 'fail' || c.status === 'warn');
    const fine = list.length - bad.length;
    return [
      groupHead('Checks', list.length),
      bad.length ? null : okBox(`All ${list.length} checks are fine.`),
      // A check's reason wraps: cut to one line it hid what to do (the root line at desktop width).
      h('div.rows.check-rows', bad.map((c) => row(MARK[c.status], c.label, c.detail, fixOf(c, line)))),
      bad.length && fine ? h('p.hint', `${fine} other check${fine === 1 ? ' is' : 's are'} fine.`) : null,
    ];
  }

  async function load() {
    refresh.disabled = true;
    fill(top, busy('Asking for its health…'));
    let r;
    try {
      r = name ? await api(`~/api/machines/${name}/health`) : { reached: true, seenAt: Date.now(), health: await api('~/api/health') };
    } catch (e) {
      r = { reached: false, error: e.message, seenAt: null };
    }
    refresh.disabled = false;
    if (!r.reached) {
      // The hub's label for it, also while it is off; then the hub's reason, which says what to do for a computer that is
      // too old, no longer allows this one or has another host key. "On and online" is the advice only when it is off.
      const w = unreachedWords(r, r.label || ctx.label());
      fill(top, errorBox(w.head), r.error ? h('p.hint', r.error) : null, h('p.hint', w.hint), w.way ? h('div.savebar.start', w.way) : null);
      fill(gwBox);
      return;
    }
    const hl = r.health;
    computerName = hl.computer || null;
    const v = hl.versions;
    fill(top,
      h('p.hint', `As it said ${ago(r.seenAt)}.`),
      h('div.rows',
        row('cpu', 'Versions', [`${APP_NAME} ${v.hoprig || '?'}`, v.claude ? `Claude Code ${v.claude}` : 'Claude Code not installed', v.opencode ? `OpenCode ${v.opencode}` : null].filter(Boolean).join(' · ')),
        row(hl.service && hl.service.status === 'ok' ? 'check' : 'alert', 'Runs as a service', hl.service ? hl.service.detail : 'unknown'),
        hl.listens ? row('lock', 'Listens on', `${hl.listens.host}:${hl.listens.port}${hl.listens.host === '127.0.0.1' ? ' (this computer only)' : ''}`) : null,
        ...figures(hl).map(([k, val]) => row('monitor', k, val))),
      ...checks(hl.checks, hl.line === true));
    gateways();
  }

  async function gateways() {
    fill(gwBox, groupHead('Gateways'), busy('Looking at its gateways…'));
    let d;
    try {
      d = await api('/api/gatewayhost');
      signedIn = Array.isArray(d.signedIn) ? d.signedIn : [];
    } catch (e) {
      return fill(gwBox, groupHead('Gateways'), errorBox(e.status === 404 ? `The ${APP_NAME} on ${ctx.label()} is too old to show its gateways here. Update it there.` : e.message));
    }
    const press = async (title, text, path, body, done) => {
      if (!(await confirmSheet({ title, text, ok: title.replace(/\?$/, '') }))) return;
      fill(msg, busy('Working on it…'));
      try {
        const r = await api(path, { ...body, confirm: d.computer });
        fill(msg, done(r), firstBox(r.first));
      } catch (e) {
        return fill(msg, errorBox(e), firstBox(e.data && e.data.first));
      }
      gateways();
    };
    const lingerBox = d.linger === 'off' ? h('p.banner.warn', icon('alert', { size: 18 }), h('span', `Services of ${d.computer} start only after you log in there, not after a restart.`),
      btn('small secondary', { label: 'Let them start after a restart', onclick: async () => {
        if (!(await confirmSheet({ title: `Let services of ${d.computer} start after a restart?`, text: `This needs administrator rights there. It runs: ${d.lingerCommand}`, ok: `Run it on ${d.computer}` }))) return;
        try {
          const r = await api('/api/gatewayhost/linger', { confirm: d.computer });
          if (r.ok) fill(msg, okBox(`Services of ${d.computer} now start after a restart.`));
          else fill(msg, errorBox(`sudo on ${d.computer} asks for a password, which this page never takes. Type this once in a terminal on ${d.computer}:`), cmdLine(r.command));
        } catch (e) {
          return fill(msg, errorBox(e));
        }
        gateways();
      } })) : null;
    fill(gwBox, groupHead('Gateways', d.gateways.length), lingerBox,
      d.gateways.length ? h('div.rows', d.gateways.map((g) => gatewayRow(g, d, press, msg))) : h('p.hint', 'No gateway is known on this computer.'),
      msg);
  }

  function gatewayRow(g, d, press, msg) {
    const svc = g.service;
    const state = [g.running ? 'Running' : g.installed ? 'Not running' : 'Not installed', g.port ? `port ${g.port}` : null, svc.made ? `runs as a service${svc.active === false ? ' (stopped)' : ''}` : null].filter(Boolean).join(' · ');
    const acts = h('div.cp-gwacts');
    if (!g.installed && !g.defined) {
      add(acts, btn('small primary', { icon: 'download', label: 'Install', onclick: async () => {
        if (!(await confirmSheet({ title: `Install ${g.title} on ${d.computer}?`, text: `${g.title} is installed with npm there. Its lines show here as they come.`, ok: `Install on ${d.computer}` }))) return;
        const out = h('pre.output', { 'aria-live': 'polite' });
        fill(msg, busy(`Installing ${g.title}…`), out);
        try {
          await api(`/api/addons/${g.id}/install`, { confirm: d.computer });
          let from = 0;
          for (;;) {
            const j = await api(`/api/addons/${g.id}/job?from=${from}`);
            if (j.lines.length) add(out, `${j.lines.join('\n')}\n`);
            from = j.next;
            if (!j.running) break;
            await new Promise((res) => setTimeout(res, 1000));
          }
          gateways();
        } catch (e) {
          add(msg, errorBox(e));
        }
      } }));
    }
    if (g.installed) {
      add(acts, g.running
        ? btn('small secondary', { icon: 'stop', label: 'Stop', onclick: () => press(`Stop ${g.title} on ${d.computer}?`, svc.made ? 'It is stopped now; its service starts it again after a restart.' : 'Sessions that use it stop working until it runs again.', `/api/gatewayhost/${g.id}/stop`, {}, (r) => okBox(said(r, `${g.title} stopped.`))) })
        : btn('small primary', { icon: 'play', label: 'Start', onclick: () => press(`Start ${g.title} on ${d.computer}?`, `On port ${g.port}. Hoprig asks it to listen on ${d.computer} only (127.0.0.1); a gateway of your own that does not read HOST or --host decides that itself.${g.marksFirst ? ' What it prints first is shown here once, and its first password is kept out of its log.' : ` What it prints goes to its log on ${d.computer} as it prints it, in a file only your user there can read.`}`, `/api/gatewayhost/${g.id}/start`, {}, (r) => okBox(said(r, `${g.title} runs.`))) }));
      if (svc.kind === 'systemd' || svc.kind === 'launchd') add(acts, btn('small secondary', { icon: 'restore', label: svc.made ? 'Remove the service' : 'Run as a service', onclick: () => service(g, d, msg) }));
      if (g.running) add(acts, btn('small ghost', { icon: 'external', label: 'Open its page', onclick: () => openPage(g, msg) }));
      if (g.firstWaiting) add(acts, btn('small secondary', { icon: 'key', label: 'Show what it printed first', onclick: () => press(`Show what ${g.title} printed first on ${d.computer}?`, 'It is shown this once, then Hoprig forgets it.', `/api/gatewayhost/${g.id}/first`, {}, () => null) }));
    }
    return h('div.row.static.cp-gwrow', h('span.row-icon', icon('swap')), h('span.row-main', h('span.row-title', g.title), h('span.row-sub', state), svc.sentence && g.installed ? h('span.row-sub', svc.sentence) : null), acts);
  }

  async function service(g, d, msg) {
    const on = !g.service.made;
    let plan;
    try {
      plan = await api(`/api/gatewayhost/${g.id}/service`);
    } catch (e) {
      return fill(msg, errorBox(e));
    }
    const yes = await openSheet({ title: on ? `Run ${g.title} as a service on ${d.computer}?` : `Remove ${g.title}'s service on ${d.computer}?`, wide: true }, (close) => [
      h('p.sheet-text', on ? `${g.running ? `${g.title} is stopped now and started again as a service. ` : ''}It then starts by itself after a restart of ${d.computer}. This file is written there:` : 'It is stopped and this file is removed:'),
      h('code.cp-unitpath', plan.file),
      on ? h('pre.output.cp-unit', plan.text) : null,
      h('p.sheet-text', on ? 'Then these run there:' : 'Then:'),
      h('pre.output.cp-unit', (on ? plan.commands : [`stop and disable it, remove ${plan.file}`]).join('\n')),
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: () => close(true) }, on ? `Make it on ${d.computer}` : `Remove it on ${d.computer}`)),
    ]);
    if (yes !== true) return;
    fill(msg, busy('Working on it…'));
    try {
      const r = await api(`/api/gatewayhost/${g.id}/service`, { on, confirm: d.computer });
      fill(msg, okBox(on ? `${g.title} runs as a service on ${d.computer}.` : `${g.title}'s service is removed.`), h('pre.output', r.lines.join('\n')));
    } catch (e) {
      fill(msg, errorBox(e));
    }
    gateways();
  }

  async function openPage(g, msg) {
    // Its page is never shown under this dashboard's address: a plain link of its own origin, or a forward.
    if (!name) {
      const host = plainHost(location.hostname, signedIn);
      if (local() && !host) return fill(msg, h('p.banner.info', icon('info', { size: 18 }), h('span', `You are signed in to this dashboard under both localhost and 127.0.0.1, so a link to ${g.title} would hand it your sign-in. Sign out under one of them (`, h('a', { href: link('#/settings/about?show=this-device') }, 'This device'), '), then press Open its page again.')));
      const href = `http://${host}:${g.port}/`;
      if (local()) return fill(msg, h('p.banner.info', icon('external', { size: 18 }), h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, `Open ${g.title}'s page (${href})`)));
      return fill(msg, h('p.banner.info', icon('info', { size: 18 }), h('span', `${g.title}'s page is on this computer's own address only. Open it in a browser on this computer: http://127.0.0.1:${g.port}/`)));
    }
    let st;
    try {
      st = await api(`~/api/machines/${name}/forward`);
    } catch (e) {
      return fill(msg, errorBox(e));
    }
    if (st.via === 'other') return fill(msg, h('p.banner.info', icon('info', { size: 18 }), h('span', noForwardWords(g.title, ctx.label(), g.port))));
    if (!st.here) return fill(msg, h('p.banner.info', icon('info', { size: 18 }), h('span', `${g.title}'s page can be opened only from a browser on the computer this dashboard runs on, or on ${ctx.label()} itself. From this device, open this dashboard on that computer and press Open its page there.`)));
    if (!(await confirmSheet({ title: `Open ${g.title}'s page from ${ctx.label()}?`, text: `A forward on this computer's own address leads to ${g.title} on ${ctx.label()}. It closes when you press Stop, or by itself after 15 minutes with nothing moving.`, ok: 'Open the forward' }))) return;
    try {
      const r = await api(`~/api/machines/${name}/forward`, { gateway: g.id, confirm: name });
      fill(msg, h('p.banner.info', icon('external', { size: 18 }),
        h('a', { href: r.forward.url, target: '_blank', rel: 'noopener noreferrer' }, `Open ${g.title}'s page (${r.forward.url})`),
        btn('small ghost', { icon: 'stop', label: 'Stop', onclick: async () => {
          await api(`~/api/machines/${name}/forward/stop`, {}).catch(() => {});
          fill(msg, okBox('The forward is closed.'));
        } })));
    } catch (e) {
      fill(msg, errorBox(e));
    }
  }

  load();
  return h('div.cp-health', h('div.savebar.start', refresh), top, gwBox);
}
