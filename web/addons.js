// Settings → Add-ons: optional companions hoprig installs, starts and stops for you (src/addons), each with
// what it is, its state, and Install / Start / Stop / Update with their output live. "Set up as an account"
// opens a terminal session where the owner types the key: a key never goes through this page.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { add, api, btn, confirmSheet, fill, h, link, qrSvg, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';

/**
 * What an add-on's row offers, from its status: "Set up as an account" only for AI gateways (account !== false);
 * Start asks once when the add-on has notes to read first; a running add-on with an address of its own (the
 * public link) shows that address with a sign-in QR for it.
 */
export function addonView(a) {
  const notes = Array.isArray(a.notes) ? a.notes.filter((n) => typeof n === 'string' && n) : [];
  return {
    showAccount: a.account !== false,
    notes,
    confirmStart: notes.length > 0,
    showAddress: !!(a.running && a.url && a.account === false),
  };
}

const STATE = (a) => (a.job && a.job.running ? ['working', 'Busy…'] : !a.installed ? ['shell', 'Not installed'] : a.running ? ['waiting', 'Running'] : ['ended', 'Installed, stopped']);

function render({ isAlive }) {
  const box = h('div.rows', h('div.row.static', h('span.row-main', h('span.row-sub', 'Looking at the add-ons…'))));

  async function paint() {
    let r;
    try {
      r = await api('/api/addons');
    } catch (e) {
      fill(box, h('div.row.static', h('span.row-main', h('span.form-error', e.message))));
      return;
    }
    if (!isAlive()) return;
    fill(box, r.addons.map(row));
  }

  /** Run an action and show its output under the add-on until it ends. */
  async function act(a, action, out) {
    try {
      await api(`/api/addons/${a.id}/${action}`, {});
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return;
    }
    out.hidden = false;
    fill(out);
    let from = 0;
    for (;;) {
      const j = await api(`/api/addons/${a.id}/job?from=${from}`).catch(() => null);
      if (!j || !isAlive()) return;
      if (j.lines.length) add(out, `${j.lines.join('\n')}\n`);
      out.scrollTop = out.scrollHeight;
      from = j.next;
      if (!j.running) {
        toast(j.result && j.result.ok ? `${a.title}: done` : `${a.title}: ${(j.result && j.result.error) || 'that did not work'}`, { kind: j.result && j.result.ok ? 'info' : 'error' });
        paint();
        return;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  function row(a) {
    const [key, text] = STATE(a);
    const out = h('pre.output', { hidden: true, 'aria-live': 'polite' });
    const busy = a.job && a.job.running;
    const v = addonView(a);
    const b = (ic, label, action) => btn('small secondary', { icon: ic, label, disabled: busy, onclick: () => act(a, action, out) });
    // Start, after one confirmation when there is something to know first (the public link opens this dashboard
    // to the internet for a while).
    const start = () => btn('small secondary', {
      icon: 'play', label: 'Start', disabled: busy,
      onclick: async () => {
        if (v.confirmStart && !(await confirmSheet({ title: `Start ${a.title}?`, text: v.notes.join(' '), ok: 'Start' }))) return;
        act(a, 'start', out);
      },
    });
    const address = v.showAddress ? h('div.addon-address') : null;
    if (address) {
      // A sign-in QR made for THAT address: a phone scanning it lands signed in on the public page.
      api('~/api/login/links', { base: a.url })
        .then((l) => fill(address,
          h('p', 'Open this address, or scan the code with a phone to sign in there once:'),
          h('a.mono', { href: a.url, target: '_blank', rel: 'noopener' }, a.url),
          l.qr ? h('div.qrbox', qrSvg(l.qr)) : null,
          h('p.hint', 'The address changes each time it starts and is not for permanent use.')))
        .catch((e) => fill(address, h('p.hint', `${a.url} — ${e.message}`)));
    }
    return h('div.row.static.col.mrow',
      h('div.mrow-top',
        h('span.row-icon', icon('cpu')),
        h('span.row-main',
          h('span.row-title', a.title, a.version ? h('span.badge.soft', a.version) : null),
          h('span', h(`span.pill.st-${key}`, h('span.dot'), text)))),
      h('p.hint', a.summary),
      h('div.mrow-actions',
        !a.installed ? b('download', 'Install', 'install') : null,
        a.installed && !a.running ? start() : null,
        a.running ? b('stop', 'Stop', 'stop') : null,
        a.installed ? b('refresh', 'Update', 'update') : null,
        !v.showAccount ? null : btn('small ghost', { icon: 'user', label: 'Set up as a provider', title: 'Opens a terminal where you type its key', onclick: async () => {
          try {
            const { name } = await api(`/api/addons/${a.id}/setup`, {});
            location.hash = link(`#/s/${encodeURIComponent(name)}`);
          } catch (e) {
            toast(e.message, { kind: 'error' });
          }
        } }),
        a.running && a.url && !v.showAddress ? h('a.btn.small.ghost', { href: a.url, target: '_blank', rel: 'noopener' }, icon('chevronRight', { size: 18 }), h('span', 'Open its dashboard')) : null,
        a.homepage ? h('a.btn.small.ghost', { href: a.homepage, target: '_blank', rel: 'noopener' }, h('span', 'About')) : null),
      v.notes.length && !a.running ? h('ul.addon-notes', v.notes.map((n) => h('li', n))) : null,
      address,
      a.running && a.url && !v.showAddress ? h('p.hint', `Its dashboard is at ${a.url} on this computer.`) : null,
      out);
  }

  paint();
  return [box, h('p.hint', 'An add-on gateway turns other AI providers into one more provider for Claude Code and Auto mode.')];
}

registerSettingsPage({
  id: 'addons', title: 'Add-ons', icon: 'plus', order: 60, desc: `Optional companions ${APP_NAME} installs and runs for you.`, render,
  summary: async () => {
    const { addons } = await api('/api/addons');
    const on = addons.filter((a) => a.running).length;
    const inst = addons.filter((a) => a.installed).length;
    return inst ? `${inst} installed${on ? ` · ${on} running` : ''}` : 'None installed';
  },
});
