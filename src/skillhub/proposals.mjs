// Skills → proposals: a proposal file of an outside improvement loop, for one of Tia's skills or tool descriptions.
// The loop runs elsewhere and makes no request through Hoprig; it leaves one file per proposal in
// <state>/proposals/<id>.json. The page shows what would change, why, and the numbers the loop measured with
// Hoprig's own eval; the owner decides.
//
//   GET  /api/skills/proposals                     the waiting ones, the accepted ones, how many files did not read
//   POST /api/skills/proposals/<id>/accept         a skill: its new text goes in place (Tia's own skills folder), the
//                                                  text before is kept, Undo brings it back
//   POST /api/skills/proposals/<id>/undo           an accepted one, back to the text before it
//   POST /api/skills/proposals/<id>/later          "Not now": put away, listed under "Put away"
//   POST /api/skills/proposals/<id>/again          a put-away one waits again
//
// A tool's description is part of Hoprig's code: it is never accepted here, its proposal carries an issue text for
// a coding session. A proposal file is untrusted data: it is read with limits, checked field by field, and its
// text is shown as text. A skill's new text is checked as a learned draft is (the loader, the draft scan) before it
// goes in place, and only over the very text it was measured against.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerSkillsDir, parseSkill, Skills } from '../assistant/skills.mjs';
import { byName, TOOL_NAMES } from '../assistant/tools.mjs';
import { stateDir } from '../paths.mjs';
import { lineDiff } from './diff.mjs';
import { foldLooks, PATTERNS, RISKY, scanDraft } from './learnscan.mjs';
import { scanText } from './scan.mjs';
import { placeSkill, removeSkill, undoSkill } from './store.mjs';
import { noteCorrection } from '../operator/corrections.mjs';

export const ID_RE = /^[0-9]{8}-[0-9]{6}-(skill|tool)-[a-z0-9_-]{1,64}$/;
const NAME = { skill: /^[a-z0-9]+(-[a-z0-9]+)*$/, tool: /^[a-z][a-z0-9_]{1,63}$/ };
const MAX_FILE = 256 * 1024;
const MAX_TEXT = 64 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });

export const proposalsDir = () => path.join(stateDir(), 'proposals');
const decisionsFile = () => path.join(proposalsDir(), 'decisions.json');
/** Tia's own skills folder as a scope of the skills store (its moves keep the text before, for Undo). */
const tiaScope = () => ({ kind: 'tia', root: null, dir: ownerSkillsDir() });

function readDecisions() {
  try {
    const j = JSON.parse(fs.readFileSync(decisionsFile(), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
function writeDecisions(d) {
  fs.mkdirSync(proposalsDir(), { recursive: true, mode: 0o700 });
  const tmp = `${decisionsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, decisionsFile());
}

/** The text Tia uses now for a part, or null when she has no such part. */
export function liveText(kind, name) {
  if (kind === 'tool') return byName.has(name) ? byName.get(name).description : null;
  const s = new Skills().get(name);
  return s ? fs.readFileSync(s.file, 'utf8') : null;
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
const count = (x) => (x && Number.isInteger(x.passed) && Number.isInteger(x.cases) && x.passed >= 0 && x.passed <= x.cases ? { passed: x.passed, cases: x.cases } : null);
const nonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const pair = (x, f) => ({ before: f(x && x.before), after: f(x && x.after) });
// The fresh samples that decided "better": cases passed per round on each text, the same rounds and cases. Both lists
// whole numbers within the cases, of one length, else nothing is shown (never half of them).
const rounds = (xs, cases) => (Array.isArray(xs) && xs.length >= 1 && xs.length <= 50 && xs.every((x) => Number.isInteger(x) && x >= 0 && x <= cases) ? xs : null);
function freshOf(f) {
  if (!f || typeof f !== 'object' || !Number.isInteger(f.cases) || f.cases < 1 || f.cases > 500) return null;
  const live = rounds(f.live, f.cases);
  const cand = rounds(f.candidate, f.cases);
  if (!live || !cand || live.length !== cand.length) return null;
  return { rounds: live.length, cases: f.cases, live, candidate: cand, spread: Math.max(...live) - Math.min(...live) };
}

/** One proposal file, read and checked; throws with a plain reason. */
export function readProposal(id) {
  if (!ID_RE.test(String(id || ''))) throw fail(400, 'that is not a proposal');
  const file = path.join(proposalsDir(), `${id}.json`);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw fail(404, 'there is no such proposal');
  }
  if (!st.isFile() || st.size > MAX_FILE) throw fail(400, 'the proposal file is a link, not a plain file, or too large');
  let p;
  try {
    p = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw fail(400, 'the proposal file is not valid JSON');
  }
  const t = p && p.target;
  if (!p || p.format !== 1 || p.id !== id || !t || !['skill', 'tool'].includes(t.kind) || !NAME[t.kind].test(String(t.name || '')) || id.split('-')[2] !== t.kind) throw fail(400, 'the proposal file does not have the shape of a proposal');
  const before = str(p.before, MAX_TEXT);
  const after = str(p.after, MAX_TEXT);
  if (!before || !after || before === after) throw fail(400, 'the proposal has no before and after text');
  const live = liveText(t.kind, t.name);
  if (live === null) throw fail(400, `Tia has no ${t.kind === 'skill' ? 'skill' : 'tool'} "${t.name}"`);
  const n = p.numbers || {};
  const c = n.cost || {};
  return {
    id, kind: t.kind, name: t.name, live, before, after, stale: live !== before,
    why: (Array.isArray(p.why) ? p.why : []).map((x) => str(x, 600)).filter(Boolean).slice(0, 10),
    numbers: {
      whole: pair(n.whole, count), heldout: pair(n.heldout, count), tokens: pair(n.tokens_per_turn, nonNeg), fresh: freshOf(n.fresh),
      cost: { requests: nonNeg(c.requests), tokens: nonNeg(c.proposer_tokens), whole: nonNeg(c.eval_runs && c.eval_runs.whole), single: nonNeg(c.eval_runs && c.eval_runs.single_case), dollars: nonNeg(c.dollars) },
    },
    gates: (Array.isArray(p.gates) ? p.gates : []).slice(0, 10).filter((g) => g && typeof g.name === 'string').map((g) => ({ name: g.name.slice(0, 20), ok: g.ok === true, why: str(g.why, 300) || '' })),
    issue: t.kind === 'tool' ? str(p.issue, 20_000) : null,
    created: typeof p.created === 'string' && !Number.isNaN(Date.parse(p.created)) ? p.created : null,
  };
}

/**
 * The file's numbers compared here, never taken from its own gates: { whole, heldout } each 'better', 'same', 'worse'
 * or null (no numbers), gain (the whole eval rose), blocked (why Accept is refused: something got worse).
 */
export function verdictOf(numbers) {
  const cmp = (b, a) => {
    if (!b || !a || !b.cases || !a.cases) return null;
    const d = a.passed * b.cases - b.passed * a.cases;
    return d > 0 ? 'better' : d < 0 ? 'worse' : 'same';
  };
  const whole = cmp(numbers.whole.before, numbers.whole.after);
  const heldout = cmp(numbers.heldout.before, numbers.heldout.after);
  const blocked = whole === 'worse' ? 'it passes fewer cases of the whole eval than the text now' : heldout === 'worse' ? 'it passes fewer of the cases it never saw while searching than the text now' : null;
  return { whole, heldout, gain: whole === 'better', blocked };
}

/** What the page shows: the diff is made here from the texts, never taken from the file. */
// A tool's description is one long line: its diff is read clause by clause, so one changed clause shows as one line.
// A clause's own punctuation (the ";" before it, the ")" that closes a list) stays off the clause's line, so one clause
// added before a closing parenthesis shows as one added line, not as a removed and an added one.
const clauses = (s) => String(s).replace(/; (?=\S)/g, '\n; ').replace(/\)(?=[.,;]?(?:\s|$))/g, '\n)').replace(/\. (?=\S)/g, '.\n');
function forPage(p, decision) {
  const hunks = p.kind === 'tool' ? lineDiff(clauses(p.live), clauses(p.after)) : lineDiff(p.live, p.after);
  const verdict = verdictOf(p.numbers);
  // The held-out check as the numbers say, whatever the file says of it.
  const gates = p.gates.map((g) => (g.name === 'heldout' && verdict.heldout === 'worse' ? { ...g, ok: false, why: 'fewer held-out cases passed after than before' } : g));
  return {
    id: p.id, kind: p.kind, name: p.name, why: p.why, numbers: p.numbers, gates, verdict, issue: p.issue, created: p.created, stale: p.stale,
    // A tool's description that is now the proposed text: a coding session made the change.
    done: p.kind === 'tool' && p.live === p.after,
    before: p.live, after: p.after, diff: { removed: [], added: [], changed: [{ path: p.kind === 'skill' ? 'SKILL.md' : 'description', hunks }] },
    state: decision ? decision.state : 'waiting', at: decision ? decision.at : null,
  };
}

export function listProposals() {
  let names = [];
  try {
    names = fs.readdirSync(proposalsDir());
  } catch {
    return { waiting: [], accepted: [], put: [], unreadable: 0, unreadableFiles: [] };
  }
  const d = readDecisions();
  const waiting = [];
  const accepted = [];
  const put = [];
  const unreadableFiles = [];
  for (const f of names.sort().reverse()) {
    if (f === 'decisions.json' || f.endsWith('.tmp')) continue;
    const id = f.endsWith('.json') ? f.slice(0, -5) : '';
    let p;
    try {
      p = readProposal(id);
    } catch (e) {
      unreadableFiles.push({ file: f.slice(0, 120), why: e.message });
      continue;
    }
    const dec = d[id];
    const one = forPage(p, dec);
    if ((dec && dec.state === 'accepted') || one.done) accepted.push(one);
    else if (dec && dec.state === 'later') put.push(one);
    else waiting.push(one);
  }
  return { waiting: waiting.slice(0, 20), accepted: accepted.slice(0, 20), put: put.slice(0, 20), unreadable: unreadableFiles.length, unreadableFiles: unreadableFiles.slice(0, 20) };
}

const FRONT_KEYS = new Set(['name', 'description', 'allowed-tools']);
const frontLines = (t) => ((/^---\r?\n([\s\S]*?)\r?\n---/.exec(String(t)) || [])[1] ?? '').split(/\r?\n/);
// Every line of a key, joined: a second line of the same key replaces the first for Tia's parser.
const lineOf = (t, key) => frontLines(t).filter((l) => l.startsWith(`${key}:`)).join('\n');

// A tool's name as the model reads it: in any case, only as a whole word.
// It is read folded (look-alike letters to Latin, invisible characters such as the soft hyphen out), with any run of
// characters that are not letters or digits between its words (switch.account, switch·account, Switсh_Account).
export const namesTool = (text, t) => new RegExp(`(?<![\\p{L}\\p{N}])${t.toLowerCase().split(/[_-]+/).join('[^\\p{L}\\p{N}]*')}(?![\\p{L}\\p{N}])`, 'u')
  .test(foldLooks(String(text).replace(/\p{Default_Ignorable_Code_Point}/gu, '')).toLowerCase());

/**
 * What a changed front matter may not do, as plain reasons. The description is in Tia's system prompt in every turn,
 * so it is read as Tia reads it (parseSkill, escapes decoded) and as a person sees it (look-alikes folded): a new key,
 * a folded or block value (the two parsers read it differently), a backslash escape (formatSkill never writes one),
 * a tool of Tia's named in a changed description, markup there, or anything the scans flag in it.
 */
export function frontMatterProblems(before, after) {
  const out = [];
  const keysOf = (t) => frontLines(t).map((l) => (/^([A-Za-z][\w-]*):/.exec(l) || [])[1]).filter(Boolean);
  const had = new Set(keysOf(before));
  const seenKeys = new Set();
  for (const k of keysOf(after)) {
    if (seenKeys.has(k)) out.push(`the front matter has the key "${k}" twice (the second line would replace the first)`);
    seenKeys.add(k);
    if (!FRONT_KEYS.has(k)) out.push(`the front matter has a key "${k}" (only name, description and allowed-tools)`);
    else if (!had.has(k)) out.push(`the front matter has a new key "${k}"`);
  }
  for (const l of frontLines(after)) {
    if (/^[A-Za-z][\w-]*:\s*[>|][+-]?\s*$/.test(l)) out.push(`the front matter has a folded or block value ("${l.trim()}")`);
    if (/\\/.test(l) && !frontLines(before).includes(l)) out.push('the front matter has a backslash escape');
  }
  // An HTML comment is hidden on the card's rendered text and read by the model: a new one anywhere is refused.
  const comments = (t) => new Set(String(t).match(/<!--[\s\S]*?(?:-->|$)/g) || []);
  const old = comments(before);
  if ([...comments(after)].some((c) => !old.has(c))) out.push('the new text holds an HTML comment');
  const desc = parseSkill(after).description;
  if (desc !== parseSkill(before).description) {
    const tools = TOOL_NAMES.filter((t) => namesTool(desc, t));
    if (tools.length) out.push(`the description names Tia's tool ${tools.join(', ')}: it is read in every turn, so it says when to use the skill, never what to call`);
    if (/[<>]/.test(desc)) out.push('the description holds markup');
    const folded = foldLooks(desc);
    const hits = [...scanText('description.md', desc), ...(folded === desc ? [] : scanText('description.md', folded))].filter((f) => f.severity === 'block' || RISKY.has(f.rule));
    for (const [rule, re] of PATTERNS) if (re.test(folded)) hits.push({ rule, message: `the description ${rule.replace(/^learn-/, '').replace(/-/g, ' ')}` });
    if (hits.length) out.push(`the description: ${[...new Set(hits.map((h) => h.message))].join('; ')}`);
  }
  return [...new Set(out)];
}

/** Accept a skill's proposal: checked as a learned draft is, then put in place with the text before kept. */
export function accept(id, { reload = () => {} } = {}) {
  const p = readProposal(id);
  if (p.kind !== 'skill') throw fail(409, 'a tool\'s description is part of Hoprig\'s code: give the issue text to a coding session instead');
  const d = readDecisions();
  if (d[id] && d[id].state === 'accepted') throw fail(409, 'that proposal is accepted already');
  if (p.stale) throw fail(409, `the skill "${p.name}" was changed since this was proposed, so it was not measured against the text it would replace`);
  const blocked = verdictOf(p.numbers).blocked;
  if (blocked) throw fail(409, `not accepted: ${blocked}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-proposal-'));
  try {
    const dir = path.join(tmp, p.name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), p.after);
    const loaded = new Skills({ dirs: [{ dir: tmp, source: 'owner' }] });
    if (loaded.problems.length || !loaded.get(p.name)) throw fail(400, `the new text does not load as a skill: ${loaded.problems.length ? loaded.problems[0].problem : 'its name differs'}`);
    const scan = scanDraft(dir, p.after, { before: p.before });
    // For Tia a skill's allowed-tools is a list her loader checks against her own tools; the scan's rule is about a
    // coding tool's pre-approval. It is passed over only when that very line is unchanged: the rest of the front
    // matter is checked on its own below, as Tia reads it.
    const sameTools = lineOf(p.after, 'allowed-tools') === lineOf(p.before, 'allowed-tools');
    const bad = scan.findings.filter((x) => !x.own && (x.severity === 'block' || RISKY.has(x.rule)) && !(x.rule === 'allowed-tools' && sameTools)).map((x) => x.message);
    bad.push(...frontMatterProblems(p.before, p.after));
    if (bad.length) throw fail(409, `the new text was not accepted: ${[...new Set(bad)].join('; ')}`);
    const hadOwn = fs.existsSync(path.join(ownerSkillsDir(), p.name));
    placeSkill(tiaScope(), p.name, dir, [{ path: 'SKILL.md', mode: 0o644 }], { source: { type: 'proposal', id } });
    d[id] = { state: 'accepted', at: new Date().toISOString(), hadOwn };
    writeDecisions(d);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  reload();
  return { ok: true, name: p.name };
}

/** Undo an accepted proposal: the text before comes back (the new one is kept, so accepting again is possible). */
export function undo(id, { reload = () => {} } = {}) {
  const p = readProposal(id);
  const d = readDecisions();
  if (!d[id] || d[id].state !== 'accepted') throw fail(409, 'that proposal is not accepted');
  const file = path.join(ownerSkillsDir(), p.name, 'SKILL.md');
  let now = null;
  try {
    now = fs.readFileSync(file, 'utf8');
  } catch {
    /* gone */
  }
  if (now !== p.after) throw fail(409, `the skill "${p.name}" was changed since you accepted it; nothing was undone`);
  if (d[id].hadOwn) undoSkill(tiaScope(), p.name);
  else removeSkill(tiaScope(), p.name); // the built-in text is Tia's again
  d[id] = { state: 'undone', at: new Date().toISOString() };
  writeDecisions(d);
  reload();
  return { ok: true, name: p.name };
}

/** A put-away proposal waits again. */
export function again(id) {
  readProposal(id);
  const d = readDecisions();
  if (!d[id] || d[id].state !== 'later') throw fail(409, 'that proposal is not put away');
  delete d[id];
  writeDecisions(d);
  return { ok: true };
}

export function later(id) {
  readProposal(id);
  const d = readDecisions();
  if (d[id] && d[id].state === 'accepted') throw fail(409, 'undo it first');
  d[id] = { state: 'later', at: new Date().toISOString() };
  writeDecisions(d);
  return { ok: true };
}

/** The feature: { name, routes }. opts.reload: Tia's skills are read again after a change. */
export function proposalsFeature(ctx, opts = {}) {
  const ownerOnly = (req) => {
    if (/^Bearer\s+tia_/i.test(String(req.headers.authorization || ''))) throw fail(403, 'proposals are decided by the owner only');
  };
  const reload = () => {
    try {
      opts.reload?.();
    } catch {
      /* she reads them again at her next start */
    }
  };
  const routes = [
    ['GET', /^\/api\/skills\/proposals$/, async (req) => {
      ownerOnly(req);
      return listProposals();
    }],
    ['POST', /^\/api\/skills\/proposals\/([0-9]{8}-[0-9]{6}-(?:skill|tool)-[a-z0-9_-]{1,64})\/(accept|undo|later|again)$/, async (req, m) => {
      ownerOnly(req);
      await ctx.readJson(req);
      if (m[2] === 'accept') return accept(m[1], { reload });
      if (m[2] === 'undo') {
        const r = undo(m[1], { reload });
        // He took back a skill's text he had accepted: one correction of that skill (a tool's text is never accepted by
        // a tap, so only a skill's Undo is one). Nothing changes by itself from it (src/operator/corrections.mjs).
        if (m[1].includes('-skill-')) noteCorrection(ctx.config ? ctx.config() : {}, { kind: 'undo', about: { skill: r.name } });
        return r;
      }
      if (m[2] === 'again') return again(m[1]);
      return later(m[1]);
    }],
  ];
  return { name: 'proposals', routes };
}
