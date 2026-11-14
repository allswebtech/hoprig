// The skills manager's operations, shared by the command line (cli.mjs), the dashboard (feature.mjs) and the
// guided first run (runSkillsStep): find, suggest, review → approve, update with a diff, remove, undo.
//
// Taking a skill is installing software from the internet that an AI agent will follow with the user's
// permissions. So: it is fetched into a quarantine folder (never straight into a skills folder), pinned to one
// commit, scanned, and shown in full; it is copied into place only after a yes, and only if the files are still
// exactly the ones that were reviewed. Nothing from a skill is ever run here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bundledDir, catalogEntry, loadCatalog, packageVersion, searchCatalog, suggestFor } from './catalog.mjs';
import { detectProject } from './detect.mjs';
import { diffText, folderDiff } from './diff.mjs';
import { guessLicense, oneLine, parseFrontMatter } from './frontmatter.mjs';
import { scanSkill } from './scan.mjs';
import { SourceError, checkoutFolder, chooseFolder, fetchCommit, latestCommit, parseSpec, showFile, treeOf } from './source.mjs';
import { StoreError, hashFolder, hubDir, listInstalled, localEdits, placeSkill, readManifest, removeSkill, safeName, scopeOf, sha256, skillPath, undoSkill } from './store.mjs';

const REVIEW_ID = /^[a-f0-9]{24}$/;
const QUARANTINE_MAX_AGE = 24 * 3600_000;
const quarantineRoot = () => path.join(hubDir(), 'quarantine');
const reviewFile = (id) => path.join(quarantineRoot(), id, 'review.json');

export class HubError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Quarantine folders older than a day are review leftovers nobody approved: remove them. */
function sweepQuarantine() {
  try {
    for (const d of fs.readdirSync(quarantineRoot())) {
      const p = path.join(quarantineRoot(), d);
      if (Date.now() - fs.statSync(p).mtimeMs > QUARANTINE_MAX_AGE) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* no quarantine yet */
  }
}

/** Read the license of a fetched skill: its front matter, a license file in it, then the repository's. */
async function readLicense(fm, folder, repoDir, commit) {
  const declared = fm.data.license ? String(fm.data.license).trim() : '';
  const fromFile = (dir) => {
    try {
      const f = fs.readdirSync(dir).find((n) => /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(n));
      return f ? guessLicense(fs.readFileSync(path.join(dir, f), 'utf8')) || `see ${f}` : '';
    } catch {
      return '';
    }
  };
  if (declared && !/LICEN[CS]E|terms/i.test(declared)) return declared;
  const local = fromFile(folder);
  if (local) return local;
  if (repoDir) {
    for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
      const t = await showFile(repoDir, commit, f);
      if (t) return guessLicense(t) || `see ${f} in the repository`;
    }
  }
  return declared || 'not stated';
}

/** The text form of every file of a folder that is text, for the diff ({ rel: { sha256, text|null } }). */
function textMap(root, files) {
  const out = {};
  for (const f of files) {
    if (f.kind === 'symlink') continue;
    const buf = fs.readFileSync(path.join(root, f.path));
    out[f.path] = { sha256: sha256(buf), text: f.kind === 'binary' || f.kind === 'asset' || buf.length > 512 * 1024 ? null : buf.toString('utf8') };
  }
  return out;
}

/**
 * Fetch a skill into quarantine and build its review. `spec`: a catalog id, owner/repo[/path], owner/repo@skill
 * or a git URL. `opts`: { project, commit, update: { name } (internal), allowed }. Returns the review (also saved
 * next to the files, so a later approve can check nothing changed).
 */
export async function prepare(spec, opts = {}) {
  sweepQuarantine();
  const scopeHint = opts.project ? { project: opts.project } : {};
  const entry = typeof spec === 'string' && !spec.includes('/') && !spec.includes(':') ? catalogEntry(spec) : null;
  if (!entry && typeof spec === 'string' && /^[a-z0-9-]+$/.test(spec) && !spec.includes('@')) throw new HubError(`"${spec}" is not in the catalog; try: hoprig skills find ${spec}`, 404);
  const scope = scopeOf(entry && entry.scope === 'user' && !opts.forceProject ? {} : scopeHint, opts.allowed);
  const id = crypto.randomBytes(12).toString('hex');
  const qdir = path.join(quarantineRoot(), id);
  fs.mkdirSync(qdir, { recursive: true, mode: 0o700 });
  try {
    let folder;
    let source;
    let repoDir = null;
    if (entry && entry.bundled) {
      // Shipped with hoprig: copied from the installed package, which is its integrity; no network.
      folder = path.join(qdir, 'skill');
      fs.cpSync(bundledDir(entry), folder, { recursive: true, verbatimSymlinks: true });
      source = { type: 'bundled', catalogId: entry.id, path: entry.bundled, version: packageVersion() };
    } else {
      const src = entry
        ? { url: `https://github.com/${entry.repo}.git`, repo: entry.repo, path: entry.path, ref: null, skill: null }
        : parseSpec(spec);
      const want = (entry && !opts.latest ? entry.commit : null) || opts.commit || src.ref || 'HEAD';
      if (opts.commit && !/^[0-9a-f]{40}$/.test(opts.commit)) throw new HubError('a commit is its full 40-character id');
      repoDir = path.join(qdir, 'repo');
      const commit = await fetchCommit(repoDir, src.url, want);
      const rel = await chooseFolder(repoDir, commit, src, async (p) => parseFrontMatter(await showFile(repoDir, commit, p ? `${p}/SKILL.md` : 'SKILL.md')).data.name || null);
      const tree = await treeOf(repoDir, commit, rel);
      folder = await checkoutFolder(repoDir, commit, rel);
      source = { type: 'git', url: src.url, repo: src.repo, path: rel, ref: src.ref, commit, tree, catalogId: entry ? entry.id : null };
    }
    const scan = scanSkill(folder, { hash: sha256 });
    const skillMd = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    const fm = parseFrontMatter(skillMd);
    const folderName = path.basename(source.path || '') || path.basename(String(source.repo || source.url || 'skill')).replace(/\.git$/, '');
    const name = opts.update ? opts.update.name : safeName(String(fm.data.name || '')) ? String(fm.data.name) : safeName(folderName) ? folderName : null;
    if (!name) scan.findings.unshift({ file: 'SKILL.md', line: 1, rule: 'bad-skill-name', severity: 'block', message: `neither the name "${fm.data.name}" nor the folder name can be a skill folder name` });
    const license = source.type === 'bundled' ? entry.license : await readLicense(fm, folder, repoDir, source.commit);
    const pinned = Boolean(entry && (entry.bundled || (source.commit === entry.commit && !opts.latest)));
    const review = {
      id, createdAt: new Date().toISOString(), kind: opts.update ? 'update' : 'add',
      scope: { kind: scope.kind, project: scope.root, dir: scope.dir },
      name, description: String(fm.data.description || ''), license, source, pinned,
      catalog: entry ? { id: entry.id, for: entry.for, license: entry.license, notes: entry.notes || null, tool: entry.tool || null } : null,
      skillMd, folder, files: scan.files, total: scan.total, findings: scan.findings, counts: scan.counts,
    };
    if (name && !opts.update) {
      const target = skillPath(scope, name);
      const rec = readManifest(scope.dir).skills[name];
      if (fs.existsSync(target)) {
        review.findings.unshift(rec
          ? { file: '', line: 0, rule: 'installed', severity: 'block', message: `"${name}" is installed already; to change it use: hoprig skills update ${name}` }
          : { file: '', line: 0, rule: 'name-taken', severity: 'block', message: `a skill folder "${name}" is already there and was not installed by Hoprig; it is left alone` });
        review.counts.block++;
      }
    }
    if (opts.update) {
      const cur = skillPath(scope, name);
      const rec = readManifest(scope.dir).skills[name];
      const installed = scanSkill(cur, { hash: sha256 });
      review.diff = folderDiff(textMap(cur, installed.files), textMap(folder, scan.files));
      review.from = rec ? { commit: rec.source.commit || null, version: rec.source.version || null } : null;
      review.localEdits = rec ? localEdits(rec.files || {}, hashFolder(cur)) : [];
      const before = new Set(installed.findings.map((f) => `${f.rule}|${f.file}|${f.excerpt}`));
      for (const f of review.findings) f.new = !before.has(`${f.rule}|${f.file}|${f.excerpt}`);
    }
    fs.writeFileSync(reviewFile(id), JSON.stringify(review));
    return review;
  } catch (e) {
    fs.rmSync(qdir, { recursive: true, force: true });
    if (e instanceof SourceError || e instanceof StoreError) throw new HubError(e.message, e.status);
    throw e;
  }
}

export function loadReview(id) {
  if (!REVIEW_ID.test(String(id || ''))) throw new HubError('bad review id');
  try {
    return JSON.parse(fs.readFileSync(reviewFile(id), 'utf8'));
  } catch {
    throw new HubError('that review is gone (approved, cancelled or older than a day); start again', 404);
  }
}

export function cancel(id) {
  if (!REVIEW_ID.test(String(id || ''))) throw new HubError('bad review id');
  fs.rmSync(path.join(quarantineRoot(), id), { recursive: true, force: true });
}

/**
 * Install (or update to) a reviewed skill: refused when the scan found a blocking problem, when the files changed
 * since the review, or (update) when the installed skill was edited by hand and `overwriteLocal` is not set.
 */
export function approve(id, { overwriteLocal = false } = {}) {
  const review = loadReview(id);
  if (review.counts.block > 0) throw new HubError(`not installed: ${review.findings.filter((f) => f.severity === 'block').map((f) => f.message).join('; ')}`, 409);
  const now = scanSkill(review.folder, { hash: sha256 });
  const want = new Map(review.files.map((f) => [f.path, f.sha256 || f.link]));
  if (now.files.length !== review.files.length || now.files.some((f) => want.get(f.path) !== (f.sha256 || f.link))) {
    cancel(id);
    throw new HubError('the files changed after the review; nothing was installed', 409);
  }
  if (review.kind === 'update' && review.localEdits && review.localEdits.length && !overwriteLocal) {
    throw new HubError(`"${review.name}" was edited here (${review.localEdits.join(', ')}); not replaced. Approve with "overwrite local edits" to replace it (the edited version is kept for undo).`, 409);
  }
  const scope = { kind: review.scope.kind, root: review.scope.project, dir: review.scope.dir };
  const record = { source: review.source, license: review.license };
  try {
    placeSkill(scope, review.name, review.folder, review.files, record);
  } catch (e) {
    if (e instanceof StoreError) throw new HubError(e.message, e.status);
    throw e;
  } finally {
    cancel(id);
  }
  return { name: review.name, dir: path.join(scope.dir, review.name), scope: scope.kind, source: review.source };
}

/** One recorded skill: is there a newer version? { name, state: 'current'|'update'|'edited'|'unknown', … }. */
export async function checkOne(scope, name, rec) {
  const edited = (() => {
    try {
      return localEdits(rec.files || {}, hashFolder(skillPath(scope, name)));
    } catch {
      return ['missing'];
    }
  })();
  const base = { name, source: rec.source, edited };
  const s = rec.source || {};
  if (s.type === 'bundled') {
    const entry = catalogEntry(s.catalogId);
    if (!entry) return { ...base, state: 'unknown', note: 'no longer in this Hoprig' };
    const fresh = hashFolder(bundledDir(entry));
    const same = Object.keys(fresh).length === Object.keys(rec.files || {}).length && Object.entries(fresh).every(([p, h]) => rec.files[p] === h);
    return { ...base, state: same ? 'current' : 'update', latest: packageVersion() };
  }
  if (s.type !== 'git') return { ...base, state: 'unknown' };
  const latest = await latestCommit(s.url, s.ref);
  if (latest === s.commit) return { ...base, state: 'current', latest };
  // The repository moved; did the skill's own folder change? Compare git tree ids (no file contents fetched).
  const tmp = fs.mkdtempSync(path.join(hubDir(), 'check-'));
  try {
    await fetchCommit(tmp, s.url, latest);
    let tree = null;
    try {
      tree = await treeOf(tmp, latest, s.path);
    } catch {
      return { ...base, state: 'update', latest, note: 'the skill folder is gone from the repository' };
    }
    return { ...base, state: tree === s.tree ? 'current' : 'update', latest, moved: tree === s.tree };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Check every recorded skill of a scope (network: git ls-remote, and a tree fetch when the repo moved). */
export async function checkUpdates(scopeOpts = {}, { only = null, allowed = null } = {}) {
  const scope = scopeOf(scopeOpts, allowed);
  fs.mkdirSync(hubDir(), { recursive: true });
  const recs = readManifest(scope.dir).skills;
  const names = Object.keys(recs).filter((n) => !only || n === only);
  if (only && !names.length) throw new HubError(`"${only}" was not installed by Hoprig here, so its source is unknown`, 404);
  return Promise.all(names.map((n) => checkOne(scope, n, recs[n]).catch((e) => ({ name: n, source: recs[n].source, state: 'unknown', error: e.message, edited: [] }))));
}

/** Build the review of an update for one recorded skill (fetches the newest version into quarantine). */
export async function prepareUpdate(name, scopeOpts = {}, { allowed = null } = {}) {
  const scope = scopeOf(scopeOpts, allowed);
  const rec = readManifest(scope.dir).skills[name];
  if (!rec) throw new HubError(`"${name}" was not installed by hoprig here; its source is unknown`, 404);
  const s = rec.source;
  if (s.type === 'bundled') return prepare(s.catalogId, { project: scope.root, forceProject: scope.kind === 'project', update: { name }, allowed });
  const spec = s.repo ? `${s.repo}/${s.path}`.replace(/\/$/, '') : `${s.url}#${s.path}`;
  return prepare(spec, { project: scope.root, update: { name }, allowed, commit: await latestCommit(s.url, s.ref) });
}

export function remove(name, scopeOpts = {}, { allowed = null } = {}) {
  try {
    removeSkill(scopeOf(scopeOpts, allowed), name);
  } catch (e) {
    if (e instanceof StoreError) throw new HubError(e.message, e.status);
    throw e;
  }
}

export function undo(name, scopeOpts = {}, { allowed = null } = {}) {
  try {
    return undoSkill(scopeOf(scopeOpts, allowed), name);
  } catch (e) {
    if (e instanceof StoreError) throw new HubError(e.message, e.status);
    throw e;
  }
}

export function installed(scopeOpts = {}, { allowed = null } = {}) {
  const scope = scopeOf(scopeOpts, allowed);
  return { kind: scope.kind, root: scope.root, dir: scope.dir, skills: listInstalled(scope) };
}

/** The catalog's suggestions for a project, with reasons, marked when already installed (here or for the user). */
export function suggest(project, { allowed = null } = {}) {
  const scope = scopeOf({ project }, allowed);
  const det = detectProject(scope.root);
  const have = new Set([...listInstalled(scope), ...listInstalled(scopeOf({}))].map((s) => s.name));
  const list = suggestFor(det).map(({ entry, why }) => ({
    id: entry.id, name: entry.skill, for: entry.for, license: entry.license,
    source: entry.bundled ? 'bundled with hoprig' : `${entry.repo}/${entry.path}@${entry.commit.slice(0, 7)}`,
    scope: entry.scope === 'user' ? 'user' : 'project', why, installed: have.has(entry.skill), tool: entry.tool ? entry.tool.id : null,
    command: entry.scope === 'user' ? `hoprig skills add ${entry.id} --user` : `hoprig skills add ${entry.id} --project ${scope.root}`,
  }));
  // Stacks the catalog has nothing for yet: a search the user can run.
  const covered = new Set(list.flatMap((s) => (catalogEntry(s.id).signals || [])));
  const ideas = [];
  const WORDS = { go: 'golang', rust: 'rust', python: 'python', docker: 'docker', ci: 'github actions', postgres: 'postgres', flutter: 'flutter', 'react-native': 'react native', electron: 'electron' };
  for (const [stack, words] of Object.entries(WORDS)) if (det.stacks[stack] && !covered.has(`stack:${stack}`) && !list.some((s) => s.why.some((w) => w === det.stacks[stack]))) ideas.push(`hoprig skills find ${words}`);
  return { project: scope.root, stacks: det.stacks, artifacts: det.artifacts, repos: det.repos, suggestions: list, ideas };
}

// ---- find: the catalog plus the public skills.sh search (the same API the `skills` CLI's `find` calls) ----

const searchBase = () => process.env.SKILLS_API_URL || 'https://skills.sh';
const licenseCache = new Map();

/** A GitHub repository's license (SPDX id) from the public API, or ''. Sends only the repository name. */
async function githubLicense(repo, fetchImpl) {
  if (licenseCache.has(repo)) return licenseCache.get(repo);
  let out = '';
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hoprig-skills' }, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const j = await r.json();
      out = (j.license && j.license.spdx_id !== 'NOASSERTION' && j.license.spdx_id) || '';
    }
  } catch {
    /* unknown */
  }
  licenseCache.set(repo, out);
  return out;
}

/**
 * Search: { catalog: [...], online: [{ name, source, installs, add, license }], error }. `fetchImpl` for tests.
 * What leaves the machine: the words (to skills.sh) and, for the license column, the repository names (to GitHub).
 */
export async function find(words, { fetchImpl = fetch, licenses = true, limit = 15 } = {}) {
  const q = String(words || '').trim().slice(0, 100);
  if (!q) throw new HubError('say what to look for, e.g.: hoprig skills find nextjs');
  const catalog = searchCatalog(q).map((e) => ({ id: e.id, name: e.skill, for: e.for, license: e.license, source: e.bundled ? 'bundled with Hoprig' : `${e.repo}/${e.path}`, add: e.id, pinned: e.bundled ? 'bundled' : e.commit.slice(0, 7) }));
  let online = [];
  let error = null;
  try {
    const r = await fetchImpl(`${searchBase()}/api/search?${new URLSearchParams({ q })}`, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'hoprig-skills' } });
    if (!r.ok) throw new Error(`the search answered ${r.status}`);
    const j = await r.json();
    online = (Array.isArray(j.skills) ? j.skills : []).slice(0, limit).map((s) => {
      const source = String(s.source || '').replace(/[^\w./@-]/g, '');
      const name = String(s.skillId || s.name || '').replace(/[^\w.:-]/g, '');
      const gh = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
      return { name, source, installs: Number(s.installs) || 0, add: gh ? `${source}@${name}` : null, license: '' };
    });
  } catch (e) {
    error = `online search unavailable: ${e.message}`;
  }
  if (licenses) {
    const repos = [...new Set(online.filter((o) => o.add).map((o) => o.source))].slice(0, 8);
    const got = Object.fromEntries(await Promise.all(repos.map(async (r) => [r, await githubLicense(r, fetchImpl)])));
    for (const o of online) o.license = got[o.source] || '';
  }
  return { query: q, catalog, online, error };
}

// ---- for the guided first run and the "Get started" checklist ----

/**
 * The skills state as data: { user: { dir, installed }, project: { root, dir, installed, suggested } | null,
 * updates: [{ scope, name, latest, edited }], checked }. `check: false` skips the network (no update check).
 */
export async function skillsStatus({ project = null, check = true, allowed = null } = {}) {
  const user = installed({}, { allowed });
  const proj = project ? installed({ project }, { allowed }) : null;
  const suggested = project ? suggest(project, { allowed }) : null;
  // Without a project, the catalog's skills meant for the user (the bundled one) are still offered.
  const have = new Set(user.skills.map((s) => s.name));
  const forUser = loadCatalog().entries.filter((e) => e.scope === 'user' && !have.has(e.skill)).map((e) => ({ id: e.id, name: e.skill, for: e.for, why: ['it comes with Hoprig and helps in every project'], command: `hoprig skills add ${e.id} --user` }));
  const updates = [];
  if (check) {
    for (const [label, opts] of [['user', {}], ...(project ? [['project', { project }]] : [])]) {
      for (const u of await checkUpdates(opts, { allowed })) if (u.state === 'update') updates.push({ scope: label, name: u.name, latest: u.latest || null, edited: u.edited });
    }
  }
  return {
    user: { dir: user.dir, installed: user.skills, suggested: forUser },
    project: proj ? { root: proj.root, dir: proj.dir, installed: proj.skills, suggested: suggested.suggestions, ideas: suggested.ideas } : null,
    updates, checked: check,
  };
}

/** The review as plain text lines for a terminal. */
export function reviewText(r, { full = true } = {}) {
  const L = [];
  const where = r.scope.kind === 'user' ? `for you (${r.scope.dir})` : `for the project ${r.scope.project} (${r.scope.dir})`;
  L.push(`Review: ${r.kind === 'update' ? 'update' : 'add'} the skill "${r.name || '?'}" ${where}`);
  const s = r.source;
  L.push(`  Source:   ${s.type === 'bundled' ? `bundled with Hoprig ${s.version} (${s.path})` : `${s.repo || s.url}${s.path ? `/${s.path}` : ''} at commit ${s.commit}`}`);
  if (r.catalog) L.push(`  Catalog:  ${r.catalog.id}${r.pinned ? ' (the reviewed, pinned version)' : ' (a NEWER commit than the one in the catalog)'}`);
  L.push(`  License:  ${r.license}`);
  L.push(`  About:    ${oneLine(r.description, 300)}`);
  if (r.catalog && r.catalog.notes) L.push(`  Note:     ${r.catalog.notes}`);
  if (r.from) L.push(`  From:     ${r.from.commit || r.from.version} → ${s.commit || s.version}`);
  L.push('', `Files (${r.files.length}, ${Math.round(r.total / 1024)} KB):`);
  for (const f of r.files) L.push(`  ${f.kind === 'script' || f.kind === 'binary' || f.kind === 'symlink' ? '!' : ' '} ${String(f.size).padStart(8)}  ${f.path}${f.kind !== 'text' ? `  [${f.kind}]` : ''}`);
  L.push('', `Scan: ${r.counts.block} blocking, ${r.counts.high} high, ${r.counts.medium} medium, ${r.counts.low} low`);
  for (const f of r.findings) L.push(`  [${f.severity}${f.new ? ', new' : ''}] ${f.file}${f.line ? `:${f.line}` : ''}  ${f.message}${f.excerpt ? `\n        ${f.excerpt}` : ''}`);
  if (r.localEdits && r.localEdits.length) L.push('', `Edited here since it was installed: ${r.localEdits.join(', ')}`);
  if (r.diff) {
    L.push('', 'What changed:');
    return [...L, ...diffLines(r.diff), ...(full ? ['', '----- SKILL.md (new) -----', r.skillMd, '----- end of SKILL.md -----'] : [])];
  }
  if (full) L.push('', '----- SKILL.md -----', r.skillMd, '----- end of SKILL.md -----');
  return L;
}

const diffLines = (d) => {
  const t = diffText(d);
  return t.length ? t.map((l) => `  ${l}`) : ['  (no file changed)'];
};

/**
 * One step of a guided setup: suggest skills for `project` and add the ones the person approves, one review and
 * one question per skill. `ui`: { say(line), confirm(question) → Promise<boolean> }. With `yes` (no person to ask)
 * only bundled or catalog-pinned entries are added; with `dryRun` nothing is fetched or installed.
 * Resolves { ok, added: [name], skipped: [{ id, why }] }.
 */
export async function runSkillsStep({ ui = consoleUi(), project = process.cwd(), yes = false, dryRun = false, allowed = null } = {}) {
  const added = [];
  const skipped = [];
  let ok = true;
  let s;
  try {
    s = suggest(project, { allowed });
  } catch (e) {
    ui.say(`Skills: ${e.message}`);
    return { ok: false, added, skipped };
  }
  const todo = s.suggestions.filter((x) => !x.installed);
  if (!todo.length) {
    ui.say('Skills: everything the catalog suggests for this project is installed.');
    return { ok: true, added, skipped };
  }
  ui.say(`Skills suggested for ${s.project}:`);
  for (const x of todo) ui.say(`  ${x.id} (${x.scope === 'user' ? 'for you' : 'this project'}): ${x.for}\n      why: ${x.why.join('; ')}`);
  for (const x of todo) {
    if (dryRun) {
      skipped.push({ id: x.id, why: 'dry run' });
      continue;
    }
    let review;
    try {
      review = await prepare(x.id, { project: s.project, allowed });
    } catch (e) {
      ok = false;
      skipped.push({ id: x.id, why: e.message });
      ui.say(`  ${x.id}: ${e.message}`);
      continue;
    }
    for (const line of reviewText(review, { full: !yes })) ui.say(line);
    if (review.counts.block) {
      cancel(review.id);
      skipped.push({ id: x.id, why: 'the review found a blocking problem' });
      continue;
    }
    const go = yes ? review.pinned : await ui.confirm(`Add "${review.name}" ${review.scope.kind === 'user' ? 'for you' : 'to this project'}?`);
    if (!go) {
      cancel(review.id);
      skipped.push({ id: x.id, why: yes ? 'not a pinned catalog version; needs a person' : 'not approved' });
      continue;
    }
    try {
      added.push(approve(review.id).name);
    } catch (e) {
      ok = false;
      skipped.push({ id: x.id, why: e.message });
    }
  }
  return { ok, added, skipped };
}

/** A terminal ui for runSkillsStep and the CLI: asks only on a real terminal (otherwise the answer is no). */
export function consoleUi({ input = process.stdin, output = process.stdout } = {}) {
  return {
    say: (line) => output.write(`${line}\n`),
    confirm: async (q) => {
      if (!input.isTTY) return false;
      const rl = (await import('node:readline/promises')).createInterface({ input, output });
      try {
        return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

export { loadCatalog };
