// Skill hubs (hubs.json): public repositories whose skill folders the weekly look reads, to offer new skills that fit
// the person's projects ("Worth adding" on the Skills page). A hub is data like a catalog source. Its skills are
// listed from ONE commit's tree with plain git, as source.mjs fetches a skill (nothing checked out, no hooks, nothing
// run), reading only each SKILL.md's front matter. Nothing from a hub is ever installed here: a hub skill goes
// through the same review → approve as any other skill, and approve is the owner's press. Only skills are taken from
// a hub, never its tools or code (Hermes Agent's tools are Python functions of its own runtime).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from './detect.mjs';
import { oneLine, parseFrontMatter } from './frontmatter.mjs';
import { LIMITS, safeRel } from './scan.mjs';
import { fetchCommit, git, latestCommit, showFile } from './source.mjs';
import { hubDir, listInstalled, safeName, scopeOf, sha256 } from './store.mjs';

const FILE = fileURLToPath(new URL('./hubs.json', import.meta.url));
const KEYS = new Set(['id', 'name', 'repo', 'url', 'folders', 'license', 'notice']);
const GH_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const MAX_SKILLS = 500; // per hub and commit
const MAX_RESULTS = 40;

/** Why one hub entry cannot be used, as plain sentences ([] when it can). */
function entryProblems(e, ids) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['not an object'];
  const errs = [];
  for (const k of Object.keys(e)) if (!KEYS.has(k)) errs.push(`unknown key "${k}"`);
  if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(e.id)) errs.push('id must be lower-case letters, digits and hyphens');
  else if (ids.has(e.id)) errs.push('duplicate id');
  if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 80 || CONTROL.test(e.name)) errs.push('name is a short line of text');
  const parts = typeof e.repo === 'string' ? e.repo.split('/') : [];
  const repoOk = parts.length === 2 && parts.every((p) => GH_PART.test(p) && p !== '.' && p !== '..');
  if (!repoOk) errs.push('repo is owner/repo on GitHub');
  // The public address of the repository, or a file:// folder (a local mirror; tests use one, never the network).
  if (typeof e.url !== 'string' || !(repoOk && e.url === `https://github.com/${e.repo}`) && !/^file:\/\/\/[^\s\0]+$/.test(e.url)) errs.push('url is https://github.com/<repo> or a local file:// folder');
  if (!Array.isArray(e.folders) || !e.folders.length || e.folders.length > 10 || !e.folders.every((f) => safeRel(f))) errs.push('folders are 1 to 10 folders inside the repository');
  if (typeof e.license !== 'string' || !e.license.trim() || e.license.length > 80 || CONTROL.test(e.license)) errs.push('license is required');
  if (typeof e.notice !== 'string' || e.notice.length > 400 || CONTROL.test(e.notice)) errs.push('notice is one line of text');
  return errs;
}

/** Check a hubs object: { hubs: [the usable entries], problems: [lines] }. A bad entry is refused alone. */
export function checkHubs(obj) {
  if (!obj || obj.version !== 1 || !Array.isArray(obj.hubs)) return { hubs: [], problems: ['hubs: version 1 with a hubs array'] };
  const ids = new Set();
  const hubs = [];
  const problems = [];
  for (const [i, e] of obj.hubs.entries()) {
    const errs = entryProblems(e, ids);
    if (errs.length) {
      problems.push(`hub ${i} (${e && typeof e.id === 'string' ? e.id : '?'}): ${errs.join('; ')}`);
      continue;
    }
    ids.add(e.id);
    hubs.push({ ...e, folders: [...e.folders] });
  }
  return { hubs, problems };
}

let shipped = null;
/** The hubs this Hoprig ships with (src/skillhub/hubs.json), checked once. */
export function loadHubs() {
  if (!shipped) shipped = checkHubs(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  return shipped;
}

/** The address git fetches. */
export const gitUrl = (h) => (h.url.startsWith('file://') ? h.url : `${h.url}.git`);

const cacheFile = (id) => path.join(hubDir(), 'hubs', `${id}.json`);
const worthFile = () => path.join(hubDir(), 'worth-adding.json');
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(v));
  fs.renameSync(`${f}.tmp`, f);
};

const clean = (s, max) => oneLine(String(s || '').replace(/[\x00-\x1f\x7f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, ' '), max);

/** A YAML list value at line i (`tags: [a, b]`, `tags: a, b` or `- a` lines below). */
function listAt(lines, i) {
  const v = /^\s*tags:\s*(.*)$/.exec(lines[i])[1].trim();
  if (v) return v.replace(/^\[|\]$/g, '').split(',');
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const d = /^\s*-\s+(.+)$/.exec(lines[j]);
    if (!d) break;
    out.push(d[1]);
  }
  return out;
}

/** A skill's tags from its front matter: Hermes' `metadata.hermes.tags`, or a top-level `tags`. Lower case. */
export function skillTags(raw) {
  const lines = String(raw || '').split('\n');
  let hermes = -1; // the indent of the `hermes:` line while inside it
  let found = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const ind = l.length - l.trimStart().length;
    if (/^\s+hermes:\s*$/.test(l)) {
      hermes = ind;
      continue;
    }
    if (hermes >= 0 && l.trim() && ind <= hermes) hermes = -1;
    if (hermes >= 0 && /^\s+tags:/.test(l)) {
      found = listAt(lines, i);
      break;
    }
    if (/^tags:/.test(l) && !found.length) found = listAt(lines, i);
  }
  const out = [];
  for (const t of found) {
    const s = t.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9 ._+#-]{0,39}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 20);
}

/** What the scout keeps of one SKILL.md: { name, path, description, tags }, or null when it has no usable name. */
export function readSkill(dir, text) {
  const fm = parseFrontMatter(text);
  const declared = typeof fm.data.name === 'string' ? fm.data.name.trim() : '';
  const name = safeName(declared) ? declared : path.posix.basename(dir);
  if (!safeName(name)) return null;
  return { name, path: dir, description: clean(fm.data.description, 300), tags: fm.ok ? skillTags(fm.raw) : [] };
}

/**
 * The skills of a hub at its newest commit: { id, url, commit, readAt, skills, skipped }. Read again only when the
 * hub's commit moved (the list is cached in the skillhub's state folder with the commit it was read from). Network:
 * git ls-remote, a blob-less fetch of that one commit, and the SKILL.md files.
 */
export async function listHub(h, { now = Date.now } = {}) {
  const url = gitUrl(h);
  const commit = await latestCommit(url);
  const cached = readJson(cacheFile(h.id));
  if (cached && cached.commit === commit && cached.url === h.url && Array.isArray(cached.skills)) return cached;
  fs.mkdirSync(hubDir(), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(hubDir(), 'hub-'));
  try {
    await fetchCommit(tmp, url, commit);
    // No -l: a size would make git fetch every blob of the repository; the size is checked after the one read.
    const tree = await git(['ls-tree', '-r', '-z', commit], { cwd: tmp });
    const skills = [];
    const skipped = [];
    for (const item of tree.split('\0')) {
      const m = /^(\d+) (\w+) [0-9a-f]+\t(.+)$/s.exec(item);
      if (!m || m[2] !== 'blob' || !/\/SKILL\.md$/.test(m[3])) continue;
      const dir = m[3].slice(0, -'/SKILL.md'.length);
      if (!h.folders.some((f) => dir.startsWith(`${f}/`)) || !safeRel(dir) || /(^|\/)node_modules\//.test(dir)) continue;
      if (m[1] !== '100644' && m[1] !== '100755') {
        skipped.push(`${dir}: its SKILL.md is not a plain file`);
        continue;
      }
      if (skills.length >= MAX_SKILLS) {
        skipped.push(`more than ${MAX_SKILLS} skills: the rest were not read`);
        break;
      }
      const text = await showFile(tmp, commit, `${dir}/SKILL.md`);
      if (text === null || Buffer.byteLength(text) > LIMITS.textBytes) {
        skipped.push(`${dir}: its SKILL.md could not be read or is larger than ${LIMITS.textBytes / 1024 / 1024} MB`);
        continue;
      }
      const s = readSkill(dir, text);
      if (s) skills.push(s);
      else skipped.push(`${dir}: no usable skill name`);
    }
    const out = { id: h.id, url: h.url, commit, readAt: now(), skills, skipped: skipped.slice(0, 50) };
    writeJson(cacheFile(h.id), out);
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** One word as it is compared: lower case, letters and digits only, "next.js"/"nextjs" → "next". */
export const norm = (w) => String(w || '').toLowerCase().replace(/\.?js$/, '').replace(/[^a-z0-9]/g, '');
const BROAD = new Set(['code', 'web', 'server', 'multi-repo']); // fit almost every hub skill

/** A project's technology words from detect.mjs: Map(word → evidence). */
export function techWords(det) {
  const words = new Map();
  const add = (w, why) => {
    const n = norm(w);
    if (n.length >= 2 && !words.has(n)) words.set(n, why);
  };
  for (const deps of Object.values(det.deps)) {
    for (const [dep, d] of Object.entries(deps)) {
      const why = `${d.where} has ${dep}`;
      add(dep, why);
      const parts = dep.split('/').filter((p) => p && !/^v\d+$/.test(p));
      if (parts.length > 1) add(parts.at(-1), why);
      if (dep.startsWith('@') && parts[0] !== '@types') add(parts[0], why);
    }
  }
  for (const [s, why] of Object.entries(det.stacks)) if (!BROAD.has(s)) add(s, why);
  return words;
}

/** "because shop's package.json has next" / "because shop has Dockerfile". */
export function reasonText(project, why) {
  const found = /^(.*) found( \(.+\))?$/.exec(why);
  return found ? `because ${project} has ${found[1]}${found[2] || ''}` : `because ${project}'s ${why}`;
}

/** Names of the skills installed for the person or in one of `projects`. */
function installedNames(projects) {
  const names = new Set();
  for (const sc of [{}, ...projects.map((p) => ({ project: p.path }))]) {
    try {
      for (const s of listInstalled(scopeOf(sc))) names.add(s.name);
    } catch {
      /* a folder that went away */
    }
  }
  return names;
}

/**
 * The weekly scout (no model): for each project, its technology words; a hub skill fits when one of its tags or a
 * word of its name is one of them. Resolves { at, results: [{ hub, hubName, license, name, path, commit,
 * description, tags, why: [reasons], project }], lines: [what failed] }. A failing hub is a line, never thrown. It only reads:
 * nothing is installed. `list` is for tests.
 */
export async function scout({ hubs, projects, now = Date.now, list = listHub } = {}) {
  const lines = [];
  const results = [];
  const dets = [];
  for (const p of projects) {
    try {
      dets.push({ name: p.name || path.basename(p.path), path: p.path, words: techWords(detectProject(p.path)) });
    } catch (e) {
      lines.push(`${p.name || p.path}: ${e.message}`);
    }
  }
  const have = installedNames(projects);
  for (const h of hubs) {
    let listing;
    try {
      listing = await list(h, { now });
    } catch (e) {
      lines.push(`${h.name}: ${String(e.message).split('\n')[0]}`);
      continue;
    }
    for (const s of listing.skills) {
      if (have.has(s.name) || results.some((r) => r.name === s.name)) continue;
      const why = [];
      let project = null; // the first project it fits: its Review adds it there
      const mine = [...s.tags, ...s.name.split(/[-_.]/)].map(norm).filter(Boolean);
      for (const d of dets) {
        const w = mine.find((x) => d.words.has(x));
        if (w) {
          why.push(reasonText(d.name, d.words.get(w)));
          project ||= d.path;
        }
      }
      if (why.length) results.push({ hub: h.id, hubName: h.name, license: h.license, name: s.name, path: s.path, commit: listing.commit, description: s.description, tags: s.tags, why: why.slice(0, 3), project });
    }
  }
  return { at: now(), results: results.slice(0, MAX_RESULTS), lines: lines.slice(0, 20) };
}

/** The last scout's results, kept beside the weekly check's settings. */
export const saveWorth = (w) => writeJson(worthFile(), w);
export function readWorth() {
  const w = readJson(worthFile());
  return w && Array.isArray(w.results) ? { at: Number(w.at) || 0, results: w.results, lines: Array.isArray(w.lines) ? w.lines : [] } : { at: 0, results: [], lines: [] };
}

/** For the page: the last scout's results, without the skills installed since (for the person or in its project). */
export function worthNow({ allowed = null } = {}) {
  const w = readWorth();
  const names = (sc) => {
    try {
      return listInstalled(scopeOf(sc, allowed)).map((s) => s.name);
    } catch {
      return []; // no skills folder yet, or a folder no longer inside the dashboard's folders
    }
  };
  const mine = new Set(names({}));
  const results = w.results.filter((r) => !mine.has(r.name) && !(r.project && names({ project: r.project }).includes(r.name)));
  return { at: w.at, results, lines: w.lines };
}

/** The hub skills the last scout read that match some words (name, description, tags), for the search. */
export function findInHubs(words, hubs, limit = 15) {
  const terms = String(words || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
  if (!terms.length) return [];
  const out = [];
  for (const h of hubs) {
    const c = readJson(cacheFile(h.id));
    if (!c || !Array.isArray(c.skills) || c.url !== h.url) continue;
    for (const s of c.skills) {
      const text = `${s.name} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (s.name.toLowerCase().includes(t) ? 2 : text.includes(t) || text.replace(/\./g, '').includes(t) ? 1 : 0), 0);
      if (score) out.push({ score, hub: h.id, hubName: h.name, license: h.license, name: s.name, path: s.path, commit: c.commit, description: s.description, tags: s.tags || [] });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit).map(({ score, ...r }) => r);
}

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The review request of a hub skill { hub, path, commit } → { spec, commit, hub }; the address comes from the hub list. */
export function hubReviewSpec(b, hubs) {
  const h = hubs.find((x) => x.id === b.hub);
  if (!h) throw fail(404, 'no such skill hub');
  if (typeof b.path !== 'string' || !safeRel(b.path) || !h.folders.some((f) => b.path.startsWith(`${f}/`))) throw fail(400, `the skill's folder must be inside ${h.name}'s skill folders`);
  if (typeof b.commit !== 'string' || !HEX40.test(b.commit)) throw fail(400, 'a commit is its full 40-character id');
  // A GitHub hub as owner/repo/path, so the review and the installed skill name it as any GitHub skill is named.
  return { spec: h.url.startsWith('file://') ? `${h.url}#${b.path}` : `${h.repo}/${b.path}`, commit: b.commit, hub: h };
}

/** A licence of the skill's own: its front matter's `license`, or a licence file in its folder; '' when none. */
function ownLicense(fm, folder) {
  const declared = typeof fm.data.license === 'string' ? fm.data.license.trim() : '';
  if (declared) return declared.slice(0, 120);
  try {
    const f = fs.readdirSync(folder).find((n) => /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(n));
    return f ? `see ${f}` : '';
  } catch {
    return '';
  }
}

/** What a review of a hub skill shows of the hub: its name, address, licence and notice, and the skill's own licence. */
export function hubOfReview(h, fm, folder) {
  return { id: h.id, name: h.name, url: h.url, license: h.license, notice: h.notice, own: ownLicense(fm, folder) };
}

const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n';

/** The text of the NOTICE a hub skill without a licence of its own gets. */
export function noticeText(hub) {
  return `This skill comes from ${hub.name} (${hub.url}) and has no licence of its own, so the hub's licence applies: ${hub.license}.\n\n${hub.notice ? `${hub.notice}\n\n` : ''}${hub.license === 'MIT' ? MIT : `See the licence of ${hub.url}.\n`}`;
}

/**
 * At Add of a reviewed hub skill: when it has no licence of its own, write the hub's notice and licence into a NOTICE
 * file beside its files (in quarantine, after the files were checked against the review) and return the file list
 * with it, so the install copies it and the manifest records its hash. Otherwise the reviewed list as it was.
 */
export function addHubNotice(review) {
  if (!review.hub || review.hub.own) return review.files;
  const rel = review.files.some((f) => f.path.toLowerCase() === 'notice') ? 'NOTICE.hub.txt' : 'NOTICE';
  const buf = Buffer.from(noticeText(review.hub));
  fs.writeFileSync(path.join(review.folder, rel), buf, { mode: 0o644, flag: 'wx' });
  return [...review.files, { path: rel, size: buf.length, mode: 0o644, kind: 'text', sha256: sha256(buf) }];
}
