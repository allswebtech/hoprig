// `hoprig get --list [--json]`: the catalogue. Every entry of the workspace map (each group's own repository, each
// project, the other repositories) with where it is checked out: on this computer (looked at on the disk) and on the
// others (from each computer's own file in the brain, ai_brain/computers/<label>.json, computer.mjs). Read only:
// nothing is fetched, nothing written. A computer that never wrote its file cannot be seen from here, and that is
// said.
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { asOf, machineNames, whoHas } from '../workspace/whohas.mjs';
import { bold, dim } from '../setup/ui.mjs';

/**
 * The catalogue, from the one reader of which computer has what (whohas.mjs). → { noMap?, entries: [{ kind, name, url,
 * here, on: [label], lastHere? }], computers: [{ label, hoprig, written, old, mine? }], unknown: [name], label, notes }
 */
export async function catalogue({ dir = workspaceDir(), projects = projectsIn(), machines } = {}) {
  const w = await whoHas({ dir, projects, machines: machines || (await machineNames()) });
  if (w.mapErrors) throw Object.assign(new Error(`the workspace map was refused: ${w.mapErrors.join('; ')}`), { status: 409 });
  const notes = w.computers.length && !w.unknown.length && !w.noMap ? ['a computer that never wrote its file in the brain cannot be seen from here', ...w.notes] : w.notes;
  return { ...(w.noMap ? { noMap: true } : {}), entries: w.entries, computers: w.computers.map((c) => ({ label: c.label, hoprig: c.hoprig, written: c.written, old: c.old, ...(c.mine ? { mine: true } : {}), ...(c.listedAs ? { listedAs: c.listedAs } : {}) })), ...(w.unjoined ? { unjoined: w.unjoined } : {}), unknown: w.unknown, label: w.label, notes };
}

/** The catalogue as a person reads it. */
export function printCatalogue(ui, c) {
  const kinds = [['project', 'Projects'], ['group', 'Groups\' own repositories'], ['other', 'Other repositories']];
  for (const [k, title] of kinds) {
    const list = c.entries.filter((e) => e.kind === k);
    if (!list.length) continue;
    ui.out(`\n${bold(title)}  ${dim(`${list.length}`)}`);
    const w = Math.min(40, Math.max(...list.map((e) => e.name.length)));
    for (const e of list) {
      const where = [e.here ? 'here' : '', ...e.on.filter((l) => !(e.here && l === c.label))].filter(Boolean).join(', ') || 'on no computer that reported';
      ui.line(e.here ? 'ok' : 'info', `${e.name.padEnd(w)}  ${where}${e.url ? dim(`  ${e.url}`) : dim('  not on a git server yet')}${k === 'project' && !e.here ? dim(`  (hoprig get ${e.name})`) : ''}`);
    }
  }
  if (c.computers.length) ui.note(`computers that reported: ${c.computers.map((x) => `${x.label}${x.mine ? ' (this one)' : ` (${asOf(x.written)}${x.old ? ', old' : ''})`} (Hoprig ${x.hoprig || 'unknown'})`).join(', ')}`);
  for (const n of c.notes) ui.note(n);
}
