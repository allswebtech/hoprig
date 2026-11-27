// New session's words for a folder (newsession.js): whether it is a project, how its row reads, one row per project,
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

const underDir = (path, dir) => path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`);

/**
 * The rows of the popup: ONE row per project. A project's row is its own folder; a session that was started in one of
 * its code folders counts for it (once), and a row holds `dirs` (its folder and its code folders) so that Continue finds
 * every session that runs in them. A folder that is no project stays as it was opened. The code folders have no rows
 * (Another folder reaches one). `recent`: GET /api/folders/recent's folders, newest first; `workspaces`, `repos`: GET
 * /api/pcsetup/projects; `subOf(f)`: a plain folder's second line; `tilde`: a path written as ~/…
 * -> { recent: the newest `max` rows, more: the others A to Z }.
 */
export function projectRows({ recent, workspaces = [], repos = [], max = 5, subOf = () => null, tilde = (x) => x }) {
  const projects = workspaces.map((w) => ({ w, name: w.place ? w.id : w.name, dirs: [w.dir, ...(w.repos || []).filter((r) => r.rel !== '.' && r.dir).map((r) => r.dir)] }));
  const home = (f) => projects.find((p) => p.dirs.some((d) => underDir(f.path, d)));
  const seen = new Set();
  const all = [];
  for (const f of recent) {
    const p = home(f);
    const key = p ? p.w.dir : f.path;
    const mine = p ? recent.filter((x) => home(x) === p) : [f];
    if (seen.has(key)) continue;
    seen.add(key);
    if (!p) {
      all.push({ path: f.path, name: f.name, short: f.short, live: f.live, chat: f.chat, session: f.session });
      continue;
    }
    const exact = mine.find((x) => x.path === p.w.dir);
    const busy = mine.find((x) => x.live) || {};
    const short = exact ? exact.short : (mine[0].short || '').slice(0, Math.max(0, (mine[0].short || '').length - (mine[0].path.length - p.w.dir.length))) || tilde(p.w.dir);
    all.push({ path: p.w.dir, name: p.name, short, dirs: p.dirs, live: busy.live, chat: busy.chat, session: busy.session });
  }
  const newest = all.slice(0, max);
  const listed = new Set(newest.map((f) => f.path));
  const rest = [
    ...projects.map((p) => ({ path: p.w.dir, name: p.name, short: tilde(p.w.dir), dirs: p.dirs, sub: null })),
    ...repos.map((r) => ({ path: r.dir, name: r.place ? r.id : r.rel, short: tilde(r.dir), sub: null })),
    ...all.slice(max).filter((f) => !f.dirs).map((f) => ({ ...f, sub: subOf(f) })),
  ];
  const have = new Set();
  const more = rest.filter((f) => !listed.has(f.path) && !have.has(f.path) && have.add(f.path))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { recent: newest, more };
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
