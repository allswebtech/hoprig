// The pull request of a session's branch, for the session rail's Changes card: "#12 title · Checks passing". Read with
// gh (the GitHub command line) in the session's folder, on the computer that runs the session; where gh is not
// installed, not signed in, or the branch has no pull request, there is no line. Nothing here runs by itself: the page
// asks after a turn ends and when the rail opens. The merge is the owner's own press behind a confirmation (the route
// in live.mjs refuses without it): others see a merge.
import { capture } from '../setup/system.mjs';
import { gitRead } from '../gitread.mjs';

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', GH_PAGER: 'cat' };
const TITLE_MAX = 200;

/** gh's statusCheckRollup → 'failing' (any failure), 'running' (any check not finished), 'passing', or null (none). */
export function checksOf(rollup) {
  const list = Array.isArray(rollup) ? rollup.filter((x) => x && typeof x === 'object') : [];
  if (!list.length) return null;
  let running = false;
  for (const c of list) {
    const result = String(c.conclusion || c.state || '').toUpperCase();
    if (FAILED.has(result)) return 'failing';
    // A check run says its status (QUEUED, IN_PROGRESS, COMPLETED); a commit status says its state (PENDING, SUCCESS).
    if ((c.status && String(c.status).toUpperCase() !== 'COMPLETED') || result === 'PENDING' || result === 'EXPECTED') running = true;
  }
  return running ? 'running' : 'passing';
}

const plain = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const webUrl = (u) => (/^https?:\/\/[^\s]+$/.test(String(u || '')) ? String(u).slice(0, 500) : null);

/**
 * { remote (the folder has a remote), ahead (commits not pushed; null: no upstream branch), gh (gh is there and
 * answered), pr: { number, title, url, checks } | null } of the open pull request of the folder's branch.
 * o.run: how a program is run (tests).
 */
export async function prState(dir, o = {}) {
  const run = o.run || capture;
  const git = (args) => (o.run ? o.run(['git', ...args], { cwd: dir }) : gitRead(dir, args));
  const [remote, ahead] = await Promise.all([git(['remote']), git(['rev-list', '--count', '@{upstream}..HEAD'])]);
  const out = { remote: remote.ok && remote.stdout.trim() !== '', ahead: ahead.ok && /^\d+$/.test(ahead.stdout.trim()) ? Number(ahead.stdout.trim()) : null, gh: false, pr: null };
  if (!out.remote) return out;
  const r = await run(['gh', 'pr', 'view', '--json', 'number,title,url,state,statusCheckRollup'], { cwd: dir, timeout: 20_000, env: { ...process.env, ...GH_ENV } });
  out.gh = r.ok || /no pull requests? found/i.test(r.stderr || '');
  if (!r.ok) return out;
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return out;
  }
  if (!j || j.state !== 'OPEN' || !Number.isInteger(j.number)) return out;
  out.pr = { number: j.number, title: plain(j.title, TITLE_MAX), url: webUrl(j.url), checks: checksOf(j.statusCheckRollup) };
  return out;
}

const firstLine = (r, say) => plain(String(r.stderr || r.stdout || '').split('\n').find((l) => l.trim()) || say, 300);
// GitHub states in which gh merges at once, with --auto too, because nothing required is waiting.
const AT_ONCE = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);

/**
 * Merge the pull request o.number (the one the owner saw and confirmed) when its checks pass (squash). Refused, with one
 * plain sentence, when the folder's branch has another pull request now, or when gh would merge it at once although
 * its checks run or fail (a repository without required checks: --auto does not wait there).
 * → { ok: true } | { ok: false, error }.
 */
export async function mergeWhenReady(dir, o = {}) {
  const run = o.run || capture;
  const opts = { cwd: dir, timeout: 30_000, env: { ...process.env, ...GH_ENV } };
  if (!Number.isInteger(o.number)) return { ok: false, error: 'the pull request was not named: look at the rail again' };
  const v = await run(['gh', 'pr', 'view', '--json', 'number,state,mergeStateStatus,statusCheckRollup'], opts);
  if (!v.ok) return { ok: false, error: firstLine(v, 'gh could not read the pull request') };
  let j = null;
  try {
    j = JSON.parse(v.stdout);
  } catch { /* an answer that is no JSON is refused below */ }
  if (!j || j.number !== o.number) return { ok: false, error: `the branch has another pull request now: #${o.number} was not merged, look at the rail again` };
  if (j.state !== 'OPEN') return { ok: false, error: `#${o.number} is not open any more` };
  const checks = checksOf(j.statusCheckRollup);
  if (AT_ONCE.has(j.mergeStateStatus) && (checks === 'running' || checks === 'failing')) {
    return { ok: false, error: `#${o.number} would be merged at once, because this repository does not require its checks, and they are ${checks === 'failing' ? 'failing' : 'still running'}: press Merge when they pass` };
  }
  const r = await run(['gh', 'pr', 'merge', String(o.number), '--auto', '--squash'], opts);
  if (r.ok) return { ok: true };
  return { ok: false, error: firstLine(r, 'gh could not merge it') };
}
