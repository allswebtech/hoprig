// The naming rule of a place (docs/WORKSPACE.md, "A naming rule per place"): how the repositories of a place whose
// members are repositories of their own are named on the hosting site, so a project that no computer has seen yet can
// be found and fetched by one word. Pure: no file, no network. The map's check (mapcheck.mjs) uses checkFind, the
// look-up (findcmd.mjs) and `hoprig get <word> --in <place>` use the rest.
//
//   "find": { "parent": "{project}-{product}-project",   the parent repository's name
//             "code":   "{project}-{product}-*",         its code repositories (optional; "*": the rest of the name)
//             "folder": "{product}-{project}",           the project's folder in the place
//             "make":   ["code", "apps"],                folders made in a fetched project (default: code)
//             "skip":   ["old"] }                        a code repository whose "*" part holds one of these words is left out
//
// A placeholder is a free word in braces and stands for ONE word of a name: letters, digits, "." and "_", never a
// hyphen. So a hyphen in the fixed text between two placeholders (or a placeholder and "*") tells them apart; a
// pattern without one there is refused, because its parts could not be told apart.
import { NAME_RE } from '../pcsetup/workspace.mjs';

export const FIND_KEYS = ['parent', 'code', 'folder', 'make', 'skip'];
export const DEFAULT_MAKE = ['code'];
const WORD = '[A-Za-z0-9][A-Za-z0-9._]{0,99}';
const WORD_RE = new RegExp(`^${WORD}$`);
// A placeholder's name: lower-case letters and digits only (the fixed safe set), never a name every object has.
const PLACEHOLDER_RE = /^[a-z][a-z0-9]{0,19}$/;
const OBJECT_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype).map((n) => n.toLowerCase()));
const SKIP_RE = /^[A-Za-z0-9]{1,30}$/;
const PRIVATE = new Set(['no-ai', 'ignore', 'ai-ignore-dir', 'credentials', 'node_modules']);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "{a}-{b}-x" → [{ word: 'a' }, { text: '-' }, { word: 'b' }, { text: '-x' }]; "*" → { rest: true }. Throws. */
function tokens(pattern, what) {
  if (typeof pattern !== 'string' || !/^[A-Za-z0-9{}*._-]{1,100}$/.test(pattern)) throw new Error(`"${what}" is a pattern of a name: letters, digits, ".", "_", "-", {word} and "*"`);
  const out = [];
  const re = /\{([^{}]*)\}|\*|[^{}*]+|[{}]/g;
  for (const m of pattern.matchAll(re)) {
    if (m[0] === '*') out.push({ rest: true });
    else if (m[0].startsWith('{') && m[1] !== undefined) {
      if (!PLACEHOLDER_RE.test(m[1]) || OBJECT_NAMES.has(m[1])) throw new Error(`"${what}": {${m[1].slice(0, 20)}} is not a placeholder (a word of lower-case letters and digits in braces, starting with a letter, and not ${'{constructor}'} or another name every object has)`);
      out.push({ word: m[1] });
    } else if (m[0] === '{' || m[0] === '}') throw new Error(`"${what}": a brace without its pair`);
    else out.push({ text: m[0] });
  }
  const words = out.filter((t) => t.word).map((t) => t.word);
  if (new Set(words).size !== words.length) throw new Error(`"${what}": a placeholder is used twice`);
  if (out.filter((t) => t.rest).length > 1) throw new Error(`"${what}": "*" is used twice`);
  // Two parts that stand for words with no hyphen between them could be split more than one way.
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (!(t.word || t.rest)) continue;
    const next = out[i + 1];
    const after = out[i + 2];
    if (next && (next.word || next.rest)) throw new Error(`"${what}": two parts with nothing between them cannot be told apart`);
    if (next && next.text && after && (after.word || after.rest) && !next.text.includes('-')) throw new Error(`"${what}": the parts around "${next.text}" cannot be told apart (put a "-" between them)`);
  }
  return out;
}

// `known`: words already found (a Map lookup by own keys only: a placeholder never reads an object's prototype).
const regexOf = (toks, known = {}) => {
  const k = new Map(Object.entries(known));
  return new RegExp(`^${toks.map((t) => (t.text ? escape(t.text) : t.rest ? '(?<_rest>.+)' : k.has(t.word) ? escape(k.get(t.word)) : `(?<${t.word}>${WORD})`)).join('')}$`, 'i');
};
/** The groups of a match as a plain object of own keys only. */
const groupsOf = (m) => Object.fromEntries(Object.entries(m.groups || {}));

/**
 * Check a "find" value and make the rule from it. → { ok: true, rule } | { ok: false, errors }. The rule: { parent,
 * code, folder (token lists), words (the parent's placeholders), make, skip, raw (the value as the map keeps it) }.
 */
export function compileFind(f) {
  const errors = [];
  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(f)) return { ok: false, errors: ['"find" is { parent, folder, code?, make?, skip? }'] };
  for (const k of Object.keys(f)) if (!FIND_KEYS.includes(k)) errors.push(`"find": unknown key "${String(k).slice(0, 20)}"`);
  const rule = { make: DEFAULT_MAKE, skip: [] };
  const take = (k, need) => {
    if (f[k] === undefined) {
      if (need) errors.push(`"find" needs "${k}"`);
      return null;
    }
    try {
      return tokens(f[k], `find.${k}`);
    } catch (e) {
      errors.push(e.message);
      return null;
    }
  };
  rule.parent = take('parent', true);
  rule.folder = take('folder', true);
  rule.code = take('code', false);
  if (rule.parent) {
    rule.words = rule.parent.filter((t) => t.word).map((t) => t.word);
    if (!rule.words.length || rule.words.length > 2) errors.push('"find.parent" uses one or two placeholders');
    if (rule.parent.some((t) => t.rest)) errors.push('"find.parent" has no "*": it names one repository');
    // A fixed part is needed: without one, every name of one or two words would be a project of this place.
    if (!rule.parent.some((t) => t.text && /[A-Za-z0-9]/.test(t.text))) errors.push('"find.parent" needs a fixed part (such as "-project"), or every short name would fit');
    const extra = (toks, k) => toks && toks.filter((t) => t.word && !rule.words.includes(t.word)).forEach((t) => errors.push(`"find.${k}": {${t.word}} is not a placeholder of "parent"`));
    extra(rule.folder, 'folder');
    extra(rule.code, 'code');
    // A code pattern holds every placeholder of the parent (and a fixed part): else every repository of the account
    // that fits it could become the code of the first project.
    if (rule.code) {
      const cw = rule.code.filter((t) => t.word).map((t) => t.word);
      if (rule.words.some((w) => !cw.includes(w))) errors.push('"find.code" uses every placeholder of "parent", so a code repository tells its project');
      if (!rule.code.some((t) => t.text && /[A-Za-z0-9-]/.test(t.text))) errors.push('"find.code" needs a fixed part between its words');
    }
    if (rule.folder) {
      if (rule.folder.some((t) => t.rest)) errors.push('"find.folder" has no "*": it names one folder');
      const fw = rule.folder.filter((t) => t.word).map((t) => t.word);
      if (rule.words.some((w) => !fw.includes(w))) errors.push('"find.folder" uses every placeholder of "parent", so a folder tells its project');
    }
  }
  if (f.make !== undefined) {
    // Plain names: never ai_brain (the project's own memory folder is not made by a rule), never two that differ only
    // in letter case (one folder on a file system that ignores it).
    const plain = (d) => typeof d === 'string' && NAME_RE.test(d) && !d.startsWith('.') && !PRIVATE.has(d.toLowerCase()) && d.toLowerCase() !== 'ai_brain';
    if (!Array.isArray(f.make) || !f.make.length || f.make.length > 10 || !f.make.every(plain) || new Set(f.make.map((d) => d.toLowerCase())).size !== f.make.length) errors.push('"find.make" is a list of plain folder names (at most 10, not ai_brain, each once whatever its letter case)');
    else rule.make = [...f.make];
  }
  if (f.skip !== undefined) {
    if (!Array.isArray(f.skip) || f.skip.length > 20 || f.skip.some((w) => typeof w !== 'string' || !SKIP_RE.test(w))) errors.push('"find.skip" is a list of words (letters and digits, at most 20)');
    else rule.skip = f.skip.map((w) => w.toLowerCase());
  }
  if (errors.length) return { ok: false, errors };
  rule.raw = JSON.parse(JSON.stringify(f));
  return { ok: true, rule };
}

/** The words of a parent's name ({ project: 'shop', product: 'alpha' }), or null when it does not fit. */
export function parentWords(rule, name) {
  const m = regexOf(rule.parent).exec(String(name));
  return m ? groupsOf(m) : null;
}

/** A pattern (parent, folder) filled in with the words. */
export const fillIn = (toks, words) => {
  const w = new Map(Object.entries(words));
  return toks.map((t) => (t.text !== undefined ? t.text : w.get(t.word))).join('');
};

/** The folder a project of these words gets, or null when that is no folder name Hoprig uses. */
export function folderOf(rule, words) {
  const f = fillIn(rule.folder, words);
  return NAME_RE.test(f) && !f.startsWith('.') && !PRIVATE.has(f.toLowerCase()) ? f : null;
}

/** The words a folder's name stands for, or null when it does not fit the folder pattern. */
export function folderWords(rule, folder) {
  const m = regexOf(rule.folder).exec(String(folder));
  return m ? groupsOf(m) : null;
}

/** The words of a name of the hosting site that are a rule's words ("*" and fixed text left out). */
const wordsIn = (s) => String(s).toLowerCase().split(/[-._]/).filter(Boolean);

/**
 * Is `name` a code repository of the project with these words? → { fits: false } | { fits: true, skipped?: word }.
 * `skipped`: a word of the "*" part (else of the whole name) that the rule leaves out.
 */
export function codeFit(rule, words, name) {
  if (!rule.code) return { fits: false };
  const m = regexOf(rule.code, words).exec(String(name));
  if (!m) return { fits: false };
  const part = m.groups && m.groups._rest !== undefined ? m.groups._rest : name;
  const bad = wordsIn(part).find((w) => rule.skip.includes(w));
  return bad ? { fits: true, skipped: bad } : { fits: true };
}

/** Does a word name this project (any of its placeholders, letter case aside)? */
export const wordFits = (words, word) => Object.values(words).some((w) => w.toLowerCase() === String(word).toLowerCase());

const sameWords = (a, b) => {
  const bm = new Map(Object.entries(b));
  return Object.keys(a).length === bm.size && Object.entries(a).every(([k, v]) => String(bm.get(k) || '').toLowerCase() === v.toLowerCase());
};

/**
 * Sort the repositories of the hosting site ([{ owner, name, url }]) by the rule:
 *   projects  a parent that fits, with its folder and its code repositories (in the parent's account), the ones the
 *             rule leaves out under `skipped`
 *   misfits   what looks like this place's and does not fit exactly, with why: another count of hyphens before the
 *             fixed ending, the parent's shape without its fixed ending, a code repository that holds a word the rule
 *             leaves out, a code repository without a parent. Never guessed into a project.
 * Every other repository of the account is no business of this place and is not listed.
 */
export function sortRepos(rule, repos) {
  const projects = [];
  const misfits = [];
  const used = new Set();
  const key = (r) => `${r.owner}/${r.name}`.toLowerCase();
  for (const r of repos) {
    const words = parentWords(rule, r.name);
    if (!words) continue;
    const folder = folderOf(rule, words);
    used.add(key(r));
    if (!folder) misfits.push({ repo: r, why: `fits ${rule.raw.parent}, but its folder "${fillIn(rule.folder, words).slice(0, 100)}" is no folder name Hoprig uses` });
    else projects.push({ words, folder, parent: r, code: [], skipped: [] });
  }
  for (const p of projects) {
    for (const r of repos) {
      if (used.has(key(r)) || r.owner.toLowerCase() !== p.parent.owner.toLowerCase()) continue;
      const c = codeFit(rule, p.words, r.name);
      if (!c.fits) continue;
      used.add(key(r));
      if (c.skipped) {
        p.skipped.push({ ...r, word: c.skipped });
        misfits.push({ repo: r, project: p.folder, why: `holds the word "${c.skipped}", which the rule leaves out` });
      } else p.code.push(r);
    }
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const p of projects) p.code.sort(byName);
  // What is left and looks like this place's.
  const tail = [...rule.parent].reverse().find((t) => t.text !== undefined);
  const ending = rule.parent[rule.parent.length - 1].text !== undefined ? rule.parent[rule.parent.length - 1].text : null;
  const leading = rule.parent[0].text !== undefined ? rule.parent[0].text : null;
  const stem = rule.parent.slice(leading !== null ? 1 : 0, ending !== null ? -1 : undefined);
  const stemRe = stem.length && stem.some((t) => t.word) ? regexOf(stem) : null;
  const codeRe = rule.code ? regexOf(rule.code) : null;
  const orphan = new Map(); // the words of code repositories without a parent
  for (const r of repos) {
    if (used.has(key(r))) continue;
    const low = r.name.toLowerCase();
    if ((ending && low.endsWith(ending.toLowerCase()) && low.length > ending.length) || (leading && low.startsWith(leading.toLowerCase()) && low.length > leading.length)) {
      used.add(key(r));
      misfits.push({ repo: r, why: `looks like a parent (${(ending || leading).replace(/^-|-$/g, '')}), but does not fit ${rule.raw.parent} (another count of hyphens, or a word that is no plain word)` });
      continue;
    }
    const cm = codeRe && codeRe.exec(r.name);
    const cg = cm ? new Map(Object.entries(cm.groups || {})) : null;
    if (cg && rule.words.every((w) => cg.get(w))) {
      const words = Object.fromEntries(rule.words.map((w) => [w, cg.get(w)]));
      if (!projects.some((p) => sameWords(p.words, words) && p.parent.owner.toLowerCase() === r.owner.toLowerCase())) {
        const k = JSON.stringify(Object.values(words).map((x) => x.toLowerCase()));
        if (!orphan.has(k)) orphan.set(k, words);
        used.add(key(r));
        misfits.push({ repo: r, why: `fits ${rule.raw.code}, but there is no parent ${fillIn(rule.parent, words)} for it in ${r.owner}` });
      }
    }
  }
  // The parent's shape without its fixed ending: listed when a project or a code repository has the same words, so a
  // short name of the account that has nothing to do with this place is not.
  for (const r of repos) {
    if (used.has(key(r)) || !stemRe) continue;
    const m = stemRe.exec(r.name);
    if (!m) continue;
    const words = groupsOf(m);
    if (projects.some((p) => sameWords(p.words, words)) || [...orphan.values()].some((w) => sameWords(w, words))) {
      used.add(key(r));
      misfits.push({ repo: r, why: `has the shape of ${rule.raw.parent} without its fixed part "${tail ? tail.text : ''}"` });
    }
  }
  return { projects, misfits };
}

/** The rule of a place of the map ('' = the projects folder, which has none), or null. Only a valid rule is returned. */
export function ruleOf(map, placeId) {
  if (!placeId || !map) return null;
  for (const g of map.groups || []) {
    let f;
    if (g.holds) f = (g.holds.find((h) => `${g.dir}/${h.dir}` === placeId && h.parent !== 'group') || {}).find;
    else if (g.dir === placeId && !g.url) f = g.find;
    if (f) {
      const c = compileFind(f);
      return c.ok ? c.rule : null;
    }
  }
  return null;
}

export const WORD_PATTERN = WORD_RE;
