// A task's note is someone else's words (another program, a file that came in through git, a person he works with).
// The brief she writes for a start must not carry its orders into a session: a piece of the note that is a command, an
// address or a path, or a long run of its words, may be in a brief only when the owner wrote it himself in this
// conversation. Checked at the start's door (worktool.mjs startPlan), at the card and again at his tap.

// Shell words that join commands: a note's "| sh" is an order to run what was downloaded.
const OPERATORS = new Set(['|', '||', '&&', ';', '>', '>>', '<', '$', '`']);
// Quotes and punctuation around a word; what is left is the word itself.
const EDGES = /^[\s"'`“”‘’«»()[\]{}.,;:!?]+|[\s"'`“”‘’«»()[\]{}.,;:!?]+$/gu;
const PLAIN = /^[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*$/u;
/** A run of this many words of the note, copied as they are, is a line of the note, not her words. */
export const NOTE_RUN = 8;

const tokens = (text) => String(text || '').toLowerCase().split(/\s+/).map((t) => (OPERATORS.has(t) ? t : t.replace(EDGES, ''))).filter(Boolean);
/** A command, an address or a path: not a plain word (it has a letter or digit), or a shell operator. */
const commandLike = (t) => OPERATORS.has(t) || (!PLAIN.test(t) && /[\p{L}\p{N}]/u.test(t));

/**
 * The pieces of `note` that `brief` carries and the owner's own words (`his`) do not: each command-like word of the
 * note, and each run of NOTE_RUN words of it. [] when the brief holds none.
 */
export function copiedFromNote(brief, note, his = '') {
  const n = tokens(note);
  if (!n.length) return [];
  const b = tokens(brief);
  const h = tokens(his);
  const hisSet = new Set(h);
  const bSet = new Set(b);
  // The note's marks: its command-like words, the host of each address in it, and the programs it names (a word
  // before a flag such as -fsSL, or right after a | ; && of the note). A brief that names one of them carries the order.
  const marks = new Set();
  const hosts = new Set();
  n.forEach((t, i) => {
    if (commandLike(t)) marks.add(t);
    const url = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#\s]+)/.exec(t);
    if (url && url[1].length > 3) hosts.add(url[1]);
    if (PLAIN.test(t) && ((n[i + 1] && /^-{1,2}[a-z]/.test(n[i + 1])) || OPERATORS.has(n[i - 1]))) marks.add(t);
  });
  const hisText = h.join(' ');
  const hisOwn = (t) => hisSet.has(t) || [...hosts].some((x) => t.includes(x) && hisText.includes(x));
  const out = [];
  for (const t of new Set(b)) {
    if ((marks.has(t) || [...hosts].some((x) => t.includes(x))) && !hisOwn(t)) out.push(t);
  }
  const runs = (list) => {
    const s = new Set();
    for (let i = 0; i + NOTE_RUN <= list.length; i++) s.add(list.slice(i, i + NOTE_RUN).join(' '));
    return s;
  };
  const inBrief = runs(b);
  const inHis = runs(h);
  for (const r of runs(n)) if (inBrief.has(r) && !inHis.has(r)) out.push(r);
  return out;
}

/** The project `name` is a word of `text` (the owner's words): "shop" in "the shop project", not in "workshop". */
export function namesWord(text, name) {
  const esc = String(name).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${esc}($|[^\\p{L}\\p{N}_-])`, 'u').test(String(text || '').toLowerCase());
}

// Words before "project" that name no project ("my project", "is project", "us project").
const NOT_A_NAME = new Set(['my', 'the', 'a', 'an', 'this', 'that', 'our', 'your', 'his', 'her', 'same', 'new', 'other', 'another', 'which', 'what', 'one', 'any', 'each', 'every', 'mera', 'mere', 'meri', 'apna', 'apne', 'is', 'us', 'kis', 'kaun', 'kaunse', 'ek', 'wo', 'woh', 'yeh', 'ye']);
/** The names he gave a project in his words: "<name> project" / "<name> प्रोजेक्ट" ("the blog project" → blog). */
export function projectWordsIn(text) {
  const out = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(/([\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s+(?:projects?|प्रोजेक्ट)(?![\p{L}])/gu)) if (!NOT_A_NAME.has(m[1])) out.add(m[1]);
  return [...out];
}
