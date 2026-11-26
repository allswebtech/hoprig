// `hoprig workspace set --dir <folder> --projects <folder>`: change WHERE the workspace and the projects folder are
// for future work. Nothing is moved: files are a person's to move. The `mv` that would move them is shown.
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, saveConfig } from '../config.mjs';
import { tilde, workspaceEnvDir } from '../paths.mjs';
import { expandDir, rememberDir } from '../pcsetup/projects.mjs';
import { showFileCommand } from '../setup/system.mjs';
import { projectsIn, workspaceDir } from './layout.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** A folder a person typed: "~/x" or an absolute path, inside the home folder or not, never "..". */
function folderOf(v, what, home) {
  const d = expandDir(v, home);
  if (!d) throw fail(400, `${what}: give a full path or ~/… (no "..")`);
  if (fs.existsSync(d) && !fs.statSync(d).isDirectory()) throw fail(400, `${what}: ${tilde(d)} is a file`);
  return d;
}

/** → { changed: [{ what, from, to }], moves: ["mv …"], notes: [...] } */
export function setPlaces({ dir, projects } = {}, { save = saveConfig, load = loadConfig, home = os.homedir(), remember = rememberDir, platform = process.platform } = {}) {
  if (dir === undefined && projects === undefined) throw fail(400, 'say what to change: --dir <folder> and/or --projects <folder>');
  const cfg = load();
  const changed = [];
  const moves = [];
  const notes = [];
  const mv = (from, to) => {
    if (from !== to && fs.existsSync(from) && !fs.existsSync(to)) moves.push(showFileCommand('mv', [from, to], platform));
  };
  if (dir !== undefined) {
    const to = folderOf(dir, 'the workspace folder', home);
    const from = workspaceDir(cfg);
    if (from !== to) {
      save({ workspaceDir: to });
      changed.push({ what: 'workspace folder', from, to });
      mv(from, to);
    }
    if (workspaceEnvDir()) notes.push(`HOPRIG_WORKSPACE_DIR is set (${workspaceEnvDir()}): it wins over this setting while it is set`);
  }
  if (projects !== undefined) {
    const to = folderOf(projects, 'the projects folder', home);
    const from = projectsIn(cfg);
    if (from !== to) {
      remember(to);
      changed.push({ what: 'projects folder', from, to });
      mv(from, to);
    }
  }
  if (changed.length) notes.push('Nothing was moved. New projects, restore and sync use the new place from now on.');
  else notes.push('Nothing to change: that is where it is already.');
  return { changed: changed.map((c) => ({ ...c, from: tilde(c.from), to: tilde(c.to), fromPath: c.from, toPath: c.to })), moves, notes };
}

export const placesNow = () => ({ dir: workspaceDir(), projectsDir: projectsIn(), short: tilde(workspaceDir()), projectsShort: tilde(projectsIn()), env: workspaceEnvDir() ? 'HOPRIG_WORKSPACE_DIR' : null });
