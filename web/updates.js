// Settings → Updates (#/settings/updates): one mode for everything, and one card each for Hoprig, the coding tools
// and the tunnel helper with the installed and the newest version, Check now, Update now (or Install) and what an
// update does to what is running. The server side is src/automation/updater.mjs (routes /api/updates…).
//
//   Manual (the default)  Hoprig looks when this page opens or Check now is pressed, and never installs by itself
//   Automatic             it also looks every 6 hours and installs each update at a safe moment (said per card)
import { api, ago, btn, fill, h, link, toast } from './lib.js';
import { icon } from './icons.js';
import { registerSettingsPage } from './registry.js';
import { fold, panel, radioCards, savedMark, toggle } from './shell.js';

const MODES = [
  { value: 'manual', title: 'Manual', sub: 'Hoprig looks when you open this page or press Check now, and shows what is new. Nothing is installed until you press Update now.' },
  { value: 'auto', title: 'Automatic', sub: 'Hoprig also looks every 6 hours and installs each update by itself, at a safe moment: the line under each item says when.' },
];

/** The state word of one item, for its card's tag and the Settings list. */
export function stateOf(it) {
  if (it.error) return 'Could not look';
  if (!it.installed) return 'Not installed';
  if (it.updateAvailable) return 'Update available';
  if (!it.latest) return it.method === 'git checkout' ? 'Git checkout' : it.canUpdate ? 'Newest unknown' : 'Installed';
  return 'Up to date';
}

/** The line about the last update or install of an item, or null. */
function lastLine(l) {
  if (!l.ok) return `The last ${l.installed ? 'install' : 'update'} failed ${ago(l.at)}: ${l.error}`;
  const what = `${l.installed ? 'Installed' : 'Updated'} ${ago(l.at)}${l.version ? `: now ${l.version}` : ''}.`;
  return l.restart ? `${what} Restart the dashboard to use it.` : what;
}

/** Put focus back where it was after a part of the page was drawn again (a keyboard user keeps their place). */
function keepFocus(root, redraw) {
  const all = () => [...root.querySelectorAll('input, button, select, textarea, a[href]')];
  const at = all().indexOf(document.activeElement);
  redraw();
  if (at >= 0) all()[at]?.focus();
}

/** The one line in the Settings list: the mode and how many updates wait. */
export function summaryOf(v) {
  const n = v.items.filter((i) => i.updateAvailable).length;
  return `${v.mode === 'auto' ? 'Automatic' : 'Manual'} · ${n ? `${n} update${n === 1 ? '' : 's'} available` : 'nothing new'}`;
}

function itemCard(it, act, own) {
  const out = h('pre.output.hidden', { 'aria-live': 'polite', 'data-item': it.id });
  const mark = savedMark();
  // Nothing to look up (an install Hoprig does not update): no "Newest" and no "Looked" line, the hint says why.
  const looks = !(it.why && !it.canUpdate && !it.error);
  const rows = [
    info('Installed', it.installed || 'not installed'),
    looks ? info('Newest', it.latest || (it.error ? 'could not look' : 'unknown (offline?)')) : null,
    it.method ? info('Installed by', it.method) : null,
  ];
  const check = looks ? btn('secondary', { icon: 'refresh', label: 'Check now', onclick: async () => {
    check.disabled = true;
    check.classList.add('busy');
    await act.check(it.id);
    check.disabled = false;
    check.classList.remove('busy');
  } }) : null;
  const fresh = it.last && it.last.ok && it.last.version && it.last.version === it.latest;
  const doIt = it.action
    ? btn(it.updateAvailable || it.action === 'install' ? 'primary' : 'secondary', {
      icon: 'download',
      label: it.action === 'install' ? 'Install' : 'Update now',
      disabled: !!it.blocked || act.busy(),
      title: it.blocked || '',
      onclick: () => act.run(it.id),
    })
    : null;
  return {
    out,
    // What an update does to running work matters only once it is installed.
    el: panel({ icon: it.id === 'hoprig' ? 'info' : it.id === 'cloudflared' ? 'lock' : 'code', title: it.title, desc: it.installed ? it.whenRunning : null, tag: stateOf(it) },
      h('div.info-list', rows),
      own ? h('p.banner.info', icon('clock', { size: 18 }), h('span', `${it.title} ${own === 'auto' ? 'updates by itself' : 'is only updated when you press Update now'}: your earlier choice for it, kept when this page replaced it.`),
        btn('small secondary', { label: 'Follow the choice above', onclick: () => act.follow(it.id) })) : null,
      it.updateAvailable && !fresh ? h('p.banner.info', icon('download', { size: 18 }), h('span', `${it.latest} is available.`)) : null,
      it.blocked && it.action ? h('p.banner.warn', icon('clock', { size: 18 }), h('span', `${it.blocked}.`)) : null,
      it.why ? h('p.hint', it.why) : null,
      it.note ? h('p.hint', it.note) : null,
      it.error ? h('p.form-error', it.error) : null,
      it.last ? h(`p.banner.${it.last.ok ? 'ok-box' : 'error-box'}`, icon(it.last.ok ? 'check' : 'alert', { size: 18 }), h('span', lastLine(it.last)),
        it.last.ok && it.last.restart ? btn('small primary', { label: 'Restart now', onclick: () => act.restart() }) : null) : null,
      out,
      h('div.savebar', looks && it.checkedAt ? h('span.hint', `Looked ${ago(it.checkedAt)}`) : null, mark, check, doIt)),
  };
}

const info = (label, value) => h('div.inforow', h('div.inforow-top', h('span', label), h('strong', value)));

function updatesPage({ isAlive }) {
  const top = h('div');
  const list = h('div', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Looking at what is installed and what is new…')));
  let view = null;
  let outs = new Map();
  let following = false;

  const act = {
    busy: () => !!(view && view.running),
    async check(id) {
      try {
        draw(await api('/api/updates/check', id ? { id } : {}));
      } catch (e) {
        toast(e, { kind: 'error' });
      }
    },
    async follow(id) {
      try {
        await api('/api/updates/settings', { itemModes: { [id]: null } });
        await load();
      } catch (e) {
        toast(e, { kind: 'error' });
      }
    },
    async run(id) {
      try {
        const r = await api('/api/updates/run', { id });
        if (!r.started) {
          toast(r.skipped && r.skipped.length ? `Nothing could start now: ${r.skipped.map((s) => s.why).join('; ')}` : 'Nothing to update.');
          return;
        }
        if (r.skipped && r.skipped.length) toast(`Waits: ${r.skipped.map((s) => s.why).join('; ')}`, { ms: 7000 });
        await load(); // draws the running item and follows its output
      } catch (e) {
        toast(e, { kind: 'error', ms: 6000 });
      }
    },
    async restart() {
      try {
        const r = await api('/api/updates/restart', {});
        if (r && r.restarting) toast('The dashboard is restarting to use the new version. Reload this page in a few seconds.', { ms: 8000 });
        else toast((r && r.why) || 'The dashboard could not restart itself.', { kind: 'error', ms: 8000 });
      } catch (e) {
        toast(e, { kind: 'error', ms: 6000 });
      }
    },
  };

  async function follow(from) {
    following = true;
    try {
      const r = await api(`/api/updates/log?from=${from}`);
      const out = outs.get(r.id);
      if (out && r.lines.length) {
        out.classList.remove('hidden');
        out.textContent += `${r.lines.join('\n')}\n`;
        out.scrollTop = out.scrollHeight;
      }
      if (r.running && isAlive()) {
        setTimeout(() => follow(r.next), 1000);
        return;
      }
      following = false;
      const res = Object.entries(r.results || {});
      const bad = res.filter(([, x]) => !x.ok);
      if (res.length) toast(bad.length ? 'An update did not finish: see its output' : 'Updated', { kind: bad.length ? 'error' : 'info' });
      const keep = new Map([...outs].map(([k, o]) => [k, o.textContent]));
      await load();
      for (const [k, text] of keep) if (text && outs.get(k)) { outs.get(k).textContent = text; outs.get(k).classList.remove('hidden'); }
    } catch (e) {
      following = false;
      toast(e, { kind: 'error' });
    }
  }

  function draw(v) {
    view = v;
    const mark = savedMark();
    const set = async (patch) => {
      try {
        await api('/api/updates/settings', patch);
        view = { ...view, ...patch };
        mark.show();
        keepFocus(top, drawTop);
        return true;
      } catch (e) {
        toast(e, { kind: 'error' });
        return false;
      }
    };
    const waiting = v.items.filter((i) => i.updateAvailable && i.action === 'update').length;
    const checkAll = btn('secondary', { icon: 'refresh', label: 'Check all now', onclick: async () => {
      checkAll.disabled = true;
      checkAll.classList.add('busy');
      fill(list, h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Looking for new versions…')));
      await act.check(null);
    } });
    function drawTop() {
      fill(top,
        panel({ icon: 'download', title: 'How updates happen', desc: 'One choice for everything below.' },
          radioCards('upd-mode', MODES, view.mode, (m) => set({ mode: m })),
          toggle('Tell me about new versions', view.notify, (on) => set({ notify: on }),
            ['A notification once per new version (Settings → Notifications says where). Hoprig then looks every 6 hours. ',
              h('a', { href: link('#/settings/notifications') }, 'Open Notifications')]),
          h('div.savebar', mark,
            checkAll,
            btn(waiting ? 'primary' : 'secondary', { icon: 'download', label: 'Update all', disabled: !waiting || act.busy(), title: waiting ? '' : 'Nothing to update', onclick: () => act.run('all') }))));
    }
    drawTop();
    outs = new Map();
    fill(list, v.items.map((it) => {
      const c = itemCard(it, act, (v.itemModes || {})[it.id] || null);
      outs.set(it.id, c.out);
      return c.el;
    }));
    if (v.running && !following) follow(0);
  }

  async function load() {
    try {
      draw(await api('/api/updates'));
    } catch (e) {
      fill(list, h('div.empty', icon('alert', { size: 32 }), h('p', e.message), btn('secondary', { label: 'Try again', icon: 'refresh', onclick: load })));
    }
  }
  load();
  return [top, list, fold('settings-updates', 'Advanced', h('p.hint', 'The same from the command line: hoprig tools (the coding tools), hoprig claude update, hoprig update (Hoprig itself).'))];
}

registerSettingsPage({
  id: 'updates', title: 'Updates', icon: 'download', order: 65,
  desc: 'New versions of Hoprig, the coding tools and the helper for the public link (cloudflared): when they are installed, and what that does to running sessions.',
  summary: async () => summaryOf(await api('/api/updates')),
  render: updatesPage,
});
