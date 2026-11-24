// A way round, in words (docs/FIELD-REPORTS.md, "A session's way round"). A coding session that used Hoprig and had to
// get round something adds two plain lines, what failed and what worked:
//   hoprig field way-round --failed "<text>" --worked "<text>"
// They are the owner's own text on his computer: they become a draft of the learned-skills path (Skills → Learned),
// checked like every learned skill (no path, key, e-mail, user@host, look-alike letters, nor this computer's name),
// scanned, and installed only by his press, with Undo. The draft changes one skill of the AI brain, `ways-round` (made
// on the first Install). No model call is made, so such a draft has no test requests. They never go into a report.
import fs from 'node:fs';
import path from 'node:path';
import { brainDir } from '../workspace/layout.mjs';
import { parseFrontMatter } from '../skillhub/frontmatter.mjs';
import { listDrafts, makeDraft, readDraft } from '../skillhub/learned.mjs';
import { checkText } from '../skillhub/learnlook.mjs';
import { learnDir } from '../skillhub/learnset.mjs';
import { sha256 } from '../skillhub/store.mjs';

export const SKILL = 'ways-round';
export const WAITING_MAX = 3;
export const LINE_MAX = 300;
export const TRIGGERS = Object.freeze(['session', 'field']); // a session's lines; the Home line's own words
const fail = (status, message, code) => Object.assign(new Error(message), { status, details: { code } });

const DESCRIPTION = 'What failed with Hoprig on this computer and what worked instead. Use when a Hoprig command fails or needs a way round.';
const HEAD = '# Ways round\n\nWhen something of Hoprig needed a way round on this computer, what failed and what worked:';

const isWayRound = (d) => d && d.source && TRIGGERS.includes(d.source.trigger) && d.name === SKILL;

/** The way-round drafts that wait for the owner. */
export const waitingWayRounds = () => listDrafts().filter((d) => isWayRound(d) && ['trying', 'ready', 'installing'].includes(d.state));

// Stricter than a learned draft's check, for two short lines that have no reason to hold one: any absolute path of two
// or more parts, with either slash (/data/alex/shop, \\data\\alex\\shop, not only the listed roots), a drive letter with
// either slash (D:/shop), a file address (file:///data/x) and a ':' right before one slash (at:/data/x). A part is made
// of letters of any script, digits, '_', '.' and '-' (/données/alex is a path as /data/alex is). A path inside an
// address (https://example.com/a/b) or a word such as "and/or" is not one: '://' is followed by a host there, and the
// slash follows a letter. With backslashes the first part has two characters or more: escapes such as \r\n, \n\n or
// \d\d are what a person writes about line ends and patterns, not a folder. Slashes of other scripts that NFKC leaves
// as they are (∕ ⧸ ⁄) are read as slashes first.
const PART = '[\\p{L}\\p{M}\\p{N}_.\\-]';
const NOT_PART = '[^\\p{L}\\p{M}\\p{N}_.\\-';
const ANY_PATH = new RegExp([
  `(^|${NOT_PART}:/~])\\/${PART}+\\/${PART}`,
  `(^|${NOT_PART}])\\\\${PART}{2,}\\\\${PART}`,
  '(^|[^\\p{L}\\p{M}\\p{N}_])[A-Za-z]:[\\\\/]',
  `:\\/(?!\\/)${PART}+\\/${PART}`,
  ':\\/\\/\\/',
  '(^|[^\\p{L}\\p{N}_])file:\\/\\/',
].join('|'), 'iu');
const SLASHES = /[\u2044\u2215\u2571\u29F8]/g;
const BACKSLASHES = /[\u2216\u2572\u29F5\u29F9]/g;
const plainSlashes = (s) => s.normalize('NFKC').replace(SLASHES, '/').replace(BACKSLASHES, '\\');

/** The two lines, checked as every learned draft's text is (learnlook.mjs). Throws 422 with a plain reason. */
export function checkLines(failed, worked) {
  const one = (v, key) => {
    let s;
    try {
      s = checkText(v, key, LINE_MAX, { min: 3, oneLine: true });
    } catch (e) {
      throw fail(422, String(e.message).replace(`"${key}"`, `what ${key}`), e.rule || 'text');
    }
    if (ANY_PATH.test(s) || ANY_PATH.test(plainSlashes(s))) throw fail(422, `what ${key} names a path of a computer`, 'path');
    return s;
  };
  return { failed: one(failed, 'failed'), worked: one(worked, 'worked') };
}

const entry = ({ failed, worked }, now) => `\n\n## ${new Date(now).toISOString().slice(0, 10)}\n\n- Failed: ${failed}\n- Worked: ${worked}`;

/** The skill's text in the brain now (null when it is not there). */
function current(brain) {
  const file = path.join(brain, 'skills', SKILL, 'SKILL.md');
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function draftOf(lines, { trigger, brain, now }) {
  const before = current(brain);
  const why = trigger === 'session' ? 'A session wrote what failed and what worked.' : 'The same trouble came up twice on this computer.';
  const source = { trigger, title: trigger === 'session' ? 'a session\'s way round' : 'a trouble that came up twice', words: null, lines };
  if (before === null) {
    return makeDraft({ kind: 'new', name: SKILL, description: DESCRIPTION, body: `${HEAD}${entry(lines, now)}`, why, tests: [] }, { source, brain, now, state: 'ready' });
  }
  const body = parseFrontMatter(before).body.replace(/^\n+/, '').replace(/\s+$/, '');
  return makeDraft({ kind: 'patch', target: SKILL, body: `${body}${entry(lines, now)}`, why, tests: [] }, { source, brain, now, state: 'ready' });
}

/**
 * Make a way-round draft from two lines. trigger: "session" (the command) or "field" (the Home line). → the draft.
 * At most WAITING_MAX wait at once: a fourth is refused with a plain sentence.
 */
export function makeWayRound(failed, worked, { trigger = 'session', brain = brainDir(), now = Date.now() } = {}) {
  if (!TRIGGERS.includes(trigger)) throw fail(400, 'that is not a way round', 'trigger');
  const lines = checkLines(failed, worked);
  if (waitingWayRounds().length >= WAITING_MAX) {
    throw fail(409, `${WAITING_MAX} ways round wait in Skills → Learned already: install or discard one of them first`, 'full');
  }
  return draftOf(lines, { trigger, brain, now });
}

/**
 * Before Install: a way-round draft made on an older text of the skill (another way round was installed since, or the
 * skill was made by the first one) is made again on the text there now, with the same two lines, and the old draft
 * goes (it was never installed, so nothing of the brain changes). → the id to install.
 */
export function freshWayRound(id, { brain = brainDir(), now = Date.now() } = {}) {
  let d;
  try {
    d = readDraft(id);
  } catch {
    return id;
  }
  if (!isWayRound(d) || d.state !== 'ready' || !d.source.lines) return id;
  const there = current(brain);
  const same = d.kind === 'new' ? there === null : there !== null && sha256(Buffer.from(there)) === d.beforeSha;
  if (same) return id;
  const lines = checkLines(d.source.lines.failed, d.source.lines.worked);
  const next = draftOf(lines, { trigger: d.source.trigger, brain, now });
  fs.rmSync(path.join(learnDir(), 'drafts', id), { recursive: true, force: true });
  return next.id;
}
