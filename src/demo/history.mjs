// The demo's made-up history for Work → Activity (src/work/history.mjs): sessions of "you", of Tia and of a schedule
// in the made-up projects, a "Do it" run that made a commit, a run that failed, a commit of the owner's, a save of the
// Work list and a schedule that was missed. Written the product's own way (the session log, Work's run files, git,
// the automations' log) into the demo's temporary folders; nothing reaches a network or a real folder.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const H = 3_600_000;

/** A commit of `files` in repository `dir`, made `at` (epoch ms) by a made-up author. → its full id, or null. */
function commitAt(dir, files, subject, at) {
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const date = new Date(at).toISOString();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    git('add', '--', ...Object.keys(files));
    git('commit', '-q', '-m', subject, '--', ...Object.keys(files));
    return git('rev-parse', 'HEAD').trim();
  } catch {
    return null; // no git here: the history shows the rest
  }
}

/** Write the made-up history. `projects`: the demo's projects folder; `brain`: its AI brain. Never throws. */
export async function demoHistory({ projects, brain, now = Date.now() }) {
  try {
    const { stateDir } = await import('../paths.mjs');
    const { noteStart, noteEnd } = await import('../work/sessionlog.mjs');
    const { markHers } = await import('../hermark.mjs');
    const { createActivityLog } = await import('../automation/store.mjs');
    const { newRunId, writeRun, writerId } = await import('../work/runs.mjs');
    const { resolvePlace } = await import('../work/place.mjs');
    const st = stateDir();
    const file = (id) => path.join(st, 'runs', `${id}.json`);
    const session = (id, { at, minutes, project, profile, title, end = {}, term, hers = false }) => {
      const rec = { runId: id, profile, cwd: path.join(projects, project), tool: 'claude', startedAt: at, termName: term };
      if (hers) markHers(file(id));
      noteStart(file(id), rec, { now: at });
      noteEnd(file(id), { ...rec, title, ...end }, { now: at + minutes * 60_000 });
      if (hers) fs.rmSync(`${path.join(st, 'hook-settings', `${id}.json`)}.tia`, { force: true });
    };
    // Sessions: yours (one at a usage limit), Tia's, and one a schedule started (its line in the automations' log).
    session('demo-own-1', { at: now - 26 * H, minutes: 50, project: 'api-server', profile: 'max', title: 'Make the orders query fast again', term: 'api-server-1' });
    session('demo-own-2', { at: now - 5 * H, minutes: 35, project: 'shop-frontend', profile: 'max', title: 'Tidy the checkout styles', term: 'shop-frontend-1', end: { limit: { at: new Date(now - 4 * H).toISOString() } } });
    session('demo-tia-1', { at: now - 3 * H, minutes: 20, project: 'docs-site', profile: 'team', title: 'Check the links of the docs', term: 'docs-site-1', hers: true });
    const sched = now - 9 * H;
    session('demo-sch-1', { at: sched, minutes: 15, project: 'api-server', profile: 'auto', title: 'Morning dependency check', term: 'api-server-2' });
    const log = (at, e) => createActivityLog(path.join(st, 'automation.log'), { now: () => at }).add(e);
    log(sched, { automation: 'schedules', session: 'api-server-2', did: 'started "Morning dependency check"', outcome: 'ok' });
    log(now - 30 * H, { automation: 'schedules', did: 'missed "Evening test run" (due yesterday 18:00)', outcome: 'missed: the computer was off' });

    // A commit of yours, the commit a "Do it" run made, and a save of the Work list.
    commitAt(path.join(projects, 'mobile-app'), { 'CHANGELOG.md': '# Changes\n\n- The photo picker no longer crashes when it is closed.\n' }, 'Note the photo picker fix', now - 7 * H);
    const runCommit = commitAt(path.join(projects, 'shop-frontend'), { 'src/total.test.js': 'test("the total with a discount", () => {});\n' }, 'Add a test for the cart total', now - 2 * H);
    // Added to the list the demo's plan wrote before (demo/work.mjs), never over it: the plan keeps its tasks.
    let list = { items: [] };
    try {
      const had = JSON.parse(fs.readFileSync(path.join(brain, 'work', 'tasks.json'), 'utf8'));
      if (had && Array.isArray(had.items)) list = had;
    } catch {
      /* no list yet */
    }
    const ours = [
      { id: 'cart-total-test', date: null, title: 'Add a test for the cart total', kind: 'task', status: 'review', source: 'me', project: 'shop-frontend', by: 'ai' },
      { id: 'faster-images', date: null, title: 'Load the product images faster', kind: 'task', status: 'open', source: 'me', project: 'shop-frontend', by: 'ai' },
    ];
    list.items = [...list.items, ...ours.filter((x) => !list.items.some((y) => y && y.id === x.id))];
    commitAt(brain, { 'work/tasks.json': `${JSON.stringify(list, null, 2)}\n` }, 'Update work items', now - 90 * 60_000);

    // Work's runs: one done (it made the commit above), one that failed.
    const place = resolvePlace({});
    const run = (startedAt, minutes, x) => writeRun(place, {
      v: 1, id: newRunId(new Date(startedAt)), writer: writerId(), by: 'owner', startedAt: new Date(startedAt).toISOString(), endedAt: new Date(startedAt + minutes * 60_000).toISOString(),
      project: 'shop-frontend', folder: '.', tool: 'claude', provider: 'max', model: null, effort: null, session: null, conversation: null, message: null,
      reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null, ...x,
    });
    run(now - 2.5 * H, 25, { item: 'cart-total-test', title: 'Add a test for the cart total', brief: 'Add a test for the cart total', state: 'done',
      commits: runCommit ? [{ repo: '.', short: runCommit.slice(0, 7), subject: 'Add a test for the cart total' }] : [] });
    run(now - 60 * 60_000, 12, { item: 'faster-images', title: 'Load the product images faster', brief: 'Load the product images faster', state: 'failed', reason: 'the build failed after the change' });
  } catch {
    /* the demo shows what it could write */
  }
}
