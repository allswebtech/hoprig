// The Task manager of a computer (GET /api/system/…, src/desktop/feature.mjs): its processes with the CPU they use
// now, their memory, user and command, sorted and filtered, and ending one (asked first; this dashboard and the
// programs it runs inside are never ended); and read-only panels for the CPU, the memory, the disks and the
// network (addresses, traffic, listening ports). Only the part in view asks the computer, and only while it can be
// seen: a minimised window asks nothing.
import { icon } from '../icons.js';
import { api, at, bytes, fill, h, openSheet, toast } from '../lib.js';
import { choice, duration, errorLine, errorText, filterField, meter, pct, poll, sortBy, table } from './native.js';

const PARTS = [['procs', 'Processes'], ['perf', 'Performance'], ['disks', 'Disks'], ['net', 'Network']];
const SHOW_MAX = 400; // rows drawn at once; the filter finds the rest
const HISTORY = 60; // CPU readings kept for the strip in Performance

export function mount(root, { machine }) {
  const call = (p, body) => api(at(machine, p), body);
  const view = h('div.dapp-view');
  let part = 'procs';
  let stopPart = () => {};
  const show = (p) => {
    stopPart();
    part = p;
    fill(view);
    stopPart = ({ procs: processes, perf: performance, disks, net: network })[part](view, call);
  };
  fill(root, h('div.dapp-bar', choice('Part', PARTS, part, show)), view);
  root.classList.add('dapp-tasks');
  show(part);
  return () => stopPart();
}

// ---------- processes ----------

function processes(view, call) {
  let list = [];
  let q = '';
  let failed = null;
  const status = h('span.dapp-status', { role: 'status' });
  const t = table('Processes', [
    { key: 'name', label: 'Name', w: 'minmax(120px, 1.2fr)', narrow: 'minmax(0, 1fr)' },
    { key: 'pid', label: 'PID', num: true, w: '72px', narrow: false },
    { key: 'user', label: 'User', w: 'minmax(70px, .6fr)', narrow: false },
    { key: 'cpu', label: 'CPU', num: true, w: '70px', narrow: '58px' },
    { key: 'rss', label: 'Memory', num: true, w: '86px', narrow: '74px' },
    { key: 'args', label: 'Command', w: 'minmax(160px, 2.4fr)', narrow: false },
    { key: 'end', label: '', sort: false, w: '44px', narrow: '36px' },
  ], { sort: { key: 'cpu', desc: true }, onSort: () => draw() });

  const endBtn = (p) => {
    if (p.guarded) return h('span.dapp-lock', { title: 'This dashboard, or a program it runs inside: it is not ended from here' }, icon('lock', { size: 14 }));
    if (p.mine === false) return h('span.dapp-lock', { title: 'Started by another user: it cannot be ended from here' }, icon('lock', { size: 14 }));
    return h('button.dapp-btn.dapp-end', { type: 'button', title: `End ${p.name}`, 'aria-label': `End ${p.name} (${p.pid})`, onclick: () => endIt(p) }, icon('x', { size: 14 }));
  };
  function draw() {
    const s = q.trim().toLowerCase();
    const found = s ? list.filter((p) => `${p.name} ${p.pid} ${p.user || ''} ${p.args}`.toLowerCase().includes(s)) : list;
    const rows = sortBy(found, t.sort.key, t.sort.desc).slice(0, SHOW_MAX);
    t.draw(rows.map((p) => ({
      key: p.pid,
      cls: p.guarded ? 'dapp-own' : null,
      cells: [h('span.dapp-strong', { title: p.name }, p.name), String(p.pid), p.user || '–', pct(p.cpu), bytes(p.rss), h('span.mono.dapp-cmd', { title: p.args }, p.args), endBtn(p)],
    })));
    status.textContent = failed ? '' : `${found.length} of ${list.length} processes${found.length > SHOW_MAX ? `, the first ${SHOW_MAX} shown` : ''}`;
  }
  const err = h('div');
  const p = poll(view, async () => {
    try {
      const r = await call('/api/system/processes');
      list = r.processes || [];
      failed = null;
      fill(err);
    } catch (e) {
      failed = e;
      fill(err, errorLine(e));
    }
    draw();
  }, 2500);

  async function endIt(proc) {
    const how = await openSheet({ title: `End ${proc.name}?`, subtitle: `Process ${proc.pid}${proc.user ? ` of ${proc.user}` : ''}` }, (close) => [
      h('p.sheet-text', 'It is asked to stop, the way closing it would. Work in it that is not saved can be lost. "Force" stops it at once, without asking; use that when it does not stop.'),
      h('p.sheet-text.mono.dapp-cmd-full', proc.args),
      h('div.sheet-actions',
        h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'),
        h('button.btn.secondary', { type: 'button', onclick: () => close('force') }, 'Force'),
        h('button.btn.danger', { type: 'button', autofocus: true, onclick: () => close('end') }, 'End it')),
    ]);
    if (!how) return;
    try {
      await call('/api/system/processes/end', { pid: proc.pid, force: how === 'force' });
      toast(`${proc.name} (${proc.pid}) was asked to stop.`);
      p.now();
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 7000 });
    }
  }

  fill(view, h('div.dapp-bar', filterField('Filter by name, command, user or PID', (v) => {
    q = v;
    draw();
  }), status), err, t.el);
  return () => (p.stop(), t.stop());
}

// ---------- performance ----------

function performance(view, call) {
  const history = [];
  const body = h('div.dapp-scroll');
  fill(view, body);
  const p = poll(view, async () => {
    let u;
    try {
      u = await call('/api/system/usage');
    } catch (e) {
      fill(body, errorLine(e));
      return;
    }
    history.push(u.cpu.total);
    if (history.length > HISTORY) history.shift();
    const mem = u.mem || {};
    const used = mem.total - mem.available;
    const swapUsed = mem.swapTotal ? mem.swapTotal - mem.swapFree : 0;
    fill(body,
      h('section.dapp-card',
        h('div.dapp-card-head', h('h3', 'CPU'), h('strong.dapp-big', pct(u.cpu.total)), h('span.hint', `${u.cpus} core${u.cpus === 1 ? '' : 's'}`)),
        h('div.dapp-strip', { 'aria-label': `The CPU over the last ${history.length * 2} seconds` }, history.map((v) => h('i', { style: { height: `${Math.max(2, v)}%` } }))),
        h('div.dapp-cores', u.cpu.cores.map((v, i) => h('div.dapp-core', { title: `Core ${i + 1}: ${pct(v)}` }, h('span.hint', String(i + 1)), meter(v / 100))))),
      h('section.dapp-card',
        h('div.dapp-card-head', h('h3', 'Memory'), h('strong.dapp-big', bytes(used)), h('span.hint', `of ${bytes(mem.total)} in use`)),
        meter(used / mem.total),
        mem.swapTotal ? h('p.hint', `Swap: ${bytes(swapUsed)} of ${bytes(mem.swapTotal)}`) : h('p.hint', 'No swap.')),
      h('section.dapp-card.dapp-facts',
        h('div', h('span.hint', 'Running for'), h('strong', duration(u.uptime))),
        u.load ? h('div', h('span.hint', 'Load (1, 5, 15 min)'), h('strong', u.load.map((n) => n.toFixed(2)).join('  '))) : null,
        h('div', h('span.hint', 'System'), h('strong', u.platform))));
  }, 2000);
  return () => p.stop();
}

// ---------- disks ----------

function disks(view, call) {
  const t = table('Disks', [
    { key: 'mount', label: 'Mounted at', w: 'minmax(140px, 1.6fr)', narrow: 'minmax(0, 1fr)' },
    { key: 'fs', label: 'Device', w: 'minmax(110px, 1fr)', narrow: false },
    { key: 'size', label: 'Size', num: true, w: '86px', narrow: '74px' },
    { key: 'used', label: 'Used', num: true, w: '86px', narrow: false },
    { key: 'avail', label: 'Free', num: true, w: '86px', narrow: '74px' },
    { key: 'share', label: 'Use', num: true, w: 'minmax(110px, 1fr)', narrow: '60px' },
  ], { sort: { key: 'mount', desc: false }, onSort: () => draw() });
  let list = [];
  const err = h('div');
  const draw = () => t.draw(sortBy(list.map((d) => ({ ...d, share: d.size ? d.used / d.size : 0 })), t.sort.key, t.sort.desc).map((d) => ({
    key: d.mount,
    cells: [h('span.dapp-strong', d.mount), h('span.mono', d.fs || '–'), bytes(d.size), bytes(d.used), bytes(d.avail), h('span.dapp-share', meter(d.share), pct(d.share * 100))],
  })));
  const p = poll(view, async () => {
    try {
      list = (await call('/api/system/disks')).disks || [];
      fill(err);
    } catch (e) {
      fill(err, errorLine(e));
    }
    draw();
  }, 10_000);
  fill(view, err, t.el);
  return () => (p.stop(), t.stop());
}

// ---------- network ----------

function network(view, call) {
  const ifaces = h('div.dapp-ifaces');
  const ports = table('Listening ports', [
    { key: 'port', label: 'Port', num: true, w: '80px', narrow: '56px' },
    { key: 'addr', label: 'Address', w: 'minmax(120px, 1fr)', narrow: 'minmax(0, 1fr)' },
    { key: 'process', label: 'Program', w: 'minmax(120px, 1fr)', narrow: 'minmax(0, 1fr)' },
    { key: 'pid', label: 'PID', num: true, w: '80px', narrow: false },
  ], { sort: { key: 'port', desc: false }, onSort: () => drawPorts() });
  let portList = [];
  const drawPorts = () => ports.draw(sortBy(portList, ports.sort.key, ports.sort.desc).map((x) => ({
    key: `${x.addr}:${x.port}`,
    cells: [h('span.dapp-strong', String(x.port)), h('span.mono', x.addr || '–'), x.process || '–', x.pid ? String(x.pid) : '–'],
  })));
  const rate = (n) => (Number.isFinite(n) ? `${bytes(n)}/s` : '–');
  const err = h('div');
  const p = poll(view, async () => {
    let r;
    try {
      r = await call('/api/system/network');
      fill(err);
    } catch (e) {
      fill(err, errorLine(e));
      return;
    }
    const shown = (r.interfaces || []).filter((x) => x.addresses.length || x.rxRate);
    fill(ifaces, shown.map((x) => h('section.dapp-card.dapp-iface',
      h('div.dapp-card-head', h('h3', x.name), x.addresses.some((a) => a.internal) ? h('span.badge.soft', 'this computer only') : null),
      h('div.dapp-facts',
        h('div', h('span.hint', 'In'), h('strong', rate(x.rxRate))),
        h('div', h('span.hint', 'Out'), h('strong', rate(x.txRate)))),
      x.addresses.length ? h('ul.dapp-addrs', x.addresses.map((a) => h('li', h('span.mono', a.address), h('span.hint', a.family)))) : null)));
    portList = r.ports || [];
    drawPorts();
  }, 3000);
  fill(view, h('div.dapp-scroll', err, ifaces, h('h3.dapp-sub', 'Listening ports'), ports.el));
  return () => (p.stop(), ports.stop());
}
