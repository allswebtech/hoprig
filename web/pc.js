// One computer's page (#/computer, #/m/<computer>/computer), opened from Computers. Three parts, each with its own
// address so back and links work: Overview (#/computer: status, load, memory, disks, Claude Code, sessions, whether
// it can be reached from anywhere), Setup (#/computer/setup, pcsetup.js; Home → Get started opens it) and Advanced
// (#/computer/advanced: processes, listening ports, rename / test / remove, power). The last answers of each
// computer are kept while the page is open, so switching between the parts draws at once, without a jump.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { MACHINE_STATE, add, api, at, btn, bytes, confirmSheet, fill, h, link, machine, openSheet, prefs, promptSheet, stateOf, toast } from './lib.js';
import { registerPage } from './registry.js';
import { errorBox, groupHead, okBox, tabBar } from './shell.js';
import { store } from './store.js';
import { setupSection } from './pcsetup.js';

export const PARTS = [
  { id: '', title: 'Overview', text: 'How it is doing now: load, memory, disks, Claude Code and the sessions on it.' },
  { id: 'setup', title: 'Setup', text: 'What it has for coding, what is missing, and one button to install it.' },
  { id: 'advanced', title: 'Advanced', text: 'The programs running on it, its open ports, its name, and power.' },
];

const OS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
export const osName = (p) => OS[p] || p || '';
const cache = new Map(); // computer ('~' for this one) → the last answers: { pc, info, claude, reach }
const keyOf = () => machine.current || '~';

/** "3 d 5 h" from seconds. */
export function upFor(s) {
  if (!Number.isFinite(s)) return '';
  const d = Math.floor(s / 86400);
  const hr = Math.floor((s % 86400) / 3600);
  const min = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${hr} h` : hr ? `${hr} h ${min} min` : `${min} min`;
}

/** The busiest and the largest programs as one list (each once), sorted by 'cpu' or 'mem'. */
export function processList(d, sort = 'cpu') {
  const byPid = new Map();
  for (const p of [...(d.topCpu || []), ...(d.topMem || [])]) byPid.set(p.pid, p);
  const val = (p) => (sort === 'mem' ? p.rss : Number.isFinite(p.cpu) ? p.cpu : -1);
  return [...byPid.values()].sort((a, b) => val(b) - val(a));
}

/** Can the computer's dashboard be opened from anywhere? From its settings and add-ons: { level, text }. */
export function reachOf(settings, addons = []) {
  // The public link add-on (id "public-link"): its fixed address first, then the temporary one.
  const link = addons.find((a) => a.id === 'public-link') || {};
  const fixed = link.fixed;
  if (fixed && fixed.enabled && fixed.url) {
    // The row's title already says "Yes, from anywhere": the text only says where.
    return { level: 'anywhere', text: fixed.connected ? `At its fixed address ${fixed.url}.` : `At its fixed address ${fixed.url}, once it is connected (it is connecting now).` };
  }
  if (link.running && link.url) return { level: 'anywhere', text: `Through the public link ${link.url} (temporary: the address changes each time it starts).` };
  const s = (settings && settings.server) || {};
  if (s.publicUrl) return { level: 'anywhere', text: `At ${s.publicUrl}.` };
  const n = (settings && settings.network) || {};
  if (n.host && !['127.0.0.1', '::1', 'localhost'].includes(n.host)) return { level: 'network', text: `From other devices that can reach it on port ${n.port}, such as the same network or Tailscale.` };
  return { level: 'local', text: 'Turn on the public link, or use Tailscale, to open it from anywhere.' };
}

/** The open computer as the list of computers knows it (state, system, versions). */
async function computerInfo() {
  const d = await api('~/api/machines');
  if (!machine.current) return { self: true, name: null, label: d.self.label, state: 'online', platform: d.self.platform, version: d.self.version, claude: d.self.claude };
  const m = d.machines.find((x) => x.name === machine.current);
  if (!m) throw new Error('This computer is no longer in the list.');
  return m;
}

/** Follow a job's output ("…?from=N" answers { running, lines, next, result }) into `out` until it ends. */
async function follow(path, out, isAlive) {
  let from = 0;
  for (;;) {
    const r = await api(`${path}?from=${from}`);
    if (r.lines.length) add(out, `${r.lines.join('\n')}\n`);
    out.scrollTop = out.scrollHeight;
    from = r.next;
    if (!r.running || !isAlive()) return r.result;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** Update Claude Code on computer `m` (null: this one), with its output live in a sheet. */
async function updateClaude(m, label, done) {
  const out = h('pre.output', { 'aria-live': 'polite' });
  const status = h('p.hint', 'Starting the update…');
  let open = true;
  const sheet = openSheet({ title: `Update Claude Code on ${label}`, wide: true }, (close) => [
    h('p.sheet-text', 'Running sessions are not touched; they use the new version when they start again.'),
    status, out,
    h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Close')),
  ]);
  sheet.then(() => {
    open = false;
    done();
  });
  try {
    await api(at(m, '/api/claude/update'), {});
    const r = await follow(at(m, '/api/claude/update'), out, () => open);
    if (r) fill(status, r.ok ? okBox(`Done: Claude Code ${r.version || ''} is installed.`) : errorBox('The update did not finish: see the output, then try again or install it under Setup.'));
  } catch (e) {
    fill(status, errorBox(e.message));
  }
}

const meter = (frac) => h(`div.meter${frac > 0.9 ? '.hot' : ''}`, h('i', { style: { width: `${Math.round(Math.min(1, Math.max(0, frac || 0)) * 100)}%` } }));
// Every tile has the same parts, so the four stay the same height; a tile without a share keeps its meter's room.
const tile = (label, value, sub, frac) => h('div.tile', h('div.tile-label', label), h('div.tile-value', value), h('div.tile-sub', sub || ' '), frac === null ? h('div.meter.cp-nometer') : meter(frac));
/**
 * How busy the computer is, in plain words first: the last minute's load as a share of its CPUs ("Busy 18 %"); the
 * raw load figures are the second line and the tooltip.
 */
export function busyFigures(load, cpus) {
  const n = Math.max(1, cpus || 1);
  const pct = Math.round((load[0] / n) * 100);
  return { value: `${pct}%`, word: pct >= 90 ? 'Very busy' : pct >= 50 ? 'Busy' : 'Calm', sub: `load ${load[0].toFixed(2)} on ${n} CPUs`, title: `Load 1, 5 and 15 min: ${load.map((x) => x.toFixed(2)).join(', ')}`, frac: load[0] / n };
}
const busyTile = (load, cpus) => {
  const b = busyFigures(load, cpus);
  const t = tile(b.word, b.value, b.sub, b.frac);
  t.title = b.title;
  return t;
};
/** The disk the system lives on is "Main disk"; others keep their mount point (it is how one recognises them). */
export const diskName = (mount) => (mount === '/' || /^[A-Za-z]:\\?$/.test(mount || '') ? 'Main disk' : mount);
const section = (title, count, ...body) => h('section.cp-section', groupHead(title, count), ...body);

// ======================= Overview =======================

function overview(ctx) {
  const root = h('div.cp-part');
  let offCard = null; // made once: a repaint must not wipe the answer to Try again
  const paint = () => {
    const c = cache.get(keyOf()) || {};
    if (c.failed && !c.pc) {
      // Made again only when the name arrives or changes.
      if (!offCard || offCard.dataset.label !== ctx.label()) offCard = offline(ctx, c.failed);
      if (!root.contains(offCard)) fill(root, offCard);
      return;
    }
    if (!c.pc) return fill(root, tilesLoading());
    const d = c.pc;
    const i = c.info || {};
    const used = d.mem.total - d.mem.available;
    const hasSwap = Number.isFinite(d.mem.swapTotal) && Number.isFinite(d.mem.swapFree);
    const swapUsed = hasSwap ? d.mem.swapTotal - d.mem.swapFree : 0;
    const load = Array.isArray(d.load) && d.load.every(Number.isFinite) ? d.load : null;
    fill(root,
      c.failed ? ctx.connectionBanner(c.failed) : null,
      h('p.cp-status',
        h('span.cp-dot.on', { 'aria-hidden': 'true' }),
        h('span', h('strong', 'Online'), [Number.isFinite(d.uptime) ? `up ${upFor(d.uptime)}` : null, osName(d.platform || i.platform), i.version ? `${APP_NAME} ${i.version}` : null].filter(Boolean).map((t) => ` · ${t}`).join(''))),
      h('div.tiles',
        load ? busyTile(load, d.cpus) : tile('CPUs', String(d.cpus || '—'), 'no load figure on this system', null),
        tile('Memory', bytes(used), `of ${bytes(d.mem.total)}`, used / d.mem.total),
        hasSwap ? tile('Swap', bytes(swapUsed), d.mem.swapTotal ? `of ${bytes(d.mem.swapTotal)}` : 'none', d.mem.swapTotal ? swapUsed / d.mem.swapTotal : 0) : null,
        tile('Sessions', String(d.sessions.length), 'running', null)),
      section('Disks', undefined, h('div.rows', d.disks.map((x) =>
        h('div.row.static.col',
          h('span.row-main', h('span.row-title', diskName(x.mount)), h('span.row-sub', `${bytes(x.avail)} free · ${bytes(x.used)} of ${bytes(x.size)} used${diskName(x.mount) === x.mount ? '' : ` · ${x.mount}`}`)),
          meter(x.used / x.size))))),
      section('Claude Code', undefined, h('div.rows', claudeRow(ctx, c))),
      section('Sessions', d.sessions.length, d.sessions.length
        ? h('div.rows', d.sessions.map((t) => sessionRow(t)))
        : h('div.rows', h('div.row.static', h('span.row-main', h('span.row-sub', 'No sessions on it right now.'))))),
      section('Reach it from anywhere', undefined, h('div.rows', reachRow(c.reach))),
      d.errors && d.errors.length ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', `Some figures could not be read: ${d.errors.join(' · ')}`)) : null);
  };
  ctx.onData(paint);
  paint();
  return root;
}

/** A session on this computer: what it is doing and its folder, from the session poll when it knows it. */
function sessionRow(t) {
  const s = ((store.all.find((m) => m.machine === machine.current) || {}).sessions || []).find((x) => x.name === t.name);
  const sub = s ? [stateOf(s).text, s.short].filter(Boolean).join(' · ') : t.attached ? 'Also open in a terminal' : 'Open it to follow or type';
  return h('a.row', { href: link(`#/s/${encodeURIComponent(t.name)}`) },
    h('span.row-icon', icon('terminal')),
    h('span.row-main', h('span.row-title', t.name), h('span.row-sub', sub)),
    h('span.row-end', icon('chevronRight', { size: 18 })));
}

function claudeRow(ctx, c) {
  const cl = c.claude;
  if (!cl) return h('div.row.static', h('span.row-icon', icon('sparkle')), h('span.row-main', h('span.row-title', 'Claude Code'), h('span.row-sub', 'Looking…')));
  if (!cl.installed) {
    return h('a.row', { href: link('#/computer/setup') }, h('span.row-icon', icon('sparkle')),
      h('span.row-main', h('span.row-title', 'Claude Code not installed'), h('span.row-sub', 'Install it under Setup.')),
      h('span.row-end', icon('chevronRight', { size: 18 })));
  }
  return h('div.row.static', h('span.row-icon', icon('sparkle')),
    h('span.row-main', h('span.row-title', `Claude Code ${cl.installed}`),
      h('span.row-sub', cl.updateAvailable ? `Version ${cl.latest} is out` : cl.latest ? 'The newest version' : 'Installed')),
    cl.updateAvailable ? btn('small primary', { icon: 'download', label: 'Update', onclick: () => updateClaude(machine.current, ctx.label(), ctx.reload) }) : null);
}

function reachRow(reach) {
  if (!reach) return h('div.row.static', h('span.row-icon', icon('lock')), h('span.row-main', h('span.row-title', 'Checking…'), h('span.row-sub', ' ')));
  const title = { anywhere: 'Yes, from anywhere', network: 'From the network', local: 'No: only on the computer itself', unknown: 'Could not tell' }[reach.level];
  return h('a.row', { href: link(reach.level === 'local' ? '#/settings/addons' : '#/settings/security') },
    h('span.row-icon', icon(reach.level === 'anywhere' ? 'check' : 'lock')),
    h('span.row-main.cp-wrap', h('span.row-title', title), h('span.row-sub', reach.text)),
    h('span.row-end', icon('chevronRight', { size: 18 })));
}

/** Another computer that does not answer: what is known, and what to do. */
function offline(ctx, err) {
  const m = store.all.find((x) => x.machine === machine.current) || {};
  const msg = h('div', { role: 'status' });
  const again = btn('primary', { icon: 'refresh', label: 'Try again', onclick: async () => {
    again.disabled = true;
    fill(msg, h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', `Asking ${ctx.label()}…`)));
    try {
      if (machine.current) {
        const r = await api(`~/api/machines/${machine.current}/test`, {});
        if (r.machine.state !== 'online') throw new Error(r.machine.error || MACHINE_STATE[r.machine.state] || r.machine.state);
      }
      fill(msg, okBox(`${ctx.label()} answers again.`));
      store.refresh();
      ctx.reload();
    } catch (e) {
      fill(msg, errorBox(`Still no answer: ${e.message}`));
    }
    again.disabled = false;
  } });
  return h('section.card.panel.cp-offline', { dataset: { label: ctx.label() } },
    h('div.panel-head', h('span.panel-icon.cp-warn', icon('alert')),
      h('div', h('h2.panel-title', `${ctx.label()} cannot be reached`), h('p.panel-desc', m.error || err.message || 'It does not answer.'))),
    h('ol.cp-next',
      h('li', 'Check that the computer is switched on and connected to the network.'),
      h('li', `Check that ${APP_NAME} runs on it (it starts by itself after a restart when it runs as a service).`),
      h('li', 'Press Try again. To rename or remove it, open Advanced.')),
    h('div.savebar.start', again, h('a.btn.ghost', { href: link('#/computer/advanced') }, 'Advanced')),
    msg);
}

// The four tiles while the first figures load (tiles, not rows: shell.js skeletonRows is for lists).
const tilesLoading = () => h('div.cp-skeleton', { 'aria-busy': 'true' },
  h('p.cp-status', h('span.cp-dot', { 'aria-hidden': 'true' }), h('span', 'Reading the computer…')),
  h('div.tiles', [1, 2, 3, 4].map(() => h('div.tile.cp-ghost', h('div.tile-label', ' '), h('div.tile-value', ' '), h('div.tile-sub', ' '), meter(0)))));

// ======================= Advanced =======================

function advanced(ctx) {
  const procs = h('div');
  const ports = h('div');
  const powerMsg = h('div', { role: 'status' });
  const manageMsg = h('div', { role: 'status' });
  let sort = prefs.get('computer.sort', 'cpu');
  const sortBar = h('div.segmented.cp-sort', { role: 'radiogroup', 'aria-label': 'Sort by' });

  const paintSort = () => fill(sortBar, [['cpu', 'Busiest first'], ['mem', 'Largest first']].map(([v, t]) =>
    h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(sort === v), onclick: () => {
      sort = v;
      prefs.set('computer.sort', v);
      paintSort();
      paint();
    } }, t)));

  const stopBtn = (p) => (p.mine
    ? btn('small ghost', { icon: 'stop', label: 'Stop', title: `Stop ${p.name}`, 'aria-label': `Stop ${p.name}`, onclick: async () => {
      if (!(await confirmSheet({ title: `Stop ${p.name} on ${ctx.label()}?`, text: `Program ${p.pid}: ${p.args}. Unsaved work in it is lost.`, ok: 'Stop it', danger: true }))) return;
      try {
        await api('/api/pc/kill', { pid: p.pid });
        toast(`Stopped ${p.name}`);
        ctx.reload();
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
      }
    } })
    : h('span.cp-stop-none.muted', { title: 'Started by another user: it cannot be stopped from here' }, 'not yours'));

  function paint() {
    const c = cache.get(keyOf()) || {};
    if (!c.pc) {
      const text = c.failed ? `Cannot be read while ${ctx.label()} does not answer.` : 'Reading…';
      fill(procs, h('div.rows', h('div.row.static', h('span.row-main', h('span.row-sub', text)))));
      fill(ports, h('div.rows', h('div.row.static', h('span.row-main', h('span.row-sub', text)))));
      return;
    }
    const d = c.pc;
    fill(procs, h('div.cp-table.cp-procs', { role: 'table', 'aria-label': 'Programs' },
      h('div.cp-tr.cp-th', { role: 'row' }, h('span', { role: 'columnheader' }, 'Program'), h('span.cp-n', { role: 'columnheader' }, 'CPU'), h('span.cp-n', { role: 'columnheader' }, 'Memory'), h('span', { role: 'columnheader', 'aria-label': 'Stop' })),
      processList(d, sort).map((p) => h('div.cp-tr', { role: 'row' },
        h('span.cp-name', { role: 'cell' }, h('strong', p.name), h('span.muted', ` · ${p.pid}`), h('span.cp-args.mono', p.args)),
        h('span.cp-n', { role: 'cell', dataset: { label: 'CPU' } }, Number.isFinite(p.cpu) ? `${p.cpu.toFixed(1)}%` : '—'),
        h('span.cp-n', { role: 'cell', dataset: { label: 'Memory' } }, bytes(p.rss)),
        h('span.cp-act', { role: 'cell' }, stopBtn(p))))));
    fill(ports, d.ports.length
      ? h('div.cp-table.cp-ports', { role: 'table', 'aria-label': 'Listening ports' },
        h('div.cp-tr.cp-th', { role: 'row' }, h('span', { role: 'columnheader' }, 'Port'), h('span', { role: 'columnheader' }, 'Address'), h('span', { role: 'columnheader' }, 'Program')),
        d.ports.map((p) => h('div.cp-tr', { role: 'row' },
          h('span.cp-name', { role: 'cell' }, h('strong', String(p.port))),
          h('span', { role: 'cell', dataset: { label: 'Address' } }, p.addr),
          h('span', { role: 'cell', dataset: { label: 'Program' } }, p.process ? `${p.process} · ${p.pid}` : '—'))))
      : h('div.rows', h('div.row.static', h('span.row-main', h('span.row-sub', 'No program listens on a port.')))));
  }

  // ---- its name, test, remove ----
  const act = (ic, label, sub, fn, danger = false) => h(`button.row${danger ? '.cp-danger' : ''}`, { type: 'button', onclick: fn },
    h('span.row-icon', icon(ic)), h('span.row-main', h('span.row-title', label), h('span.row-sub', sub)), h('span.row-end', icon('chevronRight', { size: 18 })));
  const name = machine.current;
  const rename = act('pencil', 'Rename', 'The name shown on its sessions and in the list', async () => {
    const label = await promptSheet({ title: `Rename ${ctx.label()}`, text: 'How this computer is called next to the others.', value: ctx.label(), ok: 'Rename', check: (v) => (v.trim() && v.trim().length <= 40 ? '' : '1 to 40 characters') });
    if (!label) return;
    try {
      await api(name ? `~/api/machines/${name}/rename` : '~/api/machine/label', { label: label.trim() });
      fill(manageMsg, okBox(`Renamed to ${label.trim()}.`));
      store.refresh();
    } catch (e) {
      fill(manageMsg, errorBox(e.message));
    }
  });
  const test = act('refresh', 'Test the connection', 'Ask it now whether it answers', async () => {
    fill(manageMsg, h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', `Asking ${ctx.label()}…`)));
    try {
      const r = await api(`~/api/machines/${name}/test`, {});
      fill(manageMsg, r.machine.state === 'online' ? okBox(`${ctx.label()} answers.`) : errorBox(`${ctx.label()}: ${r.machine.error || MACHINE_STATE[r.machine.state]}. Check that it is on and ${APP_NAME} runs there, then test again.`));
      store.refresh();
      ctx.reload();
    } catch (e) {
      fill(manageMsg, errorBox(e.message));
    }
  });
  const remove = act('trash', 'Remove from this list', 'Its sessions are no longer shown here; nothing on it is stopped', async () => {
    if (!(await confirmSheet({ title: `Remove ${ctx.label()}?`, text: `${ctx.label()} and its sessions are no longer shown here. Nothing on that computer is stopped or deleted; this page only gives up its right to control it.`, ok: `Remove ${ctx.label()}`, danger: true }))) return;
    try {
      const r = await api(`~/api/machines/${name}/remove`, {});
      toast(r.revoked ? `${ctx.label()} removed` : `${ctx.label()} removed. ${r.note || ''}`, { ms: r.revoked ? 3500 : 8000 });
      store.refresh();
      location.hash = '#/computers';
    } catch (e) {
      fill(manageMsg, errorBox(e.message));
    }
  }, true);

  // ---- power: a confirmation that names the computer, then the answer on the page ----
  const powerBtn = (action, label) => btn('danger', { icon: 'power', label, onclick: async () => {
    const who = ctx.label();
    const n = (cache.get(keyOf())?.pc?.sessions || []).length;
    if (!(await confirmSheet({ title: `${label} ${who}?`, text: `${n ? `The ${n} session${n === 1 ? '' : 's'} on ${who} stop${n === 1 ? 's' : ''}` : `Everything running on ${who} stops`}${action === 'poweroff' ? `, and ${who} stays off until someone switches it on there` : ''}.`, ok: `${label} ${who}`, danger: true }))) {
      fill(powerMsg, h('p.hint', 'Nothing was done.'));
      return;
    }
    try {
      await api('/api/pc/power', { action, confirm: action });
      fill(powerMsg, okBox(`${who} accepted: it ${action === 'reboot' ? 'restarts' : 'shuts down'} now.`));
    } catch (e) {
      fill(powerMsg, errorBox(`${who} refused: ${e.message}.`));
    }
  } });

  ctx.onData(paint);
  paintSort();
  paint();
  return h('div.cp-part',
    section('Programs running', undefined, h('div.cp-bar', h('p.hint', 'The busiest and the largest. Only programs of your own user can be stopped.'), sortBar), procs),
    section('Listening ports', undefined, ports),
    section('This computer', undefined, h('div.rows', rename, name ? test : null, name ? remove : null), manageMsg),
    section('Power', undefined, h('p.hint', 'Restart or shut down the computer. Every session on it stops; you are asked first.'), h('div.savebar.start', powerBtn('reboot', 'Restart'), powerBtn('poweroff', 'Shut down')), powerMsg));
}

// ======================= the page =======================

function viewPc({ frame, connectionBanner, sub }) {
  store.viewing = null;
  const part = PARTS.find((p) => p.id === sub);
  if (!part) {
    location.replace(link('#/computer'));
    return () => {};
  }
  const label = () => ((store.all.find((m) => m.machine === machine.current) || {}).machineLabel) || machine.current || 'This computer';
  let alive = true;
  let timer = null;
  const listeners = [];
  const key = keyOf();
  const ctx = {
    label,
    connectionBanner,
    onData: (fn) => listeners.push(fn),
    reload: () => {
      refresh();
      if (part.id === '') facts();
    },
  };
  const tabs = tabBar('Parts of this page', PARTS.map((p) => ({ id: p.id, label: p.title, href: link(p.id ? `#/computer/${p.id}` : '#/computer') })), part.id);
  const content = part.id === 'setup' ? setupSection() : part.id === 'advanced' ? advanced(ctx) : overview(ctx);
  // A link back here names the part ("Setup"), and the computer once there are several.
  const place = () => (part.id ? (store.multi ? `${part.title} · ${label()}` : part.title) : label());
  const draw = () => frame({ title: label(), place: place(), page: 'computer', back: '#/computers', backLabel: 'Computers', intro: 'One computer: how it is doing, what is set up on it, and its controls.', body: [tabs, h('p.cp-parttext', part.text), content] });
  draw();
  const tell = () => listeners.forEach((fn) => fn());
  // The name may arrive after the first paint (and changes after Rename).
  let named = label();
  const unsubscribe = store.subscribe(() => {
    if (label() !== named) {
      named = label();
      draw();
    }
    if (alive) tell(); // the sessions' states come from the session poll
  });
  const set = (patch) => {
    cache.set(key, { ...(cache.get(key) || {}), ...patch });
    if (alive) tell();
  };

  async function refresh() {
    clearTimeout(timer);
    try {
      set({ pc: await api('/api/pc'), failed: null });
    } catch (e) {
      // Another computer that does not answer: its old figures would mislead, so they go.
      set(machine.current ? { pc: null, failed: e } : { failed: e });
    }
    if (alive) timer = setTimeout(refresh, document.visibilityState === 'visible' ? 5000 : 30000);
  }
  // The slower, rarer facts once per visit.
  async function facts() {
    computerInfo().then((info) => set({ info })).catch(() => {});
    api(at(machine.current, '/api/claude')).then((claude) => set({ claude })).catch(() => set({ claude: { installed: null } }));
    Promise.all([api('/api/settings'), api('/api/addons').catch(() => ({ addons: [] }))])
      .then(([s, a]) => set({ reach: reachOf(s, a.addons) }))
      .catch(() => set({ reach: { level: 'unknown', text: 'Its settings could not be read.' } }));
  }
  if (part.id !== 'setup') {
    refresh();
    if (part.id === '') facts();
  }
  return () => {
    alive = false;
    clearTimeout(timer);
    unsubscribe();
  };
}

registerPage({ id: 'computer', title: 'Computer', icon: 'cpu', navAs: 'computers', render: viewPc });
