// Every place a project can be on this computer, read from the map (groups.mjs has the rules): for the commands,
// the dashboard's routes and `hoprig get`, which used to take one projects folder. Without a map of version 2 the
// only place is the projects folder, exactly as before.
import fs from 'node:fs';
import path from 'node:path';
import { NAME_RE } from '../pcsetup/workspace.mjs';
import { placeDir, placesOf, safeFolders } from './groups.mjs';
import { LEAVES, leaves, leavesWords, myLinkCommand } from './inside.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { readMap } from './map.mjs';
import { pickProject, tidyFolder } from './mapcheck.mjs';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/;

/** The map of version 2 when there is one that passes the check, else null (a refused map: status says why). */
export function groupsMap(dir = workspaceDir()) {
  try {
    const m = readMap(dir);
    return m.map && m.map.version === 2 ? m.map : null;
  } catch {
    return null;
  }
}

/** The places here: [{ id, dir, members, group? }], the projects folder first. */
export const placesHere = ({ dir = workspaceDir(), projects = projectsIn(), map = groupsMap(dir) } = {}) => placesOf(map, { dir, projects });

/**
 * The project folders here in every place (groups.mjs safeFolders: a link a repository tracks is never followed).
 * → Promise<[folder]>
 */
export const projectsHere = async ({ dir = workspaceDir(), projects = projectsIn(), map = groupsMap(dir) } = {}) => (await safeFolders(map, { dir, projects })).folders;

/** The places, the folders in them that may be followed, and the links met (groups.mjs safeFolders). */
export const foldersHere = ({ dir = workspaceDir(), projects = projectsIn(), map = groupsMap(dir) } = {}) => safeFolders(map, { dir, projects });

/**
 * The folder of the project a command or a route names: <name> (the projects folder, or the one place that has a
 * project of that name) or <place>/<name>. A bare name in two places is refused with both choices.
 * → { root, ref, place, members }. Throws { status }.
 */
export async function projectDirFor(ref, { dir = workspaceDir(), projects = projectsIn(), map = groupsMap(dir) } = {}) {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.split('/').some((s) => s === '..' || s === '.')) throw fail(400, 'bad project name');
  const safe = await safeFolders(map, { dir, projects });
  const here = safe.folders.filter((f) => (f.members === 'group' ? !f.git : isGitRepo(f.dir)));
  let f;
  try {
    f = pickProject(here, ref, 'this computer'); // the one rule for every command, route and Tia (mapcheck.mjs)
  } catch (e) {
    if (e.status !== 404) throw e;
    // A folder of that name that is there but leads out through a link: not followed, which is not "no such project".
    const b = behindLink(safe.places, ref, { dir, projects });
    if (b) throw fail(409, `${ref}: not followed: ${leavesWords(b)}${b.what === LEAVES ? `; if it is yours:  ${myLinkCommand(b.path)}` : ''}`, { leaves: b });
    throw fail(404, 'no such project');
  }
  return { root: f.dir, ref: f.ref, place: f.place, members: f.members };
}

/** The link that leads out on the way to a folder named `ref` in a place here (the place or the folder itself), or null. */
function behindLink(places, ref, ctx) {
  const parts = ref.split('/');
  const name = parts.pop();
  const id = parts.join('/');
  for (const pl of places.filter((p) => (parts.length ? p.id === id : true))) {
    const folder = path.join(pl.dir, name);
    if (!fs.existsSync(folder) && !fs.lstatSync(folder, { throwIfNoEntry: false })) continue;
    const b = leaves(folder, folder, ctx);
    if (b) return b;
  }
  return null;
}

/**
 * The folder a new or fetched project goes into: the projects folder, or a place of the map (`in`). A held folder
 * whose members come with the group's repository is no place for a repository of its own. → { dir, place }
 */
export function targetPlace(typed, { dir = workspaceDir(), projects = projectsIn(), map = groupsMap(dir) } = {}) {
  const id = typed ? tidyFolder(typed) : typed; // what a person typed, written the map's one way
  if (!id) return { dir: projects, place: '' };
  const pl = placesOf(map, { dir, projects }).find((p) => p.id === id);
  if (!pl) throw fail(404, `"${String(id).slice(0, 100)}" is not a group or a held folder of the workspace map (hoprig workspace group add)`);
  if (pl.members === 'group') throw fail(400, `the members of ${id} come with the group's repository: make the folder in the group and commit it there`);
  return { dir: placeDir(id, { dir, projects }), place: id };
}

/** Is `name` free in that place? (a folder there, empty or not, takes the name) */
export const freeIn = (place, name) => NAME_RE.test(name) && !fs.existsSync(path.join(place.dir, name));
