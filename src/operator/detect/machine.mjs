// The computer itself: load above 1.5 per CPU, available memory under 10 %, a disk or the temporary folder at
// 85 % or more.
//
// Reads board.machine: { cpus, load1, memTotal, memAvailable, disks: [{ mount, usedPct }], tmp: { usedPct } }.

import { act, makeItem } from '../item.mjs';
import { num } from './util.mjs';
import { detectComputer } from './computer.mjs';
import { bytesWords } from '../mends.mjs';

export const LOAD_PER_CPU = 1.5;
export const MEM_FREE_PCT = 10;
export const DISK_PCT = 85;
// From this use on, and when Hoprig has old files of its own (board.machine.ownTemp, bytes), the item offers to clean them.
export const CLEAN_PCT = 90;

const GiB = 1024 ** 3;
const gb = (b) => `${(b / GiB).toFixed(1)} GB`;
// How the Start-elsewhere hold ends (operator/where-hold.mjs), said on the item while it stands.
const CALM_END = 'It ends once this computer has been calm for 10 minutes (2 hours at most)';

export function detectMachine(board, opts = {}) {
  const computers = detectComputer(board, opts);
  const m = board.machine;
  if (!m) return computers;
  const out = [...computers];
  // The keeper (src/keeper/keep.mjs) went back to an older version or gave up: one row, in its own words.
  if (m.keeper && typeof m.keeper.text === 'string') {
    out.push(makeItem({ kind: 'machine', cls: 'machine', subject: 'Hoprig start', state: m.keeper.kind, facts: [m.keeper.text], acts: [m.keeper.kind === 'rollback' ? act('open', { href: '#/settings/updates', label: 'Open Updates' }) : act('open', { href: '#/computer/health', label: 'Open Health' })], why: m.keeper.kind === 'rollback' ? 'Update again when you are ready.' : 'See what was tried, then restart.' }));
  }
  const tasks = act('open', { href: '#/desktop/tasks', label: 'Open Tasks' });
  const cpus = num(m.cpus);
  const load = num(m.load1);
  if (cpus && load != null && load / cpus > LOAD_PER_CPU) {
    // board.elsewhere: an allowed computer with room (operator/where-hold.mjs); its act holds only Tia's new starts.
    const to = board.elsewhere;
    const held = board.elsewhereHeld;
    // Each line fits its limit (item.mjs: a fact 100, the why 160) with the longest label he can give (40), so none is cut.
    out.push(makeItem({ kind: 'machine', cls: 'machine', subject: 'load', state: 'over', facts: [`load ${load.toFixed(1)} on ${cpus} CPUs (${(load / cpus).toFixed(1)} per CPU)`, `above ${LOAD_PER_CPU} per CPU everything slows down`, to ? `${to.label} has room for Tia's new work; nothing that runs moves` : held ? `Tia's new work starts on ${held.label} since ${held.since.slice(11, 16)} UTC` : null, held && !to ? CALM_END : null], acts: to ? [act('elsewhere', { label: `Start new work on ${to.label}` }), tasks] : [tasks], target: to ? { to: to.name, label: to.label } : null, why: to ? `Start new work on ${to.label} until this computer has been calm for 10 minutes (2 hours at most). Undo is under Computers.` : 'See which processes take the CPU.' }));
  }
  const total = num(m.memTotal);
  const avail = num(m.memAvailable);
  if (total && avail != null && (avail / total) * 100 < MEM_FREE_PCT) {
    out.push(makeItem({ kind: 'machine', cls: 'machine', subject: 'memory', state: 'low', facts: [`${gb(avail)} of ${gb(total)} available (${Math.round((avail / total) * 100)} %)`], acts: [tasks], why: 'See which processes hold the memory.' }));
  }
  const own = num(m.ownTemp) > 0 ? m.ownTemp : 0;
  const full = (place, pct) => {
    const clean = own > 0 && pct >= CLEAN_PCT;
    return makeItem({
      kind: 'machine', cls: 'machine', subject: place, state: ['full', clean], facts: [`${place} is ${Math.round(pct)} % full`, place === 'the temporary folder' ? 'tests and builds fail when it fills up' : null, clean ? `${bytesWords(own)} of it is Hoprig\'s own old files` : null],
      acts: clean ? [act('clean'), tasks] : [tasks], recommended: clean ? 'clean' : undefined, why: clean ? 'Hoprig removes only its own old logs and temporary folders, never your files.' : 'Free some room before work fails for it.',
      ...(clean ? { target: { clean: true } } : {}),
    });
  };
  for (const d of m.disks ?? []) if (num(d.usedPct) >= DISK_PCT) out.push(full(`disk ${d.mount}`, d.usedPct));
  if (num(m.tmp?.usedPct) >= DISK_PCT) out.push(full('the temporary folder', m.tmp.usedPct));
  return out;
}
