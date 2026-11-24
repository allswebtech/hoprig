// Settings → Add-ons: optional companions hoprig installs, starts and stops for you (src/addons), each with
// what it is, its state, and Install / Start / Stop / Update with their output live. "Set up as a provider" leads to
// Providers, where Add provider makes one of the gateway in the page. The public link has its own page in
// Settings; its entry in /api/addons is kept only for older hubs and is not shown here. "Add a gateway" defines one
// of the owner's own (gatewaydefine.js); such a one shows what it runs and has Remove (so does the warning line of one
// in config.json that was not loaded), and a program that is not a
// package (installable: false) has no Install or Update; one whose program changed since the owner confirmed it has
// Confirm the new program instead of Start. Adding and removing one are this computer's own steps (the
// routes refuse another computer's hub): on another computer's page neither is offered, one line says where.
import { APP_NAME, COMMAND } from './brand.js';
import { icon } from './icons.js';
import { confirmGatewayProgram, defineGatewaySheet, needsConfirmText, removeGateway, runsLine } from './gatewaydefine.js';
import { add, api, btn, confirmSheet, fill, h, link, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';

/**
 * What an add-on's row offers, from its status: "Set up as a provider" only for AI gateways (account !== false);
 * Start asks once when the add-on has notes to read first.
 */
export function addonView(a) {
  const notes = Array.isArray(a.notes) ? a.notes.filter((n) => typeof n === 'string' && n) : [];
  return {
    showAccount: a.account !== false,
    notes,
    confirmStart: notes.length > 0,
  };
}

/** The add-ons this page shows: all but the public link, which has its own page in Settings. */
export const shownAddons = (list) => (list || []).filter((a) => a && a.id !== 'public-link');

/** An add-on's own page: `page` where it says (a gateway of the owner's own; null when it has none), else its url. */
export const pageOf = (a) => ('page' in a ? a.page : a.url) || null;

/** One line per gateway definition that config.json holds but that was not loaded (GET /api/addons `skipped`). */
const skipped = (r) => ((r && Array.isArray(r.skipped)) ? r.skipped : []);
export const skippedLines = (r) => skipped(r)
  .map((x) => `A gateway in config.json${x.id ? ` (${x.id})` : ''} was not loaded: ${x.error}.`);

const STATE = (a) => (a.job && a.job.running ? ['working', 'Busy…'] : !a.installed && /^gone/.test(a.needsConfirm || '') ? ['ended', 'Program moved'] : !a.installed ? ['shell', 'Not installed'] : a.running ? ['waiting', 'Running'] : a.foreign ? ['ended', 'Port in use'] : a.needsConfirm ? ['ended', a.needsConfirm === 'changed' ? 'Program changed' : 'Not confirmed'] : ['ended', 'Installed, stopped']);

function render({ isAlive, here = true }) {
  const box = h('div.rows', h('div.row.static', h('span.row-main', h('span.row-sub', 'Looking at the add-ons…'))));
  const addButton = here ? btn('secondary', { icon: 'plus', label: 'Add a gateway', onclick: () => defineGatewaySheet(again) }) : null;
  // After an add or a remove: the list drawn again, and the focus on Add a gateway (the row it was on may be gone).
  const again = async () => {
    await paint();
    if (addButton && isAlive()) addButton.focus();
  };
  let painted = false;
  let computer = 'this computer'; // the name this computer gives itself (GET /api/addons): an install's confirmation sends it

  async function paint() {
    let r;
    try {
      r = await api('/api/addons');
    } catch (e) {
      fill(box, h('div.row.static', h('span.row-main', h('span.form-error', e.message))));
      return;
    }
    if (!isAlive()) return;
    computer = r.computer || 'this computer';
    const list = shownAddons(r.addons);
    fill(box, list.length ? list.map(row) : h('div.row.static', h('span.row-main', h('span.row-sub', 'No add-ons on this computer.'))),
      skipped(r).map((x, i) => h('div.banner.warn.mbanner', icon('alert', { size: 18 }), h('span', skippedLines(r)[i]),
        // One with an id is taken out of config.json through the same question and route as a row's Remove.
        x.id && here ? btn('small ghost', { icon: 'trash', label: 'Remove', onclick: () => removeGateway({ id: x.id, title: x.id, defined: true }, again) }) : null)));
    // Drawn again after an add, a remove or a job: the Settings list's one line under "Add-ons" follows.
    if (painted) window.dispatchEvent(new Event('saved'));
    painted = true;
  }

  /** Run an action (install, start, stop, update) and show its output under the add-on until it ends. */
  async function act(a, action, out) {
    // Installing or updating a gateway changes what is installed here: asked first, naming this computer.
    const owners = a.gateway && (action === 'install' || action === 'update');
    if (owners && action === 'update' && !(await confirmSheet({ title: `Update ${a.title} on ${computer}?`, text: `${a.title} is updated with npm on ${computer}. Its lines show here as they come.`, ok: `Update on ${computer}` }))) return;
    try {
      await api(`/api/addons/${a.id}/${action}`, owners ? { confirm: computer } : {});
    } catch (e) {
      toast(e, { kind: 'error' });
      return;
    }
    out.hidden = false;
    fill(out);
    let from = 0;
    for (;;) {
      const j = await api(`/api/addons/${a.id}/job?from=${from}`).catch(() => null);
      if (!j || !isAlive()) return;
      if (j.lines.length) add(out, `${j.lines.join('\n')}\n`);
      // A start's first lines, once (a first password among them): shown under its output, never again.
      if (j.first) add(out, `\nWhat it printed first, shown this once (Hoprig keeps none of it):\n${j.first.join('\n')}\n`);
      out.scrollTop = out.scrollHeight;
      from = j.next;
      if (!j.running) {
        const res = j.result || {};
        toast(res.ok ? `${a.title}: done` : `${a.title}: ${res.error || 'that did not work'}`, { kind: res.ok ? 'info' : 'error', from: res.ok ? null : res });
        paint();
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  function row(a) {
    const [key, text] = STATE(a);
    const out = h('pre.output', { hidden: true, 'aria-live': 'polite' });
    const busy = a.job && a.job.running;
    const v = addonView(a);
    const b = (ic, label, action) => btn('small secondary', { icon: ic, label, disabled: busy, onclick: () => act(a, action, out) });
    // Install, after one confirmation when some of its parts build a helper program while it installs.
    const install = () => btn('small secondary', {
      icon: 'download', label: 'Install', disabled: busy,
      onclick: async () => {
        if (a.gateway && !(await confirmSheet({ title: `Install ${a.title} on ${computer}?`, text: `${a.builds ? `${a.builds} ` : ''}${a.installCommand ? `This runs on ${computer}: ${a.installCommand}` : `It is installed with npm on ${computer}. Its lines show here as they come.`}`, ok: `Install on ${computer}` }))) return;
        if (!a.gateway && a.builds && !(await confirmSheet({ title: `Install ${a.title}?`, text: `${a.builds} This runs: ${a.installCommand}`, ok: 'Install' }))) return;
        act(a, 'install', out);
      },
    });
    // Start, after one confirmation when there is something to know first.
    const start = () => btn('small secondary', {
      icon: 'play', label: 'Start', disabled: busy,
      onclick: async () => {
        if (v.confirmStart && !(await confirmSheet({ title: `Start ${a.title}?`, text: v.notes.join(' '), ok: 'Start' }))) return;
        act(a, 'start', out);
      },
    });
    return h('div.row.static.col.mrow',
      h('div.mrow-top',
        h('span.row-icon', icon('cpu')),
        h('span.row-main',
          h('span.row-title', a.title, a.version ? h('span.badge.soft', a.version) : null),
          h('span', h(`span.pill.st-${key}`, h('span.dot'), text)))),
      h('p.hint', a.summary),
      h('div.mrow-actions',
        !a.installed && a.installable !== false ? install() : null,
        a.installed && !a.running && !a.foreign && !a.needsConfirm ? start() : null,
        a.defined && here && a.needsConfirm && a.needsConfirm !== 'gone-old' && !a.running ? btn('small secondary', { icon: 'check', label: a.needsConfirm === 'changed' || a.needsConfirm === 'gone' ? 'Confirm the new program' : 'Confirm the program', disabled: busy, onclick: () => confirmGatewayProgram(a, again) }) : null,
        a.running ? b('stop', 'Stop', 'stop') : null,
        a.installed && a.installable !== false ? b('refresh', 'Update', 'update') : null,
        !v.showAccount ? null : h('a.btn.small.ghost', { href: link('#/providers'), title: 'Providers → Add provider makes one of this gateway' }, icon('user', { size: 18 }), h('span', 'Set up as a provider')),
        a.running && pageOf(a) ? h('a.btn.small.ghost', { href: pageOf(a), target: '_blank', rel: 'noopener' }, icon('chevronRight', { size: 18 }), h('span', 'Open its dashboard')) : null,
        a.homepage ? h('a.btn.small.ghost', { href: a.homepage, target: '_blank', rel: 'noopener' }, h('span', 'About')) : null,
        a.defined && here ? btn('small ghost', { icon: 'trash', label: 'Remove', disabled: busy, onclick: () => removeGateway(a, again) }) : null),
      a.defined ? runsLine(a) : null,
      a.defined && !a.installed && !a.needsConfirm ? h('p.hint', 'Its program was not found on this computer.') : null,
      // Its program changed since the owner confirmed it (an update): not started until he confirms it again.
      a.defined && needsConfirmText(a) ? h('p.hint', needsConfirmText(a), a.needsConfirm === 'gone-old' ? ` In ${here ? 'this' : 'that'} computer's terminal: ${COMMAND} gateways confirm ${a.id} --program <path>` : here ? '' : ` On that computer's own dashboard, or with ${COMMAND} gateways confirm ${a.id} in its terminal.`) : null,
      // A gateway of the owner's own whose port another program holds (src/addons/localgateway.mjs): left alone.
      a.foreign ? h('p.hint', `Another program answers on its port (${a.url}). ${APP_NAME} did not start it, so it does not use or stop it: stop that program, or give ${a.title} another port.`) : null,
      v.notes.length && !a.running ? h('ul.addon-notes', v.notes.map((n) => h('li', n))) : null,
      a.running && pageOf(a) ? h('p.hint', `Its dashboard is at ${pageOf(a)} on this computer.`) : null,
      out);
  }

  paint();
  return [box,
    here ? h('div.savebar.start', addButton) : h('p.hint', `A gateway of your own is added or removed on that computer's own dashboard, or with ${COMMAND} gateways add in its terminal.`),
    h('p.hint', 'An add-on gateway turns other AI providers into one more provider for Claude Code and Auto mode.')];
}

registerSettingsPage({
  id: 'addons', title: 'Add-ons', icon: 'plus', order: 60, desc: `Optional companions ${APP_NAME} installs and runs for you.`, render,
  summary: async () => {
    const addons = shownAddons((await api('/api/addons')).addons);
    const on = addons.filter((a) => a.running).length;
    const inst = addons.filter((a) => a.installed).length;
    return inst ? `${inst} installed${on ? ` · ${on} running` : ''}` : 'None installed';
  },
});
