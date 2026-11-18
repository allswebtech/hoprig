// `hoprig tasks do` and `hoprig tasks runs`: "Do it" from a terminal (cli.mjs dispatches here).
//   do <id> [--project P] [--folder F] [--brief "..."] [--dry-run] [--yes]   starts a run through the running
//        dashboard, which opens the session (the command token in Hoprig's state folder: dofeature.mjs); without a
//        running dashboard it says so. The brief is shown first and the run starts on a yes (or --yes), on that exact
//        brief: a task that changed meanwhile is refused
//   runs [<id>]                                                       the runs, newest first, read from the Work folder
import { runningDashboard } from '../server/dashboardfile.mjs';
import { COMMAND_HEADER, COMMAND_PATH, readCommandToken } from './dofeature.mjs';
import { listRuns, viewRun, writerId } from './runs.mjs';

const STATE_WORDS = { running: 'working', done: 'done', failed: 'failed', limit: 'at a limit', stopped: 'stopped' };

/** One run in a few lines, for a terminal. */
export function runText(r) {
  const where = r.folder === '.' ? r.project : `${r.project}/${r.folder}`;
  const lines = [`${r.id}  ${STATE_WORDS[r.state] || r.state}  ${r.item}  in ${where}  (${r.tool}, ${r.provider}${r.model ? `, ${r.model}` : ''})`];
  lines.push(`  started ${r.startedAt}${r.endedAt ? `, ended ${r.endedAt}` : ''}`);
  if (r.brief) lines.push('  brief:', ...r.brief.split('\n').map((l) => `  > ${l}`));
  if (r.reason) lines.push(`  ${r.reason}`);
  if (r.statusError) lines.push(`  ${r.statusError}`);
  for (const c of r.commits) lines.push(`  commit ${c.repo === '.' ? '' : `${c.repo} `}${c.short} ${c.subject}`);
  for (const f of r.changed) lines.push(`  ${f.kind.padEnd(8)} ${f.repo === '.' ? '' : `${f.repo}/`}${f.path}`);
  if (r.answer) lines.push('', ...r.answer.split('\n').map((l) => `  | ${l}`));
  return lines.join('\n');
}

/** `tasks runs [<id>]`. */
export function runsCommand(place, id, { show }) {
  const me = writerId();
  const runs = listRuns(place, id ? { item: id } : {}).map((r) => viewRun(r, me));
  show({ runs }, runs.length ? runs.map(runText).join('\n\n') : `No runs${id ? ` of ${id}` : ''} yet.`);
  return 0;
}

/**
 * `tasks do <id>`: through the dashboard that runs on this computer. The brief that would start is shown first, and the
 * run starts on a yes (`ask`, on a terminal) or --yes, naming that brief (seen): the dashboard refuses when the task
 * changed meanwhile. o: { dashboard (stand-in { host, port }), fetch } (tests). → exit code.
 */
export async function doCommand(id, flags, { show, refuse, out, ask = null, dashboard, fetchImpl = fetch }) {
  const d = dashboard || runningDashboard();
  const token = readCommandToken();
  if (!d || !token) return refuse(Object.assign(new Error('the dashboard is not running, and it is the dashboard that starts the session: start it with "hoprig serve" (or "hoprig service install"), then try again'), { status: 409, details: { code: 'no-dashboard' } }));
  const host = ['0.0.0.0', '::', ''].includes(d.host) ? '127.0.0.1' : d.host.includes(':') ? `[${d.host}]` : d.host;
  const choices = { id, ...(flags.project ? { project: flags.project } : {}), ...(flags.folder ? { folder: flags.folder } : {}), ...(flags.brief !== undefined ? { brief: flags.brief } : {}) };
  const post = async (body) => {
    let res;
    let data;
    try {
      res = await fetchImpl(`http://${host}:${d.port}${COMMAND_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [COMMAND_HEADER]: token }, body: JSON.stringify(body) });
      data = await res.json();
    } catch {
      return { no: refuse(Object.assign(new Error('the dashboard did not answer: is it running? (hoprig serve)'), { status: 409, details: { code: 'no-dashboard' } })) };
    }
    if (!res.ok) return { no: refuse(Object.assign(new Error(data.error || 'the dashboard refused it'), { status: res.status === 400 ? 400 : 409, details: { code: data.code || 'refused' } })) };
    return { data };
  };
  // What would start, with its exact brief: shown before anything starts.
  const look = await post({ ...choices, dryRun: true });
  if (look.no !== undefined) return look.no;
  const w = look.data.would;
  const what = `A session ${flags['dry-run'] ? 'would start' : 'starts'} in ${w.folder === '.' ? w.project : `${w.project}/${w.folder}`} (${w.tool}, ${w.provider}) with this brief:\n\n${w.brief.split('\n').map((l) => `  > ${l}`).join('\n')}`;
  if (flags['dry-run']) {
    show(look.data, `${what}\n\n(dry run: nothing started)`);
    return 0;
  }
  if (!flags.yes) {
    if (!ask) return refuse(Object.assign(new Error('do starts a session only on a yes: look at its brief first with --dry-run, then add --yes'), { status: 400, usage: true }));
    out(what);
    if (!(await ask('Start it? [y/N] '))) {
      out('Nothing started.');
      return 1;
    }
  }
  const go = await post({ ...choices, ...(flags.brief !== undefined ? {} : { seen: w.brief }) });
  if (go.no !== undefined) return go.no;
  const data = go.data;
  const r = data.run;
  const lead = data.existing ? `A session works on ${r.item} already: ${r.id}` : `Started ${r.id}: a session works on ${r.item}`;
  show(data, `${lead}. Open it on the dashboard (Work → Tasks), or see it with: hoprig tasks runs ${r.item}\n\n${runText(r)}`);
  return r.state === 'failed' ? 1 : 0;
}
