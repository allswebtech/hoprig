// The workspace as one step of `hoprig setup` and `hoprig pc setup`. On a new computer it says in one sentence
// what it creates and asks once (default yes); where any of the tree is there already, it only reports.
import { bold } from '../setup/ui.mjs';
import { printSetup } from './cli.mjs';
import { workspaceLine, workspaceStatus } from './layout.mjs';
import { workspaceSetup } from './setup.mjs';

/** → { ok, changed } */
export async function runWorkspaceStep({ ui }) {
  ui.out(`\n${bold('Workspace')}`);
  const st = workspaceStatus();
  const fresh = st.folders.every((f) => f.kind === 'missing');
  if (!fresh) {
    const l = workspaceLine(st);
    ui.line(l.status, l.detail);
    if (l.fix) ui.note(`to change that: ${l.fix}`);
    return { ok: true, changed: false };
  }
  ui.out(`  Creates ${st.short} with ai_brain/ (AI knowledge for all projects, its own git repository), ${st.projectsInWorkspace ? 'projects/, ' : ''}credentials/ (only you can open it), development/, git/, database/postgresql/ and backups/; nothing else is changed.${st.projectsInWorkspace ? '' : ` Your projects stay in ${st.projectsShort}.`}`);
  if (!(await ui.confirm('Create the workspace?', true))) return { ok: true, changed: false };
  const r = await workspaceSetup();
  printSetup(ui, r);
  return { ok: true, changed: r.did.length > 0 };
}
