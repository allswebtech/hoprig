// The workspace as one step of `hoprig setup` and `hoprig pc setup`. On a new computer (no AI brain yet) it says in
// one sentence what it creates and asks once (default yes); where the brain is there already, it only reports.
import path from 'node:path';
import { showCommands } from '../setup/system.mjs';
import { bold } from '../setup/ui.mjs';
import { printSetup } from './cli.mjs';
import { workspaceLine, workspaceStatus } from './layout.mjs';
import { workspaceSetup } from './setup.mjs';

/** → { ok, changed } */
export async function runWorkspaceStep({ ui }) {
  ui.out(`\n${bold('Workspace')}`);
  const st = workspaceStatus();
  // New = no AI brain: a projects folder made earlier (pc setup asks for one) does not make a workspace.
  const fresh = st.folders.find((f) => f.id === 'ai_brain').kind === 'missing';
  if (!fresh) {
    const l = workspaceLine(st);
    ui.line(l.status, l.detail);
    if (l.fix) ui.note(`to change that: ${l.fix}`);
    // A brain that is not in git yet (its first commit waited for the git name and e-mail): in set-up's closing list.
    if (ui.todo && st.brain.exists && !st.brain.git) {
      const dir = path.join(st.dir, 'ai_brain');
      ui.todo('brainCommit', showCommands([['git', '-C', dir, 'init', '-b', 'main'], ['git', '-C', dir, 'add', '-A'], ['git', '-C', dir, 'commit', '-m', 'Start the AI brain']]));
    }
    return { ok: true, changed: false };
  }
  ui.out(`  Creates ${st.short} with ai_brain/ (AI knowledge for all projects, its own git repository), ${st.projectsInWorkspace ? 'projects/, ' : ''}credentials/ (only you can open it), development/, git/, database/postgresql/ and backups/; nothing else is changed.${st.projectsInWorkspace ? '' : ` Your projects stay in ${st.projectsShort}.`}`);
  if (!(await ui.confirm('Create the workspace?', true))) return { ok: true, changed: false };
  const r = await workspaceSetup();
  printSetup(ui, r);
  return { ok: true, changed: r.did.length > 0 };
}
