// New session's words for a folder (newsession.js): whether it is a project, how its row and its repositories read,
// where a tap on it goes when something already works there, and which provider it starts on when none is chosen.

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

/** A repository of a project as a person names it: "bookshop-api", "repository in bookshop" (not "code/bookshop-api"). */
export function repoWords(rel, project) {
  if (!rel || rel === '.') return { name: project, sub: null }; // a project's own folder: its name says it
  const name = rel.split(/[\\/]/).filter(Boolean).pop() || rel;
  return { name, sub: project ? `repository in ${project}` : 'repository' };
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

/**
 * The line under the Provider list when nothing is chosen and Auto mode is on, yet the session starts on another
 * provider because Auto mode's is slow or refusing now (the server's `autoSlow`, src/defaultprovider.mjs
 * fasterThanAuto). null otherwise.
 */
export function autoSlowLine(m, profiles) {
  const p = m && m.autoSlow && profiles.find((x) => x.name === m.recommended);
  return p ? `Auto mode's provider is slow now; this session starts on ${p.label}.` : null;
}

/**
 * What "nothing chosen" means, in the Provider list. The server decides per folder and coding tool
 * (src/defaultprovider.mjs): the provider that tool used last in that folder while it can work, else the computer's
 * default for it; Auto mode, when on, everywhere (Claude Code only). Once a folder is open (`dir`: Another folder,
 * its real path), its own default by name (`recommendedIn`). A chat first takes what the last chat in the project had
 * (`same`). Another tool's defaults are the computer's `toolDefaults[tool]`; an older computer has none: "the first
 * that serves it". `m`: the computer's state, `profiles`: the providers that serve the tool.
 */
export function defaultWords(m, profiles, same, tool = 'claude', dir = null) {
  const label = (n) => (profiles.find((p) => p.name === n) || {}).label;
  const d = !m ? null : tool === 'claude' ? m : m.toolDefaults && m.toolDefaults[tool];
  const rec = d && label(d.recommended);
  if (!rec) return same || (tool === 'claude' ? 'The default' : 'The first that serves it');
  const perFolder = d.recommendedIn && !(tool === 'claude' && m.autoSwitch && m.autoSwitch.enabled);
  const here = perFolder && dir ? label(d.recommendedIn[dir]) || rec : null;
  const folder = here || (perFolder ? `the one used last in the folder, else ${rec}` : rec);
  return same ? `${same}, else ${folder}` : `The default${here ? ' here' : ''}: ${folder}`;
}
