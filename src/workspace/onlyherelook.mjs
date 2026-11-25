// Two looks of the workspace's upkeep that only read. Both are off until the owner turns them on (Settings →
// Workspace → By itself; `automation.workspace.onlyHere` and `.servers`):
//   only here  once a day: the check of "Before you format this computer" (leave.mjs) in its cheap form (no git
//              server is asked: what is said of servers is as of the last fetch), kept as COUNTS by kind. Never a
//              name or a path: the page shows those when the owner opens it.
//   servers    once a week: for each repository of the map that is on this computer and has a git server, whether
//              that server still has it and still calls its default branch what this computer last saw
//              (`git ls-remote --symref`, a read with the owner's own git sign-in, never asking for a password).
//              Nothing is fetched and nothing is written into a repository. Whether a server's history was replaced
//              cannot be told without a fetch, and is not said. A server that cannot be asked is "not looked",
//              never "fine".
// What they keep is one small file in Hoprig's state folder (workspace-looks.json), which doctor reads; the upkeep
// writes one line in Work → Activity when a look's answer changes, and tells the owner once per changed answer.
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../automation/store.mjs';
import { stateDir } from '../paths.mjs';
import { capture } from '../setup/system.mjs';
import { mapTargets } from './groups.mjs';
import { gitIn } from './inside.mjs';
import { projectsIn, workspaceDir } from './layout.mjs';
import { readMap } from './map.mjs';

export const lookFile = () => path.join(stateDir(), 'workspace-looks.json');
const MOST = 20; // names kept of a list

/** What the looks kept: { onlyHere?, servers? }; {} when there is nothing yet or the file cannot be read. */
export function readLooks(file = lookFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

function keep(part, value, file = lookFile()) {
  writeAtomic(file, { ...readLooks(file), [part]: value });
  return value;
}

// A kind of the check in plain words (leaveitems.mjs names the kinds); one it does not know is said by its name.
const KIND_WORDS = { work: 'not committed', branch: 'a branch not on its git server', noserver: 'no git server', folder: 'a folder in no git' };

/** The daily look. `check`: a stand-in for leaveCheck (tests). → { at, total, kinds: { kind: n }, asks, notChecked }. */
export async function lookOnlyHere({ check = null, now = () => Date.now(), file = lookFile() } = {}) {
  const r = await (check || (async () => (await import('./leave.mjs')).leaveCheck({ cheap: true })))();
  const kinds = {};
  for (const i of (r && r.items) || []) {
    const k = /^[a-z][a-zA-Z-]{0,30}$/.test(String(i && i.kind)) ? i.kind : 'other';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  return keep('onlyHere', { at: new Date(now()).toISOString(), total: count(r && r.items), kinds, asks: count(r && r.asks), notChecked: count(r && r.notChecked) }, file);
}

/** One sentence for what the daily look found, or '' when nothing is only here. Counts and kinds, never a name. */
export function onlyHereLine(r) {
  if (!r || !(r.total > 0)) return '';
  const parts = Object.keys(r.kinds || {}).sort().map((k) => `${r.kinds[k]} ${KIND_WORDS[k] || k}`);
  return `${r.total} thing${r.total > 1 ? 's exist' : ' exists'} only on this computer (${parts.join(', ')})`;
}

const GONE = /repository not found|not found|does not exist|does not appear to be a git repository|could not read from remote repository/i;

/**
 * The weekly look. `run`: capture's stand-in (tests). → { at, looked, gone: [label], renamed: [{ label, here, there }],
 * notLooked }. A repository with no git server is not this look's matter (the daily look counts it).
 */
export async function lookServers({ dir = workspaceDir(), projects = projectsIn(), run = capture, now = () => Date.now(), file = lookFile() } = {}) {
  const cur = readMap(dir);
  const out = { at: new Date(now()).toISOString(), looked: 0, gone: [], renamed: [], notLooked: 0 };
  if (!cur.exists || !cur.map) return keep('servers', out, file);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const t of await mapTargets(cur.map, { dir, projects })) {
    if (t.blocked) continue;
    let isRepo = false;
    try {
      isRepo = fs.lstatSync(path.join(t.dir, '.git')).isDirectory();
    } catch {
      /* not on this computer */
    }
    if (!isRepo) continue;
    // Every git call goes through the workspace's own door (inside.mjs): never outside the place the map names.
    const at = { root: t.root, dir, projects };
    const url = await gitIn(at, t.dir, ['remote', 'get-url', 'origin'], run, { env });
    if (!url.ok || !url.stdout.trim()) continue;
    const head = await gitIn(at, t.dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], run, { env });
    const here = head.ok ? head.stdout.trim().replace(/^origin\//, '') : '';
    const r = await gitIn(at, t.dir, ['ls-remote', '--symref', 'origin', 'HEAD'], run, { env, timeout: 30_000 });
    if (!r.ok) {
      if (GONE.test(r.stderr) && !/could not resolve host|timed out|connection|network/i.test(r.stderr) && out.gone.length < MOST) out.gone.push(t.label);
      else out.notLooked += 1;
      continue;
    }
    out.looked += 1;
    const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout);
    if (m && here && m[1] !== here && out.renamed.length < MOST) out.renamed.push({ label: t.label, here, there: m[1] });
  }
  return keep('servers', out, file);
}

/** One sentence for what the weekly look found, or '' when every server that was asked is as this computer saw it. */
export function serversLine(r) {
  if (!r) return '';
  const parts = [];
  if ((r.gone || []).length) parts.push(`${r.gone.length} repositor${r.gone.length > 1 ? 'ies are' : 'y is'} not seen on the git server any more (gone, or your sign-in there no longer reaches it): ${r.gone.join(', ')}`);
  for (const x of r.renamed || []) parts.push(`${x.label}: the server's default branch is ${x.there}, here it is ${x.here}`);
  return parts.join('; ');
}
