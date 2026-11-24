// `hoprig field`: this computer's field reports, one of them whole, the developers' inbox, and a session's way round.
//
//   hoprig field [--json]                         this computer's reports, newest first
//   hoprig field show <id> [--json]               one report whole: exactly the file that would be sent
//   hoprig field inbox <folder> [--json]          reports that arrived as files, joined by their signature
//   hoprig field way-round --failed "<text>" --worked "<text>"
//                                                 a session's two lines: a draft in Skills → Learned, never a report
import path from 'node:path';
import { inboxText, readInbox } from './inbox.mjs';
import { findReport, listReports } from './report.mjs';
import { makeWayRound } from './wayround.mjs';

export const USAGE = `usage:
  hoprig field [--json]                      this computer's field reports, newest first
  hoprig field show <id> [--json]            one report whole (exactly what would be sent)
  hoprig field inbox <folder> [--json]       reports that arrived as files, joined and counted
  hoprig field way-round --failed "<what failed>" --worked "<what worked>"
                                             for a coding session: what needed a way round, as a skill draft
                                             the owner installs or discards in Skills → Learned
Field reports: docs/FIELD-REPORTS.md`;

/** --name value pairs and plain words; a flag given twice or without its value is an error. */
function parse(args, valued = []) {
  const out = { _: [], json: false, errors: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (valued.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) out.errors.push(`${a} needs its text`);
      else if (out[a.slice(2)] !== undefined) out.errors.push(`${a} is given twice`);
      else out[a.slice(2)] = v;
      i++;
    } else if (a.startsWith('-')) out.errors.push(`there is no option ${a}`);
    else out._.push(a);
  }
  return out;
}

const line = (r) => `${r.time.replace('T', ' ').slice(0, 16)}  ${r.id}  ${r.kind.padEnd(8)}  ${r.outcome === 'ok' ? 'ok' : `failed: ${r.class}`}  (${r.seconds} s)`;

export async function main(args = [], { write = (s) => process.stdout.write(s), error = (s) => process.stderr.write(s) } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    write(`${USAGE}\n`);
    return 0;
  }
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--json' || sub === 'list') {
    const o = parse(sub === 'list' ? rest : args);
    if (o.errors.length || o._.length) return (error(`${o.errors.concat(o._.map((w) => `"${w}" is not a word of this command`)).join('; ')}\n${USAGE}\n`), 2);
    const { reports, notRead } = listReports();
    if (o.json) write(`${JSON.stringify({ reports: reports.map((x) => x.report), notRead }, null, 2)}\n`);
    else if (!reports.length) write(`No field reports on this computer yet.${notRead ? ` (${notRead} file${notRead > 1 ? 's' : ''} in the folder ${notRead > 1 ? 'are' : 'is'} not a report and ${notRead > 1 ? 'are' : 'is'} not read.)` : ''}\n`);
    else write(`${reports.map((x) => line(x.report)).join('\n')}\n${notRead ? `(${notRead} file${notRead > 1 ? 's' : ''} not read: not exactly a report)\n` : ''}See one whole: hoprig field show <id>\n`);
    return 0;
  }
  if (sub === 'show') {
    const o = parse(rest);
    if (o.errors.length || o._.length !== 1) return (error(`${USAGE}\n`), 2);
    const found = findReport(o._[0]);
    if (!found) return (error(`There is no report "${o._[0].slice(0, 40)}" on this computer (hoprig field lists them).\n`), 1);
    write(o.json ? `${JSON.stringify(found.report, null, 2)}\n` : found.text);
    return 0;
  }
  if (sub === 'inbox') {
    const o = parse(rest);
    if (o.errors.length || o._.length !== 1) return (error(`${USAGE}\n`), 2);
    let inbox;
    try {
      inbox = readInbox(path.resolve(o._[0]));
    } catch (e) {
      return (error(`${e.message}: give the folder the reports arrived in.\n`), 1);
    }
    write(o.json ? `${JSON.stringify(inbox, null, 2)}\n` : inboxText(inbox));
    return 0;
  }
  if (sub === 'way-round') {
    const o = parse(rest, ['--failed', '--worked']);
    if (o.errors.length || o._.length || o.failed === undefined || o.worked === undefined) {
      return (error(`${o.errors.length ? `${o.errors.join('; ')}\n` : ''}${USAGE}\n`), 2);
    }
    try {
      const d = makeWayRound(o.failed, o.worked, { trigger: 'session' });
      if (o.json) write(`${JSON.stringify({ draft: d.id, risky: d.risky })}\n`);
      else write(d.risky
        ? 'The draft was made, but its scan marks it risky, so it cannot be installed. The owner sees it in Skills → Learned.\n'
        : 'Thank you: the two lines wait as a draft in Skills → Learned. The owner installs or discards it; nothing is used before that.\n');
      return 0;
    } catch (e) {
      error(`${e.message}\n`);
      return e.status === 409 ? 1 : 2;
    }
  }
  error(`${USAGE}\n`);
  return 2;
}
