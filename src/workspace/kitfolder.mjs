// The workspace's own folder that a kit makes together with its program: the PHP kit makes database/mysql when it
// installs MariaDB (kits.mjs: the kit's `folder`, an id of layout.mjs TREE). Only that folder, owner-only, exactly as
// `hoprig workspace setup` makes it (setup.mjs setUpFolder, through inside.mjs), never a file inside it, never when
// something is in its place. MariaDB's own data folder is not moved or changed: database/mysql is the workspace's
// place for this engine's dumps and local data, as database/postgresql is for PostgreSQL.
import path from 'node:path';
import { tilde } from '../paths.mjs';
import { workspaceStatus } from './layout.mjs';
import { setUpFolder } from './setup.mjs';

const folderOf = (kit) => (kit && typeof kit.folder === 'string' ? kit.folder : null);
const shown = (p) => `${tilde(p)}${path.sep}`;
const ENGINE_DATA = 'MariaDB keeps its own data where its package puts it';

/** What the kit would make, said before the one yes and in the dry run: [sentence]. Nothing is changed. */
export function kitFolderPlan(kit) {
  const id = folderOf(kit);
  if (!id) return [];
  const st = workspaceStatus();
  const f = st.exists && st.folders.find((x) => x.id === id);
  if (!f || f.kind !== 'missing') return [];
  return [`With MariaDB it also makes ${shown(f.path)}, the workspace's folder for this database's dumps and local data (only you can open it). ${ENGINE_DATA}.`];
}

/** Make the kit's folder when it is missing, after its program was installed: [{ ok, text }] (nothing when it is there). */
export async function makeKitFolders(kit) {
  const id = folderOf(kit);
  // A computer without a workspace gets none: the kit is about the program, the folder comes with `workspace setup`.
  if (!id || !workspaceStatus().exists) return [];
  try {
    const r = await setUpFolder(id);
    return [
      ...r.did.map((d) => ({ ok: true, text: `made ${d.path}${path.sep}: the workspace's folder for this database's dumps and local data (only you can open it)` })),
      ...r.left.filter((l) => l.why !== 'already there').map((l) => ({ ok: false, text: `${l.path}: ${l.why}` })),
    ];
  } catch (e) {
    return [{ ok: false, text: `the workspace's folder for this database was not made: ${e.message}` }];
  }
}
