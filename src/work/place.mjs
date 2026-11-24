// Where Work's files live, and Work's settings. One setting decides the folder ("Work data lives in"):
//   { place: 'brain' }                                  <workspace>/ai_brain/work (the default: the brain is on
//                                                       every computer of the owner)
//   { place: 'project', project: '<name>', path: 'a/b' }  a folder of a project of the workspace
// The folder is always inside the brain or inside that project: the path is a plain relative path (no "..", no
// dot-folder, no private folder), and the real folder (links followed) must still be inside, so a link cannot lead
// out. Checked again on every use, never only when the setting is saved.
//
// The settings are the "work" key of config.json:
//   place, project, path   above
//   saveSubject  the commit subject of a save                         default "Update work items"
//   timeZone     the zone dates are counted in ("" = this computer's)  default ""
//   ownerId      the owner's id in a planning tool's file (its `owner` and `source` words for "me")  default "me"
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { brainDir, listProjects, projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { ID_RE, PROJECT_RE, validZone } from './model.mjs';

export const DEFAULTS = Object.freeze({ place: 'brain', project: '', path: '', saveSubject: 'Update work items', timeZone: '', ownerId: 'me' });
export const BRAIN_FOLDER = 'work';
// The list file: Work's own name, or the planning tool's when the folder already has that one.
export const ITEMS_FILE = 'tasks.json';
export const PLANNER_FILE = 'deadlines.json';
const NEVER = new Set([...PRIVATE_DIRS, 'credentials', 'test-data', 'node_modules']);
const SEG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

const bad = (message, status = 400, code = null) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });

/** A relative folder path as the setting keeps it ("docs/plans"), or throws. */
export function cleanRel(p) {
  if (typeof p !== 'string' || !p.trim()) throw bad('give the folder inside the project, such as docs/plans');
  const parts = p.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').split('/');
  if (parts.length > 8) throw bad('that folder is too deep');
  for (const s of parts) {
    if (!SEG_RE.test(s) || s === '..' || s === '.') throw bad('the folder is a plain path inside the project: letters, digits, ".", "_" and "-", no ".." and no dot-folder');
    if (NEVER.has(s.toLowerCase())) throw bad(`"${s}" is a private folder: Work never keeps its files there`);
  }
  return parts.join('/');
}

/** Work's settings from config.json, with the defaults for anything missing or unreadable. */
export function workSettings(cfg = {}) {
  const w = cfg && typeof cfg.work === 'object' && cfg.work ? cfg.work : {};
  const out = { ...DEFAULTS };
  if (w.place === 'project' && typeof w.project === 'string' && PROJECT_RE.test(w.project)) {
    try {
      out.path = cleanRel(w.path);
      out.place = 'project';
      out.project = w.project;
    } catch {
      /* a broken setting: the default place, and resolvePlace below is never handed a bad path */
    }
  }
  if (typeof w.saveSubject === 'string' && w.saveSubject.trim()) out.saveSubject = w.saveSubject.trim();
  if (typeof w.timeZone === 'string' && validZone(w.timeZone)) out.timeZone = w.timeZone;
  if (typeof w.ownerId === 'string' && ID_RE.test(w.ownerId)) out.ownerId = w.ownerId;
  return out;
}

/** A settings change from the page or the command, checked strictly. → the clean "work" object to save. */
export function cleanSettings(input, current = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('the settings must be an object');
  for (const k of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, k)) throw bad(`"${String(k).slice(0, 30)}" is not a Work setting`);
  const next = { ...current, ...input };
  if (!['brain', 'project'].includes(next.place)) throw bad('Work data lives in the AI brain or in a project');
  if (next.place === 'project') {
    if (typeof next.project !== 'string' || !PROJECT_RE.test(next.project)) throw bad('name the project by its folder name');
    next.path = cleanRel(next.path);
  } else {
    next.project = '';
    next.path = '';
  }
  if (typeof next.saveSubject !== 'string' || !next.saveSubject.trim() || /[\r\n]/.test(next.saveSubject) || next.saveSubject.trim().length > 100) {
    throw bad('the commit subject is one line of up to 100 characters');
  }
  next.saveSubject = next.saveSubject.trim();
  if (typeof next.timeZone !== 'string' || !validZone(next.timeZone)) throw bad('that time zone is not known here (use a name such as Europe/Berlin, or leave it empty)');
  if (typeof next.ownerId !== 'string' || !ID_RE.test(next.ownerId)) throw bad('your id is lower-case letters, digits and "-"');
  return next;
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
/** The real path of `p`, also when its last parts do not exist yet (the nearest existing folder, links followed). */
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    const r = real(cur);
    if (r) return path.join(r, ...rest);
    const up = path.dirname(cur);
    if (up === cur) return null;
    rest.unshift(path.basename(cur));
    cur = up;
  }
}
const inside = (child, root) => child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * The Work folder for the settings: { kind, folder (real path), base (the brain or project folder), label
 * ("ai_brain/work", "<project>/docs/plans"), project?, file (the list file's full path), fileName }.
 * Throws (409) when the folder is not where it may be. `places`: { workspace, projects } for tests and the demo.
 */
export function resolvePlace(cfg = {}, places = {}) {
  const s = workSettings(cfg);
  const ws = places.workspace || workspaceDir(cfg);
  let base;
  let rel;
  let label;
  if (s.place === 'project') {
    const pdir = places.projects || projectsIn(cfg);
    const p = listProjects(pdir).find((x) => x.name === s.project);
    if (!p) throw bad(`Work data lives in the project "${s.project}", which is not in the workspace's projects folder: choose another place in Settings → Work`, 409, 'work-place-gone');
    base = p.dir;
    rel = s.path;
    label = `${s.project}/${s.path}`;
    // The project itself may be a link: it must still be inside the workspace (or the projects folder in use).
    const rp = real(base);
    if (!rp || ![real(ws), real(pdir)].some((r) => r && inside(rp, r))) throw bad(`the project "${s.project}" leads out of the workspace (a link): Work does not follow it`, 409);
  } else {
    base = brainDir(ws);
    rel = BRAIN_FOLDER;
    label = `ai_brain/${BRAIN_FOLDER}`;
    if (!real(base)) throw bad('there is no AI brain in the workspace yet, so Work cannot keep its list there. Set one up on the AI brain page, or choose "A project" under Settings → Work.', 409, 'no-workspace');
  }
  const realBase = real(base);
  if (!realBase) throw bad(`${label}: its folder is not there`, 409);
  const nominal = path.join(base, ...rel.split('/'));
  let link = false;
  try {
    link = fs.lstatSync(nominal).isSymbolicLink();
  } catch {
    /* not there yet */
  }
  if (link && !real(nominal)) throw bad(`${label} is a link that leads nowhere: Work leaves it alone`, 409);
  const folder = realish(nominal);
  if (!folder || !inside(folder, realBase) || folder === realBase) throw bad(`${label} leads out of its ${s.place === 'project' ? 'project' : 'AI brain'} (a link): Work does not follow it`, 409);
  if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory()) throw bad(`${label} is a file, not a folder`, 409);
  const fileName = !fs.existsSync(path.join(folder, ITEMS_FILE)) && fs.existsSync(path.join(folder, PLANNER_FILE)) ? PLANNER_FILE : ITEMS_FILE;
  const file = path.join(folder, fileName);
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    /* not made yet */
  }
  if (st && !st.isFile()) throw bad(`${label}/${fileName} is not a plain file (a link or a folder): Work leaves it alone`, 409);
  return { kind: s.place, folder, base: realBase, label, ...(s.place === 'project' ? { project: s.project } : {}), file, fileName, settings: s };
}

/** The projects of the workspace, by name (what an item's project may be). */
export const projectNames = (cfg = {}, places = {}) => listProjects(places.projects || projectsIn(cfg)).map((p) => p.name);
