// Settings → Updates (#/settings/updates): one mode for everything, and one card each for Hoprig, the coding tools
// and the tunnel helper with the installed and the newest version, Check now, Update now (or Install) and what an
// update does to what is running. The server side is src/automation/updater.mjs (routes /api/updates…).
//
//   Manual (the default)  Hoprig looks when this page opens or Check now is pressed, and never installs by itself
//   Automatic             it also looks every 6 hours and installs each update at a safe moment (said per card)
import { api, ago, btn, fill, h, toast } from './lib.js';
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
  if (!it.latest) return it.canUpdate ? 'Newest unknown' : 'Installed';
  return 'Up to date';
}

/** The one line in the Settings list: the mode and how many updates wait. */
export function summaryOf(v) {
  const n = v.items.filter((i) => i.updateAvailable).length;
  return `${v.mode === 'auto' ? 'Automatic' : 'Manual'} · ${n ? `${n} update${n === 1 ? '' : 's'} available` : 'nothing new'}`;
}

function itemCard(it, act) {
  const out = h('pre.output.hidden', { 'aria-live': 'polite', 'data-item': it.id });
  const mark = savedMark();
  const rows = [
    info('Installed', it.installed || 'not installed'),
    info('Newest', it.latest || (it.error ? 'could not look' : 'unknown (offline?)')),
    it.method ? info('Installed by', it.method) : null,
  ];
  const check = btn('secondary', { icon: 'refresh', label: 'Check now', onclick: async () => {
    check.disabled = true;
    await act.check(it.id);
    check.disabled = false;
  } });
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
    el: panel({ icon: it.id === 'hoprig' ? 'info' : it.id === 'cloudflared' ? 'lock' : 'code', title: it.title, desc: it.whenRunning, tag: stateOf(it) },
      h('div.info-list', rows),
      it.updateAvailable ? h('p.banner.info', icon('download', { size: 18 }), h('span', `${it.latest} is available.`)) : null,
      it.blocked && it.action ? h('p.banner.warn', icon('clock', { size: 18 }), h('span', `${it.blocked}.`)) : null,
      it.why ? h('p.hint', it.why) : null,
      it.note ? h('p.hint', it.note) : null,
      it.error ? h('p.form-error', it.error) : null,
      it.last ? h(`p.banner.${it.last.ok ? 'ok-box' : 'error-box'}`, icon(it.last.ok ? 'check' : 'alert', { size: 18 }),
        h('span', it.last.ok ? `Updated ${ago(it.last.at)}${it.last.version ? `: now ${it.last.version}` : ''}.` : `The last update failed ${ago(it.last.at)}: ${it.last.error}`)) : null,
      out,
      h('div.savebar', it.checkedAt ? h('span.hint', `Looked ${ago(it.checkedAt)}`) : null, mark, check, doIt)),
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
        toast(e.message, { kind: 'error' });
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
        await load();
        follow(0);
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
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
      toast(e.message, { kind: 'error' });
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
        drawTop();
        return true;
      } catch (e) {
        toast(e.message, { kind: 'error' });
        return false;
      }
    };
    const waiting = v.items.filter((i) => i.updateAvailable && i.action === 'update').length;
    function drawTop() {
      fill(top,
        panel({ icon: 'download', title: 'How updates happen', desc: 'One choice for everything below.' },
          radioCards('upd-mode', MODES, view.mode, (m) => set({ mode: m })),
          toggle('Tell me about new versions', view.notify, (on) => set({ notify: on }),
            'A notification once per new version (Settings → Notifications says where). Hoprig then looks every 6 hours.'),
          h('div.savebar', mark,
            btn('secondary', { icon: 'refresh', label: 'Check all now', onclick: async (e) => {
              const b = e.currentTarget;
              b.disabled = true;
              fill(list, h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Looking for new versions…')));
              await act.check(null);
              b.disabled = false;
            } }),
            btn(waiting ? 'primary' : 'secondary', { icon: 'download', label: 'Update all', disabled: !waiting || act.busy(), title: waiting ? '' : 'Nothing to update', onclick: () => act.run('all') }))));
    }
    drawTop();
    outs = new Map();
    fill(list, v.items.map((it) => {
      const c = itemCard(it, act);
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
  desc: 'New versions of Hoprig, the coding tools and the tunnel helper: when they are installed, and what that does to running sessions.',
  summary: async () => summaryOf(await api('/api/updates')),
  render: updatesPage,
});
