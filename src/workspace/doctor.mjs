// The workspace in `hoprig doctor`: the tree in one line, the AI brain's git server (and whether it is in step with
// it, as of the last fetch: the doctor does not fetch), and whether the map matches what is on this computer. git's
// name and e-mail and the GitHub sign-in are the doctor's GitHub lines already (pcsetup/status.mjs).
import path from 'node:path';
import { repoInfo } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { isGitRepo, workspaceLine, workspaceStatus } from './layout.mjs';
import { mapStatus } from './map.mjs';

const check = (id, label, status, detail, fix = '') => ({ id, label, status, detail, fix });

/** → [{ id, label, status, detail, fix }] */
export async function workspaceChecks({ run = capture } = {}) {
  const st = workspaceStatus();
  const out = [{ id: 'workspace', label: 'Workspace', ...workspaceLine(st) }];
  const brain = path.join(st.dir, 'ai_brain');
  if (!isGitRepo(brain)) return out;
  const r = await run(['git', '-C', brain, 'config', '--get', 'remote.origin.url'], { timeout: 10_000 });
  if (!r.ok) out.push(check('workspace-brain', 'AI brain', 'warn', 'not on a git server yet: other computers cannot get it', 'hoprig workspace git   (GitHub), or: git -C <brain> remote add origin <address> && git -C <brain> push -u origin HEAD'));
  else {
    const s = await repoInfo(brain, run);
    const parts = s.ok ? [s.ahead ? `${s.ahead} to push` : '', s.behind ? `${s.behind} to pull` : '', s.changes ? `${s.changes} not committed` : '', s.upstream ? '' : 'no upstream'].filter(Boolean) : [s.error];
    out.push(check('workspace-brain', 'AI brain', parts.length ? 'warn' : 'ok', `on a git server${parts.length ? `: ${parts.join(', ')}` : ', in step (as of the last fetch)'}`, parts.length ? 'hoprig workspace sync' : ''));
  }
  const ms = await mapStatus({ dir: st.dir, projects: st.projectsDir, run });
  if (ms.errors) out.push(check('workspace-map', 'Workspace map', 'fail', `refused: ${ms.errors[0]}`, 'fix ai_brain/workspace.json, or: hoprig workspace map'));
  else if (!ms.exists) out.push(check('workspace-map', 'Workspace map', 'info', 'none yet: a new computer could not get your repositories from it', 'hoprig workspace map'));
  else {
    const c = ms.counts;
    const off = [c.missing ? `${c.missing} not on this computer` : '', c.unmapped ? `${c.unmapped} not in the map` : '', c.different ? `${c.different} different here` : ''].filter(Boolean);
    out.push(check('workspace-map', 'Workspace map', off.length ? 'warn' : 'ok', off.length ? off.join(', ') : `matches this computer (${c.here || 0} repositories)`, c.unmapped ? 'hoprig workspace map' : c.missing ? 'hoprig workspace restore <brain address>' : ''));
  }
  return out;
}
