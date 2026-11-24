// The built-in catalog (catalog.json): skills that were opened and read before they were listed, each pinned to
// the commit that was read. It drives `suggest` (no AI: signals from the project's manifests) and lets
// `add <id> --yes` skip the prompt, because that exact commit was reviewed already.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRel } from './scan.mjs';
import { signalEvidence, validSignal } from './detect.mjs';

const FILE = fileURLToPath(new URL('./catalog.json', import.meta.url));
/** The package's own folder: a bundled entry's `bundled` path is relative to it. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const packageVersion = () => JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
/** The folder of a bundled entry inside this package. */
export const bundledDir = (e) => path.join(PACKAGE_ROOT, e.bundled);

/** Problems with a catalog object, as plain sentences; [] when it is complete and well-formed. */
export function validateCatalog(cat) {
  const errs = [];
  if (!cat || cat.version !== 1 || !Array.isArray(cat.entries)) return ['catalog: version 1 with an entries array'];
  const ids = new Set();
  for (const [i, e] of cat.entries.entries()) {
    const at = `entry ${i} (${e && e.id})`;
    if (!e || typeof e !== 'object') {
      errs.push(`${at}: not an object`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(e.id || '')) errs.push(`${at}: id must be lower-case letters, digits and hyphens`);
    if (ids.has(e.id)) errs.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(e.skill || '') || /--/.test(e.skill)) errs.push(`${at}: skill must be the SKILL.md name (a-z, 0-9, single hyphens)`);
    if (typeof e.for !== 'string' || e.for.length < 10 || e.for.length > 240) errs.push(`${at}: "for" is one sentence (10–240 characters)`);
    if (e.bundled !== undefined) {
      // Shipped inside this package: no repository, no commit; the installed package is its integrity.
      if (e.repo !== undefined || e.commit !== undefined || e.path !== undefined) errs.push(`${at}: a bundled entry has no repo, path or commit`);
      if (!safeRel(e.bundled || '') || !fs.existsSync(path.join(PACKAGE_ROOT, e.bundled, 'SKILL.md'))) errs.push(`${at}: bundled must be a folder of this package with a SKILL.md`);
    } else {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.repo || '')) errs.push(`${at}: repo is owner/repo on GitHub`);
      if (e.path !== '' && !safeRel(e.path)) errs.push(`${at}: path must be relative inside the repository`);
      if (!/^[0-9a-f]{40}$/.test(e.commit || '')) errs.push(`${at}: commit must be a full 40-hex commit id`);
    }
    if (e.scope !== undefined && e.scope !== 'user' && e.scope !== 'project') errs.push(`${at}: scope is "user" or "project"`);
    if (typeof e.license !== 'string' || !e.license.trim()) errs.push(`${at}: license is required`);
    if (!Array.isArray(e.signals) || !e.signals.length) errs.push(`${at}: at least one signal`);
    else for (const s of e.signals) if (!validSignal(s)) errs.push(`${at}: bad signal "${s}"`);
    if (e.tool !== undefined) {
      const t = e.tool;
      if (!t || !/^[a-z0-9-]+$/.test(t.id || '') || !/^[A-Za-z0-9._-]+$/.test(t.bin || '') || !/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(t.npm || '') || !Array.isArray(t.versionArgs)) errs.push(`${at}: tool needs id, bin, npm and versionArgs`);
    }
  }
  return errs;
}

let cached = null;
/** The catalog, validated once (a broken catalog is a bug in this repository: it throws). */
export function loadCatalog() {
  if (cached) return cached;
  const cat = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const errs = validateCatalog(cat);
  if (errs.length) throw new Error(`skill catalog: ${errs.join('; ')}`);
  cached = cat;
  return cat;
}

export const catalogEntry = (id) => loadCatalog().entries.find((e) => e.id === id) || null;

/** Entries matching some words (id, skill name, purpose, repository, signals), best first. */
export function searchCatalog(words) {
  const terms = String(words || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = loadCatalog().entries.map((e) => {
    // A word in the name or purpose counts more than one in a signal.
    const text = [e.id, e.skill, e.for, e.repo || 'hoprig'].join(' ').toLowerCase();
    const main = `${text} ${text.replace(/\./g, '')}`; // "Next.js" also matches "nextjs"
    const sig = e.signals.join(' ').toLowerCase();
    return { e, score: terms.reduce((n, t) => n + (main.includes(t) ? 2 : sig.includes(t) ? 1 : 0), 0) };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.e);
}

/** The catalog entries a detected project calls for, each with its reasons, strongest first. */
export function suggestFor(project) {
  const out = [];
  for (const e of loadCatalog().entries) {
    const why = [];
    for (const s of e.signals) {
      const ev = signalEvidence(project, s);
      if (ev && !why.includes(ev)) why.push(ev);
    }
    if (why.length) {
      const strong = e.signals.some((s) => !s.startsWith('stack:') && s !== 'always' && signalEvidence(project, s));
      // A bundled entry comes first: it is the one skill every project gets offered; Hoprig's own skill before the rest.
      out.push({ entry: e, why, score: e.bundled ? (e.id === 'hoprig' ? 1001 : 1000) : why.length + (strong ? 3 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}
