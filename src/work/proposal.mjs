// "Plan with AI": what a planning session is asked (firstMessage) and how its answer becomes a PROPOSAL (parseAnswer).
// Pure: no files, no sessions here (planai.mjs runs the session, planaccept.mjs writes an accepted proposal).
//
// The answer is data, never instructions: the session's last message holds one fenced block of JSON in one strict
// shape, and every part of it is checked here before the page shows any of it:
//   { title, goal, projects?, note, milestones: [{ title, date }], tasks: [{ title, date, milestone, by, after, brief,
//     check, project? }] }        (milestone and after: positions, 1 for the first, as a person counts)
// Limits for the whole and for each part; dates that are dates; projects of the workspace; at most TASKS_MAX tasks; every
// text through the check a brief of "Do it" has (characters that cannot be seen are refused: "take it out"); a note that
// is plain Markdown with links only to http and https addresses (plans.mjs checkNoteText). What does not pass is
// refused with the reason, and the session's answer stays readable as text beside it.
//
// The proposal as Work keeps it counts from 0: { title, goal, projects, note, milestones: [{ title, date }], tasks:
// [{ title, date, milestone (index or null), by, after: [index], brief, check, project }] }. The page sends it back the
// same way when the owner accepts, changed (a title, a date, who does it, a task or a milestone taken out); it is
// checked again then (checkProposal).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTree } from './jsontext.mjs';
import { BRIEF_MAX, checkBrief, checkBy, isYmd } from './model.mjs';
import { AFTER_MAX, MILESTONES_MAX, NOTE_MAX, PROJECTS_MAX, checkNoteText, cleanGoal, cleanTitle, plainText, ringIn } from './plans.mjs';

export const ANSWER_MAX = 200_000; // characters of a whole answer
export const BLOCK_MAX = 120_000; // characters of its JSON block
export const TASKS_MAX = 60;
export const CHECK_MAX = 300;
const TOP = ['title', 'goal', 'projects', 'note', 'milestones', 'tasks'];
const TASK = ['title', 'date', 'milestone', 'by', 'after', 'brief', 'check', 'project'];

const bad = (message, code) => Object.assign(new Error(message), { status: 400, details: { code } });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysOf = (o, allowed, what) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(`${what} has a key "${String(k).slice(0, 30)}" the shape does not have`, 'shape');
};
/** A check of model.mjs or plans.mjs, its refusal kept with a code the page can tell apart. */
const as = (fn, code) => {
  try {
    return fn();
  } catch (e) {
    throw bad(e.message, (e.details && e.details.code) || code);
  }
};

/** The last fenced block of JSON in an answer: its text, or null. */
export function jsonBlock(answer) {
  let last = null;
  for (const m of String(answer).matchAll(/^[ \t]*(`{3,}|~{3,})[ \t]*json\b[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/gim)) last = m[2];
  return last;
}

/**
 * A planning session's answer as a proposal, checked strictly. ctx: { projects (the workspace's), project (the one the
 * owner chose), also (the others he named) }. → the proposal (counting from 0); throws 400 with the reason and a code:
 * too-big, no-block, json, shape, date, project, too-many, hidden, html, fence, image, link, ring, text.
 */
export function parseAnswer(answer, ctx) {
  if (typeof answer !== 'string' || !answer.trim()) throw bad('the session gave no answer', 'no-block');
  if (answer.length > ANSWER_MAX) throw bad(`the answer is more than ${ANSWER_MAX.toLocaleString('en')} characters`, 'too-big');
  const block = jsonBlock(answer);
  // Plain words for the owner; the answer itself is shown below them as text.
  if (block === null) throw bad('the session did not answer with a plan in the shape Hoprig reads (it has no block of JSON with the plan)', 'no-block');
  if (block.length > BLOCK_MAX) throw bad(`the plan's JSON is more than ${BLOCK_MAX.toLocaleString('en')} characters`, 'too-big');
  let raw;
  try {
    raw = JSON.parse(block);
  } catch {
    throw bad('the plan\'s block is not valid JSON', 'json');
  }
  if (!isObj(raw)) throw bad('the plan is not a JSON object', 'shape');
  // A key written twice: JSON.parse keeps the last, another reader may show the first. Refused, so that what the page
  // shows is the only reading there is.
  let twice = null;
  try {
    twice = readTree(block).notes.find((n) => n.kind === 'key');
  } catch {
    throw bad('the plan\'s block is nested deeper than a plan is', 'json');
  }
  if (twice) throw bad(`the plan has the key "${String(twice.path).slice(0, 60)}" written twice`, 'shape');
  keysOf(raw, TOP, 'the plan');
  // Positions as the session writes them (1 for the first) become indexes; anything else is refused by checkProposal.
  const pos = (v, what) => {
    if (v === null || v === undefined) return null;
    if (!Number.isInteger(v)) throw bad(`${what} is a number of the list (1 for the first)`, 'shape');
    return v - 1;
  };
  if (!Array.isArray(raw.tasks)) throw bad('the plan has no list of tasks', 'shape');
  if (raw.milestones !== undefined && !Array.isArray(raw.milestones)) throw bad('the milestones are a list', 'shape');
  const p = {
    title: raw.title,
    goal: raw.goal,
    projects: raw.projects === undefined ? [ctx.project, ...(ctx.also || [])] : raw.projects,
    note: raw.note === undefined || raw.note === null ? '' : raw.note,
    milestones: raw.milestones || [],
    tasks: raw.tasks.map((t, i) => {
      if (!isObj(t)) throw bad(`task ${i + 1} is not an object`, 'shape');
      keysOf(t, TASK, `task ${i + 1}`);
      if (t.after !== undefined && t.after !== null && !Array.isArray(t.after)) throw bad(`task ${i + 1}: after is a list of task numbers`, 'shape');
      return {
        title: t.title,
        date: t.date === undefined ? null : t.date,
        milestone: pos(t.milestone, `task ${i + 1}'s milestone`),
        by: t.by === undefined ? 'ai' : t.by,
        after: (t.after || []).map((a) => pos(a, `a task task ${i + 1} waits for`)),
        brief: t.brief === undefined ? null : t.brief,
        check: t.check === undefined ? null : t.check,
        project: t.project === undefined ? null : t.project,
      };
    }),
  };
  return checkProposal(p, ctx);
}

/**
 * A proposal (counting from 0), checked strictly: the one parseAnswer made, or the one the page sends back on Accept.
 * → a clean copy (texts trimmed, a brief that is only the title left out). ctx: { projects }.
 */
export function checkProposal(p, ctx) {
  if (!isObj(p)) throw bad('the proposal is not an object', 'shape');
  keysOf(p, TOP, 'the proposal');
  const title = as(() => cleanTitle(p.title, 'plan\'s title'), 'text');
  const goal = as(() => cleanGoal(p.goal), 'text');
  if (!Array.isArray(p.projects) || !p.projects.length || p.projects.length > PROJECTS_MAX) throw bad(`the plan is about 1 to ${PROJECTS_MAX} projects`, 'shape');
  for (const n of p.projects) if (typeof n !== 'string' || !(ctx.projects || []).includes(n)) throw bad(`"${String(n).slice(0, 60)}" is not a project of the workspace`, 'project');
  if (new Set(p.projects).size !== p.projects.length) throw bad('a project is named twice', 'shape');
  if (typeof p.note !== 'string') throw bad('the note is Markdown text', 'shape');
  const note = p.note.trim() ? as(() => checkNoteText(p.note), 'text') : '';
  if (!Array.isArray(p.milestones) || p.milestones.length > MILESTONES_MAX) throw bad(`a plan has up to ${MILESTONES_MAX} milestones`, 'too-many');
  const milestones = p.milestones.map((m, i) => {
    if (!isObj(m)) throw bad(`milestone ${i + 1} is not an object`, 'shape');
    keysOf(m, ['title', 'date'], `milestone ${i + 1}`);
    const d = m.date === undefined ? null : m.date;
    if (d !== null && !isYmd(d)) throw bad(`milestone ${i + 1}: "${String(d).slice(0, 20)}" is not a date (YYYY-MM-DD)`, 'date');
    return { title: as(() => cleanTitle(m.title, `title of milestone ${i + 1}`), 'text'), date: d };
  });
  if (!Array.isArray(p.tasks) || !p.tasks.length) throw bad('the plan has no tasks', 'shape');
  if (p.tasks.length > TASKS_MAX) throw bad(`the plan has ${p.tasks.length} tasks: ${TASKS_MAX} at most`, 'too-many');
  const n = p.tasks.length;
  const tasks = p.tasks.map((t, i) => {
    const what = `task ${i + 1}`;
    if (!isObj(t)) throw bad(`${what} is not an object`, 'shape');
    keysOf(t, TASK, what);
    if (t.date !== null && !isYmd(t.date)) throw bad(`${what}: "${String(t.date).slice(0, 20)}" is not a date (YYYY-MM-DD)`, 'date');
    if (t.milestone !== null && !(Number.isInteger(t.milestone) && t.milestone >= 0 && t.milestone < milestones.length)) throw bad(`${what}'s milestone is not one of the plan's`, 'shape');
    const by = as(() => checkBy(t.by), 'shape');
    if (!Array.isArray(t.after) || t.after.length > AFTER_MAX) throw bad(`${what} waits for up to ${AFTER_MAX} tasks`, 'shape');
    for (const a of t.after) {
      if (!Number.isInteger(a) || a < 0 || a >= n) throw bad(`${what} waits for a task that is not in the plan`, 'shape');
      if (a === i) throw bad(`${what} waits for itself`, 'ring');
    }
    const t2 = as(() => cleanTitle(t.title, `title of ${what}`), 'text');
    let brief = null;
    if (t.brief !== null) {
      if (typeof t.brief !== 'string' || t.brief.length > BRIEF_MAX * 2) throw bad(`${what}'s brief is text of up to ${BRIEF_MAX} characters`, 'too-big');
      brief = t.brief.trim() ? as(() => checkBrief(t.brief), 'text') : null;
    }
    let check = null;
    if (t.check !== null) {
      if (typeof t.check !== 'string') throw bad(`${what}'s check is text`, 'shape');
      const c = t.check.trim();
      if (/[\r\n]/.test(c) || c.length > CHECK_MAX) throw bad(`${what}'s check is one line of up to ${CHECK_MAX} characters`, 'too-big');
      check = c ? as(() => plainText(c, `check of ${what}`), 'text') : null;
    }
    if (t.project !== null && !p.projects.includes(t.project)) throw bad(`${what}'s project "${String(t.project).slice(0, 60)}" is not one the plan is about`, 'project');
    return { title: t2, date: t.date, milestone: t.milestone, by, after: [...new Set(t.after)], brief, check, project: t.project };
  });
  const ring = ringIn(new Map(tasks.map((t, i) => [i, t.after])));
  if (ring) throw bad(`tasks wait for each other for ever: ${ring.map((i) => i + 1).join(' → ')}`, 'ring');
  if (note.length > NOTE_MAX) throw bad('the note is too long', 'too-big');
  return { title, goal, projects: [...p.projects], note, milestones, tasks };
}

/** The proposal with task `i` taken out: what waited for it waits for nothing in its place, the indexes moved up. */
export function withoutTask(p, i) {
  return { ...p, tasks: p.tasks.filter((_, j) => j !== i).map((t) => ({ ...t, after: t.after.filter((a) => a !== i).map((a) => (a > i ? a - 1 : a)) })) };
}

/** The proposal with milestone `i` taken out: its tasks are in no milestone then. */
export function withoutMilestone(p, i) {
  return { ...p, milestones: p.milestones.filter((_, j) => j !== i), tasks: p.tasks.map((t) => ({ ...t, milestone: t.milestone === i ? null : t.milestone !== null && t.milestone > i ? t.milestone - 1 : t.milestone })) };
}

/** A short hash of a proposal: what the owner saw, named again when he accepts it. */
export const proposalHash = (p) => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);

/**
 * The owner's changes on the proposal screen, applied to the proposal as it was read: never the session's texts sent
 * back from the page, only what he changed. edits: { seen (proposalHash of what he saw), title?, goal?, milestones?:
 * { "<index>": { title?, date? } }, tasks?: { "<index>": { title?, date?, by? } }, drop?: { milestones: [index], tasks:
 * [index] } }. → the proposal as he wants it, checked (checkProposal); 409 when it is not the one he saw.
 */
export function applyEdits(p, edits, ctx) {
  if (!isObj(edits)) throw bad('the changes are an object', 'shape');
  keysOf(edits, ['seen', 'title', 'goal', 'milestones', 'tasks', 'drop'], 'the changes');
  if (edits.seen !== proposalHash(p)) throw Object.assign(new Error('the proposal changed since it was shown: look at it again'), { status: 409, details: { code: 'moved' } });
  const out = { ...p, milestones: p.milestones.map((m) => ({ ...m })), tasks: p.tasks.map((t) => ({ ...t, after: [...t.after] })) };
  if (edits.title !== undefined) out.title = edits.title;
  if (edits.goal !== undefined) out.goal = edits.goal;
  const each = (map, list, allowed, what) => {
    if (map === undefined) return;
    if (!isObj(map)) throw bad(`the changes of the ${what}s are an object`, 'shape');
    for (const [k, v] of Object.entries(map)) {
      const i = Number(k);
      if (!/^\d+$/.test(k) || i >= list.length || !isObj(v)) throw bad(`there is no ${what} ${Number(k) + 1}`, 'shape');
      keysOf(v, allowed, `the change of ${what} ${i + 1}`);
      Object.assign(list[i], v);
    }
  };
  each(edits.milestones, out.milestones, ['title', 'date'], 'milestone');
  each(edits.tasks, out.tasks, ['title', 'date', 'by'], 'task');
  const drop = edits.drop === undefined ? { milestones: [], tasks: [] } : edits.drop;
  if (!isObj(drop)) throw bad('what is taken out is an object', 'shape');
  keysOf(drop, ['milestones', 'tasks'], 'what is taken out');
  const idx = (list, n, what) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) throw bad(`the ${what}s taken out are numbers of the list`, 'shape');
    return [...new Set(list)].sort((a, b) => b - a);
  };
  let r = out;
  for (const i of idx(drop.tasks, out.tasks.length, 'task')) r = withoutTask(r, i);
  for (const i of idx(drop.milestones, out.milestones.length, 'milestone')) r = withoutMilestone(r, i);
  return checkProposal(r, ctx);
}

// ---------- what the session is asked ----------

const SKILL_FILE = fileURLToPath(new URL('../../skills/plan-work/SKILL.md', import.meta.url));
/** The method of the bundled skill plan-work (its text without the front matter), or null when it is not there. */
export function planSkill() {
  try {
    const text = fs.readFileSync(SKILL_FILE, 'utf8');
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    return (m ? m[1] : text).trim();
  } catch {
    return null;
  }
}

const EXAMPLE = {
  title: 'Make the shop site load faster',
  goal: 'The home page loads in under two seconds on a phone.',
  projects: ['shop'],
  note: '## What exists\n- The images are large PNG files (`public/img`).\n\n## Unknown\n- ...\n\n## Risks\n- ...\n\n## Cost\n- ...\n\n## Open questions\n- ...',
  milestones: [{ title: 'Images made small', date: '2026-12-02' }],
  tasks: [
    { title: 'Measure the home page as it is', date: '2026-11-24', milestone: 1, by: 'ai', after: [], brief: 'Measure ...', check: 'A table of load times is in the note.' },
    { title: 'Turn the images into WebP', date: '2026-11-26', milestone: 1, by: 'ai', after: [1], brief: 'Convert ...', check: 'No image over 200 KB.' },
    { title: 'Approve the new images', date: '2026-11-27', milestone: 1, by: 'me', after: [2], brief: null, check: 'You said yes.' },
  ],
};

/**
 * The first message of a planning session. o: { goal (the owner's words, checked), project, also (other projects),
 * today }. The method is the skill plan-work's; the shape of the answer is said here exactly, because Work reads only
 * that shape.
 */
export function firstMessage({ goal, project, also = [], today }) {
  const skill = planSkill();
  const others = also.length ? ` It is also about ${also.map((n) => `${n} (its folder is ../${n})`).join(', ')}.` : '';
  return [
    'Make a plan for this goal, as a PROPOSAL for me to look at. Nothing is created before I accept it on Hoprig\'s proposal screen.',
    '',
    'My goal, in my own words:',
    goal,
    '',
    `The project is ${project}: this folder.${others} Today is ${today}.`,
    '',
    'How to work:',
    '- Research first: read the project\'s own files, and look on the web where you can. Change, create or delete no file, and run nothing that changes anything: this turn only reads and plans.',
    '- Where the method below says to ask me a question or to ask for a yes: do not ask. Write what you assumed into the note and the questions under "Open questions" in the note; I answer on the proposal screen.',
    ...(skill ? ['- Follow this method (the skill "plan-work"):', '', skill, ''] : []),
    'Your LAST message is the proposal and nothing else: one fenced code block of the language json, in exactly this shape (an example):',
    '',
    '```json',
    JSON.stringify(EXAMPLE, null, 2),
    '```',
    '',
    'The rules of the shape:',
    '- title: the plan\'s name, one line of 3 to 200 characters. goal: one sentence, at most 300 characters.',
    `- projects: the projects it is about, from: ${[project, ...also].join(', ')}.`,
    `- note: the research note in Markdown, at most ${NOTE_MAX.toLocaleString('en')} characters: what exists, what is unknown, the risks (each with where it came from, a guess marked "assumed"), the cost and the open questions. No HTML and no images; a link only as a full http or https address, written without < >; a file name as \`code\`. In the note, never write an HTML tag: name it in words, or put code in a fenced block that starts at the beginning of a line.`,
    `- milestones: up to ${MILESTONES_MAX}, each a title and a date (YYYY-MM-DD) or null.`,
    `- tasks: 1 to ${TASKS_MAX}. title: one line. date: YYYY-MM-DD or null. milestone: the number of its milestone (1 is the first) or null. by: "me" for what only I can do (an account, a purchase, a yes, anything that goes out), "ai" for what a coding session can do, or a role in lower-case letters (developer, reviewer, tester, researcher, writer). after: the numbers of the tasks it waits for (1 is the first task). brief: for a task a session does, what it needs to do it, up to ${BRIEF_MAX.toLocaleString('en')} characters, else null. check: how to tell it is done, one line of up to ${CHECK_MAX} characters.`,
    '- No other keys. Plain characters only: nothing invisible.',
  ].join('\n');
}
