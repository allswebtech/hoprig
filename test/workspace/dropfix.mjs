// Temporary homes for the `hoprig drop` tests: a "git server" of local bare repositories (gitfix.mjs), a brain with a
// workspace map, and a project "shop" (a parent with project.json and a memory folder, two code repositories) got onto
// a computer with `hoprig get`, so its memory link is made as it is in real use. Every computer has a label.
import strict from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitWorld, quietUi } from './gitfix.mjs';

/**
 * A regexp of drop's words whose `/` also matches `\` on Windows, where a repository is named by its path there
 * (projects\shop\code\shop-api). Elsewhere the regexp is returned as it is.
 */
export const anySep = (re) => (process.platform === 'win32' ? new RegExp(re.source.replaceAll('\\/', '[\\\\/]'), re.flags) : re);

/** assert/strict; on Windows its match and doesNotMatch read a regexp's `/` as either separator (anySep). */
export const assert = process.platform === 'win32'
  ? Object.assign((...a) => strict(...a), strict, { match: (s, re, m) => strict.match(s, anySep(re), m), doesNotMatch: (s, re, m) => strict.doesNotMatch(s, anySep(re), m) })
  : strict;

/** Before a command drop shows: a path with `\` or `:` (Windows) is quoted by showCommand, a plain one is not. */
export const Q = process.platform === 'win32' ? "'" : '';

export async function dropWorld(name, { labels = ['alpha'], group = false } = {}) {
  const w = gitWorld(`drop-${name}`);
  const u = { brain: w.bare('brain', { empty: true }), shop: w.bare('shop-workspace'), api: w.bare('shop-api'), web: w.bare('shop-web'), blog: w.bare('blog-workspace') };
  const seed = w.clone(u.shop, path.join(w.root, 'seed-shop'));
  w.commit(seed, 'project.json', JSON.stringify({ name: 'shop', repos: [{ dir: 'code/shop-api', url: u.api }, { dir: 'code/shop-web', url: u.web }], memories: { '.': 'ai_brain/claude-memory' } }, null, 2) + '\n');
  w.commit(seed, 'ai_brain/claude-memory/MEMORY.md', '# shop memory\n');
  w.commit(seed, '.gitignore', '/code/*\n.env\ntest-data/\n*.log\n');
  w.sh(seed, 'push', '-q');
  const api = w.clone(u.api, path.join(w.root, 'seed-api'));
  w.commit(api, '.gitignore', 'node_modules/\ndist/\n.env\n*.pem\n');
  w.sh(api, 'push', '-q');
  const map = { version: 2, brain: { url: u.brain }, groups: [], projects: [{ name: 'shop', url: u.shop, memories: { '.': 'ai_brain/claude-memory' }, repos: [{ dir: 'code/shop-api', url: u.api }, { dir: 'code/shop-web', url: u.web }] }, { name: 'blog', url: u.blog, repos: [] }], others: [] };
  if (group) {
    u.kits = w.bare('kits');
    u.core = w.bare('tool-core');
    const k = w.clone(u.kits, path.join(w.root, 'seed-kits'));
    w.commit(k, '.gitignore', '/packs/*/code/\n');
    w.commit(k, 'packs/tool/project.json', JSON.stringify({ name: 'tool', repos: [{ dir: 'code/tool-core', url: u.core }], memories: {} }, null, 2) + '\n');
    w.commit(k, 'packs/tool/config/settings.txt', 'kept by the group\n');
    w.sh(k, 'push', '-q');
    map.groups.push({ dir: 'kits', url: u.kits, holds: [{ dir: 'packs', parent: 'group' }] });
    map.projects.push({ name: 'tool', in: 'kits/packs', url: null, repos: [{ dir: 'code/tool-core', url: u.core }] });
  }
  const first = w.computer(labels[0]);
  first.use();
  const brain = w.clone(u.brain, path.join(first.ws, 'ai_brain'));
  fs.writeFileSync(path.join(brain, 'workspace.json'), JSON.stringify(map, null, 2) + '\n');
  w.sh(brain, 'add', '-A');
  w.sh(brain, 'commit', '-q', '-m', 'map');
  w.sh(brain, 'push', '-q', '-u', 'origin', 'main');
  const computers = [];
  for (const label of labels) {
    const c = w.computer(label);
    c.use();
    if (!fs.existsSync(path.join(c.ws, 'ai_brain'))) w.clone(u.brain, path.join(c.ws, 'ai_brain'));
    const C = await import('../../src/workspace/computer.mjs');
    if (label) await C.setLabel(label, { dir: c.ws, projects: c.projects });
    c.ctx = { dir: c.ws, projects: c.projects };
    c.brain = path.join(c.ws, 'ai_brain');
    c.shop = path.join(c.projects, 'shop');
    if (group) w.clone(u.kits, path.join(c.ws, 'kits'));
    computers.push(c);
  }
  const fileHere = (c, label = c.home.split(path.sep).pop()) => JSON.parse(fs.readFileSync(path.join(c.brain, 'computers', `${label}.json`), 'utf8'));
  return { ...w, u, computers, fileHere };
}

/** `hoprig get` of `names` on computer `c` (its own home), quietly. → { code, text } */
export async function getOn(c, names) {
  c.use();
  const { getMain } = await import('../../src/pcsetup/getproject.mjs');
  const q = await quietUi();
  const code = await getMain([...names, '--yes'], { ui: q.ui, write: () => {}, dir: c.projects });
  return { code, text: q.text() };
}

/**
 * `hoprig drop …` on computer `c`. `answers`: the owner's answers in order (a terminal then; null: no terminal).
 * `onStep`: a run stopped there (throw). → { code, text, json? }
 */
export async function dropOn(c, args, { answers = null, onStep } = {}) {
  c.use();
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const { main } = await import('../../src/workspace/dropcli.mjs');
  let text = '';
  const asked = [];
  // A list of answers in order, or a function of the question (q → the answer; null: Ctrl-C).
  const list = Array.isArray(answers) ? [...answers] : null;
  const next = (q) => (typeof answers === 'function' ? answers(q) : list && list.length ? list.shift() : null);
  const ui = makeUi({ interactive: Boolean(answers), write: (s) => (text += s), askLine: async (q) => (asked.push(q), next(q)) });
  let out = '';
  const code = await main(args, { ui, write: (s) => (out += s), ctx: c.ctx, ...(onStep ? { onStep } : {}) });
  return { code, text: text + out, asked, ...(args.includes('--json') ? { json: JSON.parse(out) } : {}) };
}

/** Every file (path, with / on every system, → content hash or link text) under `dir`, .git folders left out, and every ref of every repository in it. */
export function treeOf(dir, sh) {
  const crypto = globalThis.__dropCrypto;
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (n === '.git') {
        out[`${rel}:refs`] = sh(d, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags');
        continue;
      }
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
globalThis.__dropCrypto = await import('node:crypto');

/** The owner who says yes to the wip/ offer, pushes a default branch as a wip/ branch (2) and types the name. */
export const owner = (name = 'shop', branch = '2') => (q) => (/\(y\/N\)/.test(q) ? 'y' : /Type the project/.test(q) ? name : q.trim() === '>' ? branch : null);

/** Take the project off `c` by hand (a test's own act) and get it again: a fresh clone with its memory link. */
export async function reset(c, name = 'shop') {
  c.use();
  for (const n of fs.existsSync(c.projects) ? fs.readdirSync(c.projects) : []) if (n === name || n.startsWith(`.${name}.dropping-`)) fs.rmSync(path.join(c.projects, n), { recursive: true, force: true });
  const r = await getOn(c, [name]);
  if (r.code !== 0) throw new Error(r.text);
  return r;
}

/** A ref of a bare repository on the server, or ''. */
export const onServer = (w, repo, ref) => {
  try {
    return w.sh(path.join(w.server, 'team', `${repo}.git`), 'rev-parse', '--verify', '-q', ref);
  } catch {
    return '';
  }
};
/** The server's branches of a bare repository: { name: sha }. */
export const serverHeads = (w, repo) => Object.fromEntries(w.sh(path.join(w.server, 'team', `${repo}.git`), 'for-each-ref', '--format=%(refname:lstrip=2) %(objectname)', 'refs/heads').split('\n').filter(Boolean).map((l) => l.split(' ')));
