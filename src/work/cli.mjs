// hoprig tasks: the same list as the dashboard's Work page, from a terminal. Every command takes --json; the ones
// that change something take --dry-run (everything is checked, nothing is written).
import { loadConfig, saveConfig } from '../config.mjs';
import { tilde } from '../paths.mjs';
import { cleanSettings, projectNames, resolvePlace } from './place.mjs';
import { dropInterrupted, saveWork } from './save.mjs';
import { finishInterrupted } from './resume.mjs';
import { workStore } from './store.mjs';
import { rankItems, todayView } from './today.mjs';
import { CLOSED } from './model.mjs';
import { alterText } from './jsontext.mjs';
import { doCommand, runsCommand } from './clido.mjs';

export const USAGE = `usage: hoprig tasks [today]                      what needs you, this week, done lately
       hoprig tasks list [--all] [--project P] [--by me|ai|<role>]
       hoprig tasks add "<title>" [--date YYYY-MM-DD] [--project P] [--priority high|normal|low]
                         [--by me|ai|<role>] [--note "..."] [--kind task|deadline|gate|opportunity] [--approx]
       hoprig tasks edit <id> [--title "..."] [--date D|none] [--project P|none] [--priority P|none]
                         [--by W] [--note "..."|none] [--kind K] [--status open|doing|review|waiting|done|dropped]
       hoprig tasks done|open|drop <id>
       hoprig tasks remove <id>                      only one you added; one from a plan is dropped instead
       hoprig tasks owner [<id>]                      your id in a planning tool's file: shown, or set
       hoprig tasks fix-ids                           give tasks that share an id (two computers, one title) ids of their own
       hoprig tasks tidy [--dry-run] [--yes]          a file a change would alter (a hand edit): see the difference, write it once
       hoprig tasks do <id> [--project P] [--folder F] [--brief "..."] [--dry-run] [--yes]
                         a coding session does the task: started through the running dashboard, in the task's project
                         (or P) and its own folder (or F: one of its code repositories, code/<name>); it shows the brief
                         and starts on a yes (--yes: without asking)
       hoprig tasks runs [<id>]                       what the sessions did: their answers, commits and changed files
       hoprig tasks save [--seen <token> --decide "<task>=mine|theirs,..."] [--drop-interrupted]
                         commit the Work file by name and send it; a list changed on another computer too is merged
                         by task, and a task changed on both is yours to decide (the save prints the token of what it
                         showed you); --drop-interrupted drops the record of an interrupted save you have looked at
  Every command takes --json; the ones that change something take --dry-run.
  Where the data lives: Settings → Work in the dashboard (the AI brain's work/ folder by default).`;

const BOOLEANS = ['json', 'dry-run', 'all', 'approx', 'yes', 'drop-interrupted'];
const VALUES = ['date', 'project', 'priority', 'by', 'note', 'kind', 'title', 'status', 'decide', 'seen', 'folder', 'brief'];

/** "--key value", "--key=value", "--flag". Unknown options are an error, so a typo never passes silently. */
export function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--') || a === '--') {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOLEANS.includes(key)) {
      if (eq > 0) throw usage(`--${key} takes no value`);
      flags[key] = true;
    } else if (VALUES.includes(key)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) throw usage(`--${key} needs a value`);
      flags[key] = v;
    } else throw usage(`unknown option --${key}`);
  }
  return { flags, positional };
}
// The options each command understands; anything else is refused with a reason.
const ITEM = ['date', 'project', 'priority', 'by', 'note', 'kind', 'approx'];
const FLAGS_OF = {
  today: ['json'],
  list: ['json', 'all', 'project', 'by'],
  add: ['json', 'dry-run', ...ITEM],
  edit: ['json', 'dry-run', 'title', 'status', ...ITEM],
  done: ['json', 'dry-run'],
  open: ['json', 'dry-run'],
  drop: ['json', 'dry-run'],
  remove: ['json', 'dry-run'],
  save: ['json', 'dry-run', 'decide', 'seen', 'drop-interrupted'],
  tidy: ['json', 'dry-run', 'yes'],
  'fix-ids': ['json', 'dry-run'],
  owner: ['json'],
  do: ['json', 'dry-run', 'yes', 'project', 'folder', 'brief'],
  runs: ['json'],
};
const NOT_HERE = {
  'add status': 'add takes no --status: a new task is open; mark it after with hoprig tasks done <id> (or edit --status)',
  'add title': 'add takes its title as the word after add, not as --title: hoprig tasks add "Renew the domain"',
};
const usage = (message) => Object.assign(new Error(message), { status: 400, usage: true });

const orNone = (v) => (v === 'none' ? null : v);
/** The item fields given on the command line (undefined: not given). */
function fieldsOf(f, { edit = false } = {}) {
  const out = {};
  if (f.title !== undefined) out.title = f.title;
  if (f.date !== undefined) out.date = edit ? orNone(f.date) : f.date;
  if (f.project !== undefined) out.project = edit ? orNone(f.project) : f.project;
  if (f.priority !== undefined) out.priority = edit ? orNone(f.priority) : f.priority;
  if (f.note !== undefined) out.note = edit ? orNone(f.note) : f.note;
  if (f.by !== undefined) out.by = f.by;
  if (f.kind !== undefined) out.kind = f.kind;
  if (f.approx) out.approx = true;
  if (edit && f.status !== undefined) out.status = f.status;
  return out;
}

/** --decide "renew-the-domain=mine,key:updated=theirs": the names the save showed → "mine" | "theirs". */
function decisionsOf(text) {
  if (text === undefined) return {};
  const out = {};
  for (const part of String(text).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(.+)=(mine|theirs)$/.exec(part);
    if (!m) throw usage(`--decide takes <task>=mine|theirs, separated by commas ("${part.slice(0, 40)}" is not that)`);
    Object.defineProperty(out, m[1], { value: m[2], enumerable: true });
  }
  return out;
}

/** The token of a plan the owner was shown (--seen): the start of its file hash and of the server's commit. */
const seenOf = (p) => (p && p.hash && p.remote && p.remote.upstream ? `${p.hash.slice(0, 16)}.${p.remote.upstream.slice(0, 16)}` : null);
function expectOf(token) {
  const m = /^([0-9a-f]{16})\.([0-9a-f]{16})$/.exec(String(token));
  if (!m) throw usage('--seen takes the token the save printed with its conflicts (16 hex digits, a dot, 16 hex digits)');
  return { hash: m[1], upstream: m[2] };
}

/** What a save did or would do, for a terminal: the message, the file, the changes, and a merge's conflicts. */
function saveText(r) {
  const p = r.plan;
  const lines = [r.message];
  for (const f of p.files) lines.push(`  ${f.path} (${f.state})`);
  const m = p.remote && p.remote.mode === 'merge' ? p.remote : null;
  for (const x of m ? m.mine : p.changes) lines.push(`  ${m ? 'yours, ' : ''}${x.what}: ${x.title}`);
  if (m) for (const x of m.theirs) lines.push(`  from another computer, ${x.what}: ${x.title}`);
  if (m && m.conflicts.length) {
    lines.push('', `To decide: hoprig tasks save --seen ${seenOf(p)} --decide "<task>=mine,<task>=theirs"`);
    const one = (v) => (v === null ? 'removed' : v.text || `"${v.title}" ${v.status || ''}${v.date ? ` ${v.date}` : ''}`.trim());
    const show = (v) => (v && v.items ? (v.items.length ? v.items.map(one).join(' | ') : 'none') : one(v));
    for (const c of m.conflicts) lines.push(`  ${c.name}${c.decided ? ` (chosen: ${c.decided})` : ''}`, `    mine:   ${show(c.mine)}`, `    theirs: ${show(c.theirs)}`);
  }
  return lines.join('\n');
}

const when = (it) => (typeof it.days !== 'number' ? '' : it.days < 0 ? `${-it.days}d overdue` : it.days === 0 ? 'today' : `in ${it.days}d`);
/** One line of `work list`. */
export function itemLine(it) {
  const pri = it.priority === 'high' ? '!' : it.priority === 'low' ? '_' : ' ';
  return `${pri} ${(it.date || '').padEnd(10)}${it.approx ? '~' : ' '} ${when(it).padEnd(11)} ${it.status.padEnd(7)} ${it.by.padEnd(6)} ${(it.project || '').padEnd(14)} ${it.id.padEnd(28)} ${it.title}`;
}

/** A yes/no question on the terminal (only when both ends are one): resolves true for "y" or "yes". */
function askOnTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return async (question) => {
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(question)).trim());
    } finally {
      rl.close();
    }
  };
}

export async function main(args, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), cfg = null, places = {}, run, ask = askOnTerminal(), dashboard = null, fetchImpl } = {}) {
  const json = args.includes('--json');
  // A refusal: with --json one JSON object on standard output ({ ok: false, code, message }), else a line on standard
  // error; the same exit code either way (2: not understood, 1: refused or failed).
  const refuse = (e) => {
    const exit = e.status === 400 ? 2 : 1;
    const code = e.usage ? 'usage' : (e.details && e.details.code) || (typeof e.code === 'string' && /^[a-z][a-z-]+$/.test(e.code) ? e.code : exit === 2 ? 'bad-request' : 'refused');
    if (json) out(JSON.stringify({ ok: false, code, message: e.message }, null, 2));
    else err(`tasks: ${e.message}${e.usage ? `\n${USAGE}` : ''}`);
    return exit;
  };
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    return refuse(e);
  }
  const { flags, positional } = parsed;
  const [sub = 'today', id, ...extra] = positional;
  const dryRun = flags['dry-run'] === true;
  const show = (data, text) => out(json ? JSON.stringify(data, null, 2) : text);
  if (sub === 'help') {
    out(USAGE);
    return 0;
  }
  if (!Object.hasOwn(FLAGS_OF, sub)) return refuse(usage(`unknown command "${String(sub).slice(0, 40)}"`));
  // What a command does not understand is refused, never passed over in silence.
  for (const k of Object.keys(flags)) {
    if (FLAGS_OF[sub].includes(k)) continue;
    const why = NOT_HERE[`${sub} ${k}`] || (k === 'dry-run' ? '--dry-run is for the commands that change something'
      : ['done', 'open', 'drop', 'remove'].includes(sub) ? `${sub} takes only the id (--${k} is not for it)` : `${sub} takes no --${k}`);
    return refuse(usage(why));
  }
  try {
    const c = cfg || loadConfig();
    const place = resolvePlace(c, places);
    const store = workStore(place, { projects: projectNames(c, places) });
    const where = { label: place.label, file: tilde(place.file) };
    const o = { dryRun };
    const needsId = ['edit', 'done', 'open', 'drop', 'remove', 'do'].includes(sub);
    if (needsId && !id) throw usage(`${sub} needs the id of an item (hoprig tasks list shows them)`);
    if (sub === 'add' && !id) throw usage('add needs a title: hoprig tasks add "Renew the domain" --date 2026-12-01');
    if (extra.length || (['today', 'list', 'save', 'tidy', 'fix-ids'].includes(sub) && id)) throw usage('too many words: put a title or a note in quotes');
    const dry = dryRun ? ' (dry run: nothing written)' : '';
    // A save that was interrupted is finished (or shown) before the list is read or changed; save does it itself.
    if (sub === 'do') return await doCommand(id, flags, { show, refuse, out, ask: json ? null : ask, dashboard, ...(fetchImpl ? { fetchImpl } : {}) });
    if (sub === 'runs') return runsCommand(place, id, { show });
    if (sub !== 'save' && !dryRun) {
      const fin = await finishInterrupted(place, run ? { run } : {});
      if (fin.sentence || fin.code === 'interrupted') err(`tasks: ${fin.sentence || `${fin.problem.charAt(0).toUpperCase()}${fin.problem.slice(1)}.`}`);
    }

    if (sub === 'today') {
      const { items } = store.list();
      const t = todayView(items, store.today());
      const lines = [`Work: ${where.label} · today ${t.today}`, '', 'Needs you'];
      lines.push(...(t.needsYou.length ? t.needsYou.map((it) => `  ${it.title}  (${it.why})  [${it.id}]`) : ['  nothing in the next seven days']));
      if (t.toReview.length) lines.push('', 'To review (hoprig tasks runs <id>)', ...t.toReview.map((it) => `  ${it.title}  [${it.id}]`));
      lines.push('', 'This week');
      for (const d of t.week) for (const it of d.items) lines.push(`  ${d.date}  ${it.status === 'done' ? '✓ ' : ''}${it.title}  [${it.id}]`);
      if (!t.week.some((d) => d.items.length)) lines.push('  nothing dated');
      lines.push('', 'Done lately');
      lines.push(...(t.doneLately.length ? t.doneLately.map((it) => `  ${it.doneAt}  ${it.title}`) : ['  nothing yet']));
      lines.push('', 'Sessions that need an OK are on the dashboard\'s Today.');
      show({ place: where, ...t }, lines.join('\n'));
      return 0;
    }
    if (sub === 'list') {
      const { items } = store.list();
      const shown = rankItems(items.filter((it) => (flags.all || !CLOSED.has(it.status))
        && (!flags.project || it.project === flags.project) && (!flags.by || it.by === flags.by)));
      show({ place: where, today: store.today(), items: shown }, shown.length ? shown.map(itemLine).join('\n') : `tasks: nothing to show (${where.label})`);
      return 0;
    }
    if (sub === 'add') {
      const r = await store.add({ ...fieldsOf(flags), title: id }, o);
      show({ ...r, dryRun }, `Added ${r.item.id}${dry}`);
      return 0;
    }
    if (sub === 'edit') {
      const r = await store.edit(id, fieldsOf(flags, { edit: true }), o);
      show({ ...r, dryRun }, `${r.item.id} changed${dry}`);
      return 0;
    }
    if (['done', 'open', 'drop'].includes(sub)) {
      if (Object.keys(fieldsOf(flags, { edit: true })).length) throw usage(`${sub} takes only the id`);
      const r = await store.status(id, sub, o);
      show({ ...r, dryRun }, `${r.item.id}: ${r.before} → ${r.item.status}${dry}`);
      return 0;
    }
    if (sub === 'remove') {
      const r = await store.remove(id, o);
      show({ ...r, dryRun }, `Removed ${r.item.id}${dry}`);
      return 0;
    }
    if (sub === 'owner') {
      // Your id in a planning tool's file: shown, or set (the "ownerId" setting, as Settings → Work sets it).
      const { planner } = store.list();
      if (!id) {
        const line = `Your id in a planning file: ${place.settings.ownerId}${planner ? (planner.needsId ? ` (this file does not use it; it uses "${planner.suggested}" most: hoprig tasks owner ${planner.suggested || '<id>'})` : ' (this file uses it)') : ''}`;
        show({ ownerId: place.settings.ownerId, planner }, line);
        return 0;
      }
      const next = cleanSettings({ ownerId: id }, place.settings);
      if (!cfg) saveConfig({ work: { ...(c.work || {}), ownerId: next.ownerId } });
      show({ ownerId: next.ownerId }, `Your id in a planning file is now ${next.ownerId}.`);
      return 0;
    }
    if (sub === 'fix-ids') {
      const r = await store.fixIds(o);
      show({ ...r, dryRun }, r.fixed.length ? `${r.fixed.map((f) => `${f.from} → ${f.to}  ${f.title}`).join('\n')}${dry}` : 'No two tasks share an id: nothing to fix.');
      return 0;
    }
    if (sub === 'tidy') {
      // The command shows all of the difference, every line whole (the page shows a part and says so).
      const plan = store.tidyPlan({ full: true });
      if (!plan.alters.length) {
        show({ alters: [], written: false }, `The Work file (${where.label}) comes back as it is when written: nothing to tidy.`);
        return 0;
      }
      const text = [`Tidying ${where.label}/${place.fileName} once would change:`, ...plan.alters.map((a) => `  - ${alterText(a)}`), '',
        ...plan.diff.map((d) => (d.op === '…' ? `  …${d.text ? ` ${d.text}` : ''}` : `${d.op} ${String(d.line).padStart(4)}  ${d.text}`))].join('\n');
      const data = { alters: plan.alters.map((a) => ({ ...a, text: alterText(a) })), diff: plan.diff };
      if (dryRun) {
        show({ ...data, dryRun: true, written: false }, `${text}\n(dry run: nothing written)`);
        return 0;
      }
      if (!flags.yes) {
        if (json || !ask) throw usage('tidy writes only on a yes: look first with --dry-run, then add --yes');
        out(text);
        if (!(await ask('Write it? [y/N] '))) {
          out('Nothing written.');
          return 1;
        }
      }
      const r = await store.tidy(plan.hash);
      show({ ...data, written: r.written }, json ? '' : 'Tidied: the Work file is written in its own style once; changes work again.');
      return 0;
    }
    // save
    if (flags['drop-interrupted']) {
      if (flags.decide || flags.seen || dryRun) throw usage('--drop-interrupted is used alone');
      const dropped = await dropInterrupted(place, run ? { run } : {});
      show({ dropped }, dropped ? 'The record of the interrupted save is dropped: Save works again.' : 'There is no interrupted save to drop.');
      return 0;
    }
    // A choice is taken only on what the owner saw: when the file or the server moved since, the new plan is shown.
    if (flags.decide !== undefined && flags.seen === undefined) throw usage('--decide needs --seen <token>, the token the save printed with its conflicts, so that a choice never overrides a change you have not seen');
    const expect = flags.seen === undefined ? null : expectOf(flags.seen);
    const r = await saveWork(place, { subject: place.settings.saveSubject, dryRun, expect, decisions: decisionsOf(flags.decide), ...(run ? { run } : {}) });
    const seen = seenOf(r.plan);
    show({ ...r, ...(seen ? { seen } : {}) }, saveText(r));
    if (!json && r.detail) err(`  git: ${r.detail}`);
    return r.ok ? 0 : 1;
  } catch (e) {
    if (!e.status) throw e;
    return refuse(e);
  }
}
