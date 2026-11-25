#!/usr/bin/env node
// Takes the public skills of the shared core into skills/, by the version a maintainer chooses, on purpose:
//
//   node tools/core-sync.mjs --from <export folder>           show what would change, as a plain diff; write nothing
//   node tools/core-sync.mjs --from <export folder> --write   take them, and pin that version in core.json
//   node tools/core-sync.mjs --check                          exit 1 and name every taken file that changed here
//   (--root <folder> works on another copy of the tree: the tests use it)
//
// The shared core is another repository. Its export is a local folder: core-export.json ({ name, version, packs:
// [{ name, public }] }) and skills/<pack>/<skill>/SKILL.md with the skill's other files. Only the packs marked public
// are taken. core.json at the repository's top records the core's name, the pinned version and the sha256 of every
// file taken, so a file changed here is never overwritten: it is listed, and nothing is written. Hoprig itself never
// reads core.json when it runs: the taken skills are plain skills in skills/, loaded as before. Nothing is fetched
// from a network and no other program is started.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from '../src/skillhub/frontmatter.mjs';
import { lineDiff } from '../src/skillhub/diff.mjs';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PIN = 'core.json';
const SKILLS = 'skills';
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const MAX_FILE = 1 << 20;
const MARK = /^<!-- Generated from the shared core [^\n]*: change it there\. -->\r?\n/m;
const USAGE = 'usage: node tools/core-sync.mjs --from <export folder> [--write] | --check   [--root <folder>]';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

class Refused extends Error {}

/** The line that says where a Markdown file comes from: after the front matter, or at the top when it has none. */
export function withMark(text, version) {
  const mark = `<!-- Generated from the shared core ${version}: change it there. -->\n`;
  const src = text.replace(MARK, '');
  const lines = src.split('\n');
  if (lines[0].trimEnd() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) return [...lines.slice(0, end + 1), mark.trimEnd(), ...lines.slice(end + 1)].join('\n');
  }
  return mark + src;
}

const withoutMark = (text) => text.replace(MARK, '');

/** core.json as { version, core, pinned, about, files }; files: { 'skills/x/SKILL.md': sha256 }. */
export function readPin(root) {
  const file = path.join(root, PIN);
  let pin;
  try {
    pin = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Refused(`${PIN} cannot be read in ${root}: ${e.message}`);
  }
  if (!pin || pin.version !== 1) throw new Refused(`${PIN}: "version" must be 1`);
  const files = pin.files && typeof pin.files === 'object' ? pin.files : {};
  for (const [rel, h] of Object.entries(files)) if (!safeRel(rel) || !/^[0-9a-f]{64}$/.test(h)) throw new Refused(`${PIN}: the record of ${JSON.stringify(rel)} is not a path in ${SKILLS}/ with a sha256`);
  return { ...pin, files };
}

/** A relative path below skills/ with no empty, "." or ".." part. */
function safeRel(rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.includes('\\')) return false;
  const parts = rel.split('/');
  return parts[0] === SKILLS && parts.length >= 3 && parts.every((p) => p && p !== '.' && p !== '..');
}

/** Refuse a link anywhere on the way from the tree's top to `rel` (a missing part is fine: it is made). */
function noLinkOnWay(root, rel) {
  let cur = root;
  for (const part of rel.split('/')) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) throw new Refused(`${posix(path.relative(root, cur))} is a link here: it is not followed`);
  }
}

/** The export's public skills: { meta, taken: Map('skills/<skill>/<file>' → Buffer), left: [private pack names] }. */
export function readExport(from) {
  const lst = (p, what) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      throw new Refused(`${what} is missing in the export`);
    }
    if (st.isSymbolicLink()) throw new Refused(`${what} is a link: an export is refused whole when it holds one`);
    return st;
  };
  if (!lst(path.join(from, 'core-export.json'), 'core-export.json').isFile()) throw new Refused('core-export.json is not a file');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(from, 'core-export.json'), 'utf8'));
  } catch (e) {
    throw new Refused(`core-export.json cannot be read: ${e.message}`);
  }
  if (!meta || typeof meta.name !== 'string' || !NAME.test(meta.name)) throw new Refused('core-export.json: "name" must be lower-case words with dashes');
  if (typeof meta.version !== 'string' || !VERSION.test(meta.version)) throw new Refused('core-export.json: "version" must be a version such as 1.2.0');
  if (!Array.isArray(meta.packs)) throw new Refused('core-export.json: "packs" must be a list');
  const packs = meta.packs.map((p) => {
    const name = p && p.name;
    if (typeof name !== 'string' || path.isAbsolute(name) || !name.split('/').every((s) => NAME.test(s))) throw new Refused(`core-export.json: the pack ${JSON.stringify(name)} is not a plain name (an absolute path or ".." is refused)`);
    return { name, public: p.public === true };
  });
  const skillsDir = path.join(from, SKILLS);
  if (!lst(skillsDir, `${SKILLS}/`).isDirectory()) throw new Refused(`${SKILLS}/ is not a folder`);
  const taken = new Map();
  const owner = new Map();
  for (const pack of packs.filter((p) => p.public)) {
    let at = skillsDir;
    for (const part of pack.name.split('/')) {
      at = path.join(at, part);
      if (!lst(at, `${SKILLS}/${posix(path.relative(skillsDir, at))}`).isDirectory()) throw new Refused(`the pack ${pack.name} is not a folder`);
    }
    for (const d of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(at, d.name);
      const shown = `${SKILLS}/${pack.name}/${d.name}`;
      if (d.isSymbolicLink()) throw new Refused(`${shown} is a link: an export is refused whole when it holds one`);
      if (!d.isDirectory() || !fs.existsSync(path.join(dir, 'SKILL.md'))) continue; // a file, or a pack inside a pack
      if (!NAME.test(d.name)) throw new Refused(`${shown}: a skill's folder is lower-case words with dashes`);
      if (owner.has(d.name)) throw new Refused(`the skill ${d.name} is in two public packs (${owner.get(d.name)} and ${pack.name})`);
      owner.set(d.name, pack.name);
      for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        const abs = path.join(e.parentPath ?? e.path, e.name);
        const rel = posix(path.relative(dir, abs));
        const where = `${shown}/${rel}`;
        if (e.isSymbolicLink()) throw new Refused(`${where} is a link: an export is refused whole when it holds one`);
        if (e.isDirectory()) continue;
        if (!e.isFile()) throw new Refused(`${where} is not a plain file`);
        if (rel.startsWith('../') || path.isAbsolute(rel) || !abs.startsWith(dir + path.sep)) throw new Refused(`${where} leaves its skill's folder`);
        if (fs.statSync(abs).size > MAX_FILE) throw new Refused(`${where} is larger than 1 MiB`);
        taken.set(`${SKILLS}/${d.name}/${rel}`, { buf: fs.readFileSync(abs), exec: (fs.statSync(abs).mode & 0o111) !== 0 });
      }
      const fm = parseFrontMatter(taken.get(`${SKILLS}/${d.name}/SKILL.md`).buf.toString('utf8'));
      if (!fm.ok || fm.data.name !== d.name) throw new Refused(`${shown}/SKILL.md: its front matter must name the skill "${d.name}"`);
    }
  }
  return { meta, taken, left: packs.filter((p) => !p.public).map((p) => p.name) };
}

/** What a sync of this export into this tree would do: each file with its state, and the bytes to write. */
export function plan(root, exp) {
  const pin = readPin(root);
  if (pin.core && pin.core !== exp.meta.name) throw new Refused(`the export is of ${exp.meta.name}, but ${PIN} pins ${pin.core}`);
  const rows = [];
  const onDisk = (rel) => {
    noLinkOnWay(root, rel);
    try {
      return fs.readFileSync(path.join(root, rel));
    } catch {
      return null;
    }
  };
  for (const [rel, { buf, exec }] of [...exp.taken].sort(([a], [b]) => a.localeCompare(b))) {
    const out = rel.endsWith('.md') ? Buffer.from(withMark(buf.toString('utf8'), exp.meta.version)) : buf;
    const here = onDisk(rel);
    const recorded = pin.files[rel];
    let state;
    if (here === null) state = 'new';
    else if (!recorded) state = 'local-own';
    else if (sha(here) !== recorded) state = 'local';
    else state = (rel.endsWith('.md') ? withoutMark(here.toString('utf8')) === withoutMark(out.toString('utf8')) : here.equals(out)) ? 'unchanged' : 'changed';
    rows.push({ rel, state, here, out, exec });
  }
  for (const [rel, recorded] of Object.entries(pin.files).sort(([a], [b]) => a.localeCompare(b))) {
    if (exp.taken.has(rel)) continue;
    const here = onDisk(rel);
    if (here === null) continue;
    rows.push({ rel, state: sha(here) === recorded ? 'removed' : 'local', here, out: null });
  }
  return { pin, rows, blocked: rows.filter((r) => r.state === 'local' || r.state === 'local-own') };
}

const LABEL = { new: 'new', changed: 'changed', unchanged: 'unchanged', removed: 'removed', local: 'changed locally', 'local-own': 'changed locally' };

function showDiff(say, a, b) {
  if (a.includes(0) || b.includes(0)) return say('      (not text: not shown line by line)');
  const hunks = lineDiff(withoutMark(a.toString('utf8')), withoutMark(b.toString('utf8')));
  if (!hunks) return say('      (too long to show line by line)');
  for (const h of hunks) {
    say(`      @@ line ${h.oldStart} here, line ${h.newStart} in the core @@`);
    for (const [op, text] of h.lines) say(`      ${op} ${text}`);
  }
}

function report(say, { meta, left }, { pin, rows }) {
  say(`The shared core ${meta.name} ${meta.version} (pinned now: ${pin.pinned ? `${pin.core} ${pin.pinned}` : 'none, Hoprig\'s own copy is used'}).`);
  for (const r of rows) {
    const why = r.state === 'local-own' ? ' (here already, not taken from the core: kept)' : r.state === 'local' ? ' (differs from what was taken: kept)' : '';
    say(`  ${LABEL[r.state].padEnd(16)}${r.rel}${why}`);
    if (r.state === 'changed') showDiff(say, r.here, r.out);
  }
  if (left.length) say(`Packs that are not public, left out: ${left.join(', ')}.`);
}

/** Take the export into the tree: all or nothing. Returns the exit code. */
export function sync({ root, from, write, say = console.log }) {
  const exp = readExport(from);
  const p = plan(root, exp);
  report(say, exp, p);
  if (p.blocked.length) {
    say(`Files changed here are never overwritten: ${p.blocked.map((r) => r.rel).join(', ')}. Bring the change into the shared core, or take it back here, then run this again. Nothing was written.`);
    return 1;
  }
  if (!write) {
    say(`Dry run: nothing was written. To take it: node tools/core-sync.mjs --from ${from} --write`);
    return 0;
  }
  const files = {};
  for (const r of p.rows) {
    const abs = path.join(root, r.rel);
    if (r.state === 'removed') {
      fs.rmSync(abs);
      for (let d = path.dirname(abs); d !== path.join(root, SKILLS) && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);
      continue;
    }
    if (r.state !== 'unchanged' || !r.here.equals(r.out)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, r.out, { mode: r.exec ? 0o755 : 0o644 });
    }
    files[r.rel] = sha(r.out);
  }
  const next = { version: 1, core: exp.meta.name, pinned: exp.meta.version, about: p.pin.about, files };
  fs.writeFileSync(path.join(root, PIN), `${JSON.stringify(next, null, 2)}\n`);
  say(`Took ${Object.keys(files).length} files of ${exp.meta.name} ${exp.meta.version} into ${SKILLS}/ and pinned it in ${PIN}.`);
  return 0;
}

/** Every recorded file still has the hash it was taken with. Returns the exit code. */
export function check({ root, say = console.log }) {
  const pin = readPin(root);
  if (!pin.pinned) {
    say('No shared core is pinned: Hoprig\'s own copy in skills/ is used.');
    return 0;
  }
  const bad = [];
  for (const [rel, recorded] of Object.entries(pin.files)) {
    noLinkOnWay(root, rel);
    let here = null;
    try {
      here = fs.readFileSync(path.join(root, rel));
    } catch {
      /* missing */
    }
    if (here === null) bad.push(`${rel} (missing)`);
    else if (sha(here) !== recorded) bad.push(`${rel} (changed here)`);
  }
  if (bad.length) {
    say(`Taken from the shared core ${pin.core} ${pin.pinned}, and no longer as taken: ${bad.join(', ')}. Change it in the shared core, or take the file back.`);
    return 1;
  }
  say(`Every file taken from the shared core ${pin.core} ${pin.pinned} is as it was taken (${Object.keys(pin.files).length} files).`);
  return 0;
}

export function main(argv) {
  const opts = { root: ROOT, from: null, write: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--check') opts.check = true;
    else if ((a === '--from' || a === '--root') && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h' || a === 'help') return console.log(USAGE), 0;
    else return console.error(USAGE), 2;
  }
  if (opts.check === Boolean(opts.from) || (opts.check && opts.write)) return console.error(USAGE), 2;
  try {
    return opts.check ? check(opts) : sync(opts);
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    console.error(`Refused: ${e.message}. Nothing was written.`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
