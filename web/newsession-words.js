// New session's words for a folder (newsession.js): whether it is a project, how its row and its repositories read,
// and where a tap on it goes when something already works there.

/**
 * True when `dir` is outside the projects folder: not it, not inside it, and not one of the folders that hold it (the
 * home folder is no project to make). Either separator, so Windows paths too.
 */
export function outsideProjects(dir, projectsDir) {
  if (!projectsDir || !dir) return false;
  const norm = (x) => x.replace(/[\\/]+$/, '');
  const under = (a, b) => a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
  const root = norm(projectsDir);
  const d = norm(dir);
  return !under(d, root) && !under(root, d);
}

/**
 * The second line of a folder's row: its path only when it says something the name does not; none (null) when the
 * folder is simply <projects folder>/<name>, as most are ("project" under every row said nothing). `short` is the
 * "~/…" path, `projectsShort` the projects folder written the same way.
 */
export function folderSub(f, projectsShort) {
  const norm = (x) => String(x || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  if (projectsShort && norm(f.short) === `${norm(projectsShort)}/${f.name}`) return null;
  return f.short;
}

/** A repository of a project as a person names it: "bookshop-api", "in bookshop" (not "code/bookshop-api"). */
export function repoWords(rel, project) {
  if (!rel || rel === '.') return { name: project, sub: null }; // a project's own folder: its name says it
  const name = rel.split(/[\\/]/).filter(Boolean).pop() || rel;
  return { name, sub: project ? `in ${project}` : null };
}

/**
 * Rows of one name told apart: a project and a code folder of that name (shop, and code/shop in it) read the same, so
 * the project says what it is and the code folder says whose it is. Rows with a name of their own are left as they are.
 */
export function tellApart(rows) {
  const n = new Map();
  for (const r of rows) n.set(String(r.name).toLowerCase(), (n.get(String(r.name).toLowerCase()) || 0) + 1);
  return rows.map((r) => {
    if (n.get(String(r.name).toLowerCase()) < 2) return r;
    if (!r.sub) return { ...r, sub: 'The whole project' };
    return /^in /.test(r.sub) ? { ...r, sub: `Code ${r.sub}` } : r;
  });
}

/**
 * Where a tap on a recent folder goes when something already works there: the terminal session that runs in it, or
 * the chat at work in it (a second one there is what nobody tapping a "running" project means). Null: open a chat.
 */
export function runningIn(f) {
  if (!f || !f.live) return null;
  if (f.chat) return `#/chat/${f.chat}`;
  return f.session ? `#/s/${encodeURIComponent(f.session)}` : null;
}
