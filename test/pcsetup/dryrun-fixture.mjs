// A rich project world for the --dry-run tests, in a temporary home, and a full snapshot of it. Nothing leaves this
// computer: the "GitHub" is a folder of bare repositories reached through git's insteadOf, gh is a stand-in
// (fake-gh.mjs), and every Hoprig folder (settings, state, Claude Code's folder, the workspace) is inside the home.
//
// The world, as a computer looks after a plain `git clone` of a project and an interrupted `hoprig get` of another:
//   server/alex/shop-workspace.git   the parent of "shop": project.json (two code repositories, a memory folder), .githooks
//   server/alex/shop-api.git         .env.example (no .env), .githooks
//   server/alex/shop-web.git         package.json
//   server/alex/blog-workspace.git   the parent of "blog" (one code repository with .env.example)
//   server/alex/brain.git            the AI brain with the workspace map (shop, blog)
//   home/Workspace/ai_brain          the brain, cloned
//   home/Workspace/projects/shop     shop, its code repositories cloned by hand: no .env, no hooks path, no memory link;
//                                    the server has one commit shop-api does not have, shop-web one the server does not
//   home/Workspace/projects/notes    a repository the map does not list yet
//   home/Workspace/projects/.hoprig-clone-blog-workspace-…   an unfinished clone an earlier run of hoprig get left
//   home/.local/state/hoprig/get-locks/…/….lock              stale locks of runs that ended (for shop and for blog)
//
// With { groups: true } the map is of version 2 and has two groups as well:
//   home/Workspace/clients           a plain group: acme here (cloned by hand, like shop), zeta only in the map
//   home/Workspace/kits              a group that is a repository (server alex/kits.git), cloned, with its memory; it
//     kits/packs/tool                  holds packs (members come with it: tool, whose code repository is not cloned)
//     kits/builds/                     and builds (each member its own repository: widget, only in the map, with an
//                                      unfinished clone and a stale lock an earlier run left)
//   spare                            an empty plain group of the map, not on this computer yet
//
// With { kits: true } the projects folder holds projects that suggest the optional kits, and the computer has stand-in
// programs (bin/) that write their argv to a log OUTSIDE the world (`kitLog`), so a run that would install shows itself:
//   home/Workspace/projects/legacy     a PHP project: composer.json asks for PHP ^8.1 <8.4 (older than the 8.5 here),
//                                      and a docker-compose.yml (it suggests Docker too)
//   home/Workspace/projects/mobile     a Flutter project that pins its version (.fvmrc)
//   home/android-studio/jbr/bin/java   a made-up Android Studio's own Java (prints a version; `brokenJava()` breaks it)
//   bin/php (8.5.4), bin/dart, bin/apt-cache (php-cli 8.5, no other series), bin/java-less PATH
//
// With { find: true } (it implies groups) kits/builds has a naming rule (FIND_RULE), the sign-in reaches the
// organisation "team" too, and the "server" holds projects only it has (addFindRepos):
//   alex/shop-alpha-project  a parent without project.json (ignores code/ and apps/, has .githooks), with
//   alex/shop-alpha-app, shop-alpha-web, shop-alpha-old-api      (the last holds the word the rule leaves out)
//   team/blog-beta-project with team/blog-beta-app, blog-beta-web, blog-beta-api
//   alex/shop-alpha, alex/a-b-c-project, alex/zine-gamma-app     what does not fit: no fixed ending, another count of
//                                                                hyphens, a code repository without a parent
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE_TMP = os.tmpdir(); // before any world sets TMPDIR to its own folder
const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));
const DEAD_PID = 2147483000; // no process has it

export const gh = (name) => `https://github.com/alex/${name}.git`;

/**
 * A stand-in that Node runs itself (`file` named as the program, `mjs` the script it runs): no sh stands between the
 * product and the script on any system. Git for Windows' sh, started by a native program, expands wildcards in its
 * arguments and dies on one such as `.[].login` (an access violation) before the script runs; the runner's wrap starts
 * a `#!/usr/bin/env node` file through Node there, and Linux and macOS through the line itself.
 */
export function nodeStandIn(file, mjs) {
  fs.writeFileSync(file, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(mjs).href)};\n`, { mode: 0o755 });
  return file;
}

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, rel.startsWith('.githooks/') ? { mode: 0o755 } : {});
  }
}

export async function makeWorld(name, { groups = false, find = false, kits = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(BASE_TMP, `hoprig-dry-${name}-`)));
  const home = path.join(root, 'home');
  const ws = path.join(home, 'Workspace');
  const projects = path.join(ws, 'projects');
  const server = path.join(root, 'server');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  for (const d of [home, server, bin, tmp, path.join(server, 'alex'), path.join(server, 'team')]) fs.mkdirSync(d, { recursive: true });
  const gitcfg = path.join(root, 'gitconfig');
  fs.writeFileSync(gitcfg, `[user]\n\tname = Test Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[url "${String(server).replaceAll('\\', '/')}/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n`);
  nodeStandIn(path.join(bin, 'gh'), FAKE_GH);
  const env = {
    HOME: home, USERPROFILE: home, HOPRIG_CONFIG_DIR: path.join(home, '.config', 'hoprig'), HOPRIG_STATE_DIR: path.join(home, '.local', 'state', 'hoprig'),
    HOPRIG_PROFILES_DIR: path.join(home, '.config', 'hoprig', 'profiles'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), HOPRIG_WORKSPACE_DIR: ws,
    GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', FAKE_GH_ROOT: server, FAKE_GH_USER: 'alex', FAKE_GH_ORGS: find ? 'team' : '', TMPDIR: tmp,
  };
  // A Windows home always has its AppData folders, and its programs are told where they are: without them a dry run
  // there showed "added home\AppData" and "added home\AppData\Roaming", two empty folders (what made them is not
  // known; anything written inside them would still show as a change).
  // PowerShell (the start time of a lock's process, src/procid.mjs) keeps its own files in
  // LOCALAPPDATA\Microsoft\Windows\PowerShell (StartupProfileData-NonInteractive, written as it starts), which a real
  // home has long had: the world's home has that folder from the start, and the snapshot leaves it out, as it is the
  // system's, never Hoprig's (`systemOwn`). Its module cache is the run's one (tools/test-plan.mjs psModuleCache).
  let systemOwn = null;
  if (process.platform === 'win32') {
    Object.assign(env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
    systemOwn = path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'PowerShell');
    for (const d of [env.APPDATA, systemOwn]) fs.mkdirSync(d, { recursive: true });
  }
  const pathBefore = process.env.PATH.split(path.delimiter).filter((p) => !p.includes('hoprig-dry-')).join(path.delimiter);
  const use = () => {
    Object.assign(process.env, env, { PATH: `${bin}${path.delimiter}${pathBefore}` });
    for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR']) delete process.env[k];
  };
  use();
  const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = (repo, files, owner = 'alex') => {
    const work = path.join(root, 'seed', owner, repo);
    writeTree(work, files);
    sh(work, 'init', '-q', '-b', 'main');
    sh(work, 'add', '-A');
    sh(work, 'commit', '-q', '-m', 'start');
    execFileSync('git', ['clone', '-q', '--bare', work, path.join(server, owner, `${repo}.git`)]);
    fs.rmSync(work, { recursive: true, force: true });
    return owner === 'alex' ? gh(repo) : `https://github.com/${owner}/${repo}.git`;
  };
  const clone = (url, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    execFileSync('git', ['clone', '-q', url, dest]);
    return dest;
  };
  const commit = (dir, file, text) => {
    fs.writeFileSync(path.join(dir, file), text);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', `change ${file}`);
  };
  const hook = '#!/bin/sh\nexit 0\n';
  const shopJson = { name: 'shop', repos: [{ dir: 'code/shop-api', url: gh('shop-api') }, { dir: 'code/shop-web', url: gh('shop-web') }], memories: { '.': 'ai_brain/claude-memory' } };
  remote('shop-workspace', { 'AGENTS.md': '# shop\n', '.gitignore': '/code/*\n!/code/.gitignore\n.env\n', 'code/.gitignore': '*\n!.gitignore\n', 'project.json': `${JSON.stringify(shopJson, null, 2)}\n`, 'ai_brain/claude-memory/MEMORY.md': '# memory\n', '.githooks/pre-commit': hook });
  remote('shop-api', { 'README.md': '# api\n', '.gitignore': '.env\n', '.env.example': 'API_KEY=\n', '.githooks/pre-commit': hook });
  remote('shop-web', { 'README.md': '# web\n', 'package.json': '{ "name": "shop-web", "private": true }\n' });
  const blogJson = { name: 'blog', repos: [{ dir: 'code/blog-app', url: gh('blog-app') }], memories: { '.': 'ai_brain/claude-memory' } };
  remote('blog-workspace', { 'AGENTS.md': '# blog\n', '.gitignore': '/code/*\n!/code/.gitignore\n', 'code/.gitignore': '*\n!.gitignore\n', 'project.json': `${JSON.stringify(blogJson, null, 2)}\n`, 'ai_brain/claude-memory/MEMORY.md': '# memory\n' });
  remote('blog-app', { 'README.md': '# app\n', '.gitignore': '.env\n', '.env.example': 'DB=\n' });
  remote('notes', { 'README.md': '# notes\n' });
  remote('brain', { 'BRAIN.md': '# brain\n', 'claude/CLAUDE.md': '# rules\n', 'claude-memory/home/.gitkeep': '', 'skills/.gitkeep': '' });

  // On the computer: the brain, shop cloned by hand, a repository the map does not list yet.
  const brain = clone(gh('brain'), path.join(ws, 'ai_brain'));
  const shop = clone(gh('shop-workspace'), path.join(projects, 'shop'));
  clone(gh('shop-api'), path.join(shop, 'code', 'shop-api'));
  clone(gh('shop-web'), path.join(shop, 'code', 'shop-web'));
  // The map: shop (with its code repositories) and blog, which is not on this computer.
  const map = {
    version: 1, brain: { url: gh('brain') }, config: { projectsDir: 'projects' },
    projects: [
      { name: 'blog', url: gh('blog-workspace'), repos: [{ dir: 'code/blog-app', url: gh('blog-app') }], memories: { '.': 'ai_brain/claude-memory' } },
      { name: 'shop', url: gh('shop-workspace'), repos: [{ dir: 'code/shop-api', url: gh('shop-api') }, { dir: 'code/shop-web', url: gh('shop-web') }], memories: { '.': 'ai_brain/claude-memory' } },
    ],
    others: [],
  };
  const g = groups || find ? await addGroups({ ws, remote, clone, gh, find }) : null;
  if (g) Object.assign(map, g.map, { projects: [...map.projects, ...g.map.projects] });
  commit(brain, 'workspace.json', `${JSON.stringify(map, null, 2)}\n`);
  sh(brain, 'push', '-q');
  clone(gh('notes'), path.join(projects, 'notes'));
  // The server moves on (a commit shop-api here has not fetched); shop-web has a commit of its own to push.
  const seed = clone(gh('shop-api'), path.join(root, 'seed', 'shop-api-2'));
  commit(seed, 'CHANGES.md', 'newer\n');
  sh(seed, 'push', '-q');
  fs.rmSync(seed, { recursive: true, force: true });
  commit(path.join(shop, 'code', 'shop-web'), 'TODO.md', 'mine\n');

  // What an interrupted hoprig get left: an unfinished clone of blog under its temporary name, and stale locks.
  const { tempNameFor, lockPathFor } = await import('../../src/pcsetup/leftovers.mjs');
  const blogRef = { url: gh('blog-workspace'), repo: 'blog-workspace' };
  const leftover = path.join(projects, tempNameFor(blogRef));
  fs.mkdirSync(leftover);
  sh(leftover, 'init', '-q', '-b', 'main');
  sh(leftover, 'remote', 'add', 'origin', gh('blog-workspace'));
  const locks = [lockPathFor(projects, blogRef), lockPathFor(projects, { url: gh('shop-workspace'), repo: 'shop-workspace' })];
  const old = new Date(Date.now() - 3_600_000);
  for (const l of locks) {
    fs.mkdirSync(path.dirname(l), { recursive: true });
    fs.writeFileSync(l, `${JSON.stringify({ pid: DEAD_PID, proc: 'gone', id: 'earlier' })}\n`);
    fs.utimesSync(l, old, old);
  }
  const k = kits ? addKitWorld({ root, home, projects, bin }) : null;
  if (g) {
    // What an interrupted get of widget left in kits/builds: an unfinished clone and a stale lock.
    const widgetRef = { url: gh('widget-workspace'), repo: 'widget-workspace' };
    const left = path.join(g.builds, tempNameFor(widgetRef));
    fs.mkdirSync(left, { recursive: true });
    sh(left, 'init', '-q', '-b', 'main');
    sh(left, 'remote', 'add', 'origin', gh('widget-workspace'));
    const l = lockPathFor(g.builds, widgetRef);
    fs.mkdirSync(path.dirname(l), { recursive: true });
    fs.writeFileSync(l, `${JSON.stringify({ pid: DEAD_PID, proc: 'gone', id: 'earlier' })}\n`);
    fs.utimesSync(l, old, old);
    locks.push(l);
    Object.assign(g, { widgetLeftover: left });
  }
  // Let every mtime settle before the first snapshot (a write in the same instant would look the same).
  await new Promise((r) => setTimeout(r, 20));
  return { root, home, ws, projects, server, tmp, systemOwn, env, use, sh, shop, brain, leftover, locks, groups: g, ...(k || {}), cleanup: () => {
    fs.rmSync(root, { recursive: true, force: true });
    if (k) k.cleanupLog();
  } };
}

/** The projects and stand-in programs of a { kits: true } world (see the head of this file). */
function addKitWorld({ home, projects, bin }) {
  const logDir = fs.mkdtempSync(path.join(BASE_TMP, 'hoprig-kitlog-'));
  const kitLog = path.join(logDir, 'argv.log');
  writeTree(path.join(projects, 'legacy'), { 'composer.json': `${JSON.stringify({ name: 'example/legacy', require: { php: '^8.1 <8.4' } }, null, 2)}\n`, 'index.php': '<?php echo "hi";\n', 'docker-compose.yml': 'services: {}\n' });
  // Its `android` folder holds a Gradle file: the one project here that needs Java, so Java is looked for.
  writeTree(path.join(projects, 'mobile'), { '.fvmrc': '{ "flutter": "3.24.5" }\n', 'pubspec.yaml': 'name: mobile\n' });
  writeTree(path.join(projects, 'mobile', 'android'), { 'build.gradle': '' });
  const standIn = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${kitLog}"\n${body}\n`, { mode: 0o755 });
  standIn('php', 'echo "PHP 8.5.4-0ubuntu1.5 (cli) (built: Oct 1 2026)"');
  standIn('dart', 'exit 0');
  standIn('apt-cache', 'case "$1 $2" in "policy php-cli") printf "php-cli:\\n  Installed: (none)\\n  Candidate: 2:8.5+99ubuntu1\\n" ;; "pkgnames php") printf "php-cli\\nphp8.5-cli\\n" ;; *) printf "  Candidate: (none)\\n" ;; esac');
  const java = path.join(home, 'android-studio', 'jbr', 'bin', 'java');
  fs.mkdirSync(path.dirname(java), { recursive: true });
  fs.writeFileSync(java, `#!/bin/sh\necho "java $*" >> "${kitLog}"\necho 'openjdk version "21.0.6" 2025-01-21' >&2\n`, { mode: 0o755 });
  return {
    kitLog, java,
    kitCalls: () => (fs.existsSync(kitLog) ? fs.readFileSync(kitLog, 'utf8').split('\n').filter(Boolean) : []),
    clearKitLog: () => fs.rmSync(kitLog, { force: true }),
    brokenJava: () => fs.writeFileSync(java, '#!/bin/sh\nexit 3\n', { mode: 0o755 }),
    cleanupLog: () => fs.rmSync(logDir, { recursive: true, force: true }),
  };
}

/**
 * The groups of a { groups: true } world: their repositories on the "server", what is on the computer, and the map's
 * entries (version 2). → { map: { version, groups, projects }, clients, kits, builds, acme, tool }
 */
async function addGroups({ ws, remote, clone, gh, find }) {
  const hook = '#!/bin/sh\nexit 0\n';
  const acmeJson = { name: 'acme', repos: [{ dir: 'code/acme-app', url: gh('acme-app') }], memories: { '.': 'ai_brain/claude-memory' } };
  remote('acme-workspace', { 'AGENTS.md': '# acme\n', '.gitignore': '/code/*\n!/code/.gitignore\n', 'code/.gitignore': '*\n!.gitignore\n', 'project.json': `${JSON.stringify(acmeJson, null, 2)}\n`, 'ai_brain/claude-memory/MEMORY.md': '# memory\n', '.githooks/pre-commit': hook });
  remote('acme-app', { 'README.md': '# app\n', '.gitignore': '.env\n', '.env.example': 'TOKEN=\n' });
  remote('zeta-workspace', { 'AGENTS.md': '# zeta\n', 'project.json': `${JSON.stringify({ name: 'zeta', repos: [], memories: {} }, null, 2)}\n` });
  remote('extra-workspace', { 'AGENTS.md': '# extra\n', 'project.json': `${JSON.stringify({ name: 'extra', repos: [], memories: {} }, null, 2)}\n` });
  remote('widget-workspace', { 'AGENTS.md': '# widget\n', 'project.json': `${JSON.stringify({ name: 'widget', repos: [], memories: {} }, null, 2)}\n` });
  remote('tool-core', { 'README.md': '# core\n', '.gitignore': '.env\n', '.env.example': 'PORT=\n' });
  const toolJson = { name: 'tool', repos: [{ dir: 'code/tool-core', url: gh('tool-core') }], memories: {} };
  remote('kits', {
    'AGENTS.md': '# kits\n', '.gitignore': '/builds/*/\n/packs/*/code/\n', 'ai_brain/claude-memory/MEMORY.md': '# kits memory\n',
    'packs/tool/AGENTS.md': '# tool\n', 'packs/tool/project.json': `${JSON.stringify(toolJson, null, 2)}\n`,
  });
  const clients = path.join(ws, 'clients');
  const acme = clone(gh('acme-workspace'), path.join(clients, 'acme'));
  clone(gh('acme-app'), path.join(acme, 'code', 'acme-app'));
  const kits = clone(gh('kits'), path.join(ws, 'kits'));
  const builds = path.join(kits, 'builds'); // made by the leftover below; spare/ is not on this computer yet
  const map = {
    version: 2,
    groups: [
      { dir: 'clients' },
      { dir: 'kits', url: gh('kits'), holds: [{ dir: 'packs', parent: 'group' }, { dir: 'builds', ...(find ? { find: FIND_RULE } : {}) }], memories: { '.': 'ai_brain/claude-memory' } },
      { dir: 'spare' },
    ],
    projects: [
      { name: 'acme', in: 'clients', url: gh('acme-workspace'), repos: [{ dir: 'code/acme-app', url: gh('acme-app') }], memories: { '.': 'ai_brain/claude-memory' } },
      { name: 'zeta', in: 'clients', url: gh('zeta-workspace'), repos: [] },
      { name: 'tool', in: 'kits/packs', url: null, repos: [{ dir: 'code/tool-core', url: gh('tool-core') }] },
      { name: 'widget', in: 'kits/builds', url: gh('widget-workspace'), repos: [] },
    ],
  };
  if (find) addFindRepos(remote);
  return { map, clients, kits, builds, acme, tool: path.join(kits, 'packs', 'tool') };
}

/** The naming rule of kits/builds in a { find: true } world. */
export const FIND_RULE = { parent: '{project}-{product}-project', code: '{project}-{product}-*', folder: '{product}-{project}', make: ['code', 'apps'], skip: ['old'] };

function addFindRepos(remote) {
  const parent = (name) => ({ 'AGENTS.md': `# ${name}\n`, '.gitignore': '/code/\n/apps/\n', '.githooks/pre-commit': '#!/bin/sh\nexit 0\n', 'config/settings.txt': 'built by another tool\n' });
  const code = (name) => ({ 'README.md': `# ${name}\n`, '.gitignore': '.env\n', '.env.example': 'KEY=\n' });
  remote('shop-alpha-project', parent('shop'));
  for (const n of ['shop-alpha-app', 'shop-alpha-web', 'shop-alpha-old-api']) remote(n, code(n));
  remote('blog-beta-project', parent('blog'), 'team');
  for (const n of ['blog-beta-app', 'blog-beta-web', 'blog-beta-api']) remote(n, code(n), 'team');
  for (const n of ['shop-alpha', 'a-b-c-project', 'zine-gamma-app']) remote(n, { 'README.md': `# ${n}\n` });
}

const typeOf = (st) => (st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other');

/** The name of `p` in a snapshot: relative to the world's root, with "/" between its parts on every system. */
export const keyOf = (world, p) => path.relative(world.root, p).split(path.sep).join('/');

/**
 * Everything in the world (its own temporary folder left out, and checked empty instead; on Windows PowerShell's own
 * folder left out, see makeWorld): every path with its type,
 * size, mode, modification time and inode, a hash of every file, where each link points; then the refs and HEAD of
 * every repository, the bare "server" repositories among them.
 */
export function snapshot(world) {
  const out = new Map();
  const gitDirs = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (p === world.tmp || p === world.systemOwn) continue;
      const st = fs.lstatSync(p);
      const rel = keyOf(world, p);
      const e = { type: typeOf(st), size: st.size, mode: st.mode, mtime: st.mtimeMs, ino: st.ino };
      if (e.type === 'file') e.hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      if (e.type === 'link') e.to = fs.readlinkSync(p);
      out.set(rel, e);
      if (e.type === 'dir') {
        if (name === '.git' || (name.endsWith('.git') && fs.existsSync(path.join(p, 'HEAD')))) gitDirs.push(p);
        walk(p);
      }
    }
  };
  walk(world.root);
  for (const g of gitDirs) {
    const refs = execFileSync('git', ['--git-dir', g, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' });
    let head = '';
    try {
      head = execFileSync('git', ['--git-dir', g, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      head = '(no commit)';
    }
    out.set(`refs:${keyOf(world, g)}`, { refs, head });
  }
  out.set('tmp:', { left: fs.readdirSync(world.tmp).sort() });
  return out;
}

/** What differs between two snapshots, one line each ("" when nothing). */
export function changes(a, b) {
  const lines = [];
  for (const [k, v] of a) {
    if (!b.has(k)) lines.push(`removed ${k}`);
    else if (JSON.stringify(v) !== JSON.stringify(b.get(k))) lines.push(`changed ${k}: ${Object.keys(v).filter((x) => JSON.stringify(v[x]) !== JSON.stringify(b.get(k)[x])).join(', ')}`);
  }
  for (const k of b.keys()) if (!a.has(k)) lines.push(`added ${k}`);
  return lines.join('\n');
}

/** A ui that collects what is said and has no terminal to ask in (or answers from `answers`). */
export async function quietUi({ interactive = false, answers = null, ...o } = {}) {
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const lines = [];
  const asked = [];
  const ui = makeUi({ interactive, write: (s) => lines.push(s), askLine: async (q) => (asked.push(q), answers ? answers(q) : ''), ...o });
  ui.lines = lines;
  ui.asked = asked;
  ui.text = () => lines.join('');
  return ui;
}

/**
 * One world for a test, removed after it, with `unchanged(what, fn)` (asserts fn changed nothing at all) and
 * `changed(what, fn)` (asserts it changed something: the world is real).
 */
export async function dryWorld(tc, name, opts = {}) {
  const assert = (await import('node:assert/strict')).default;
  const w = await makeWorld(name, opts);
  tc.after(() => w.cleanup());
  // { reports: n }: a command that is not a dry run ends with a field report (src/field): exactly n report files of
  // Hoprig's state folder are added, with the folders they need, and nothing else of the computer changes.
  w.unchanged = async (what, fn, { reports = 0 } = {}) => {
    w.use();
    const before = snapshot(w);
    const r = await fn();
    const lines = changes(before, snapshot(w)).split('\n').filter(Boolean);
    const state = keyOf(w, process.env.HOPRIG_STATE_DIR);
    const field = `${state}/field`;
    const reportsDir = `${field}/reports`;
    const made = lines.filter((l) => l.startsWith(`added ${reportsDir}/`) && /-[0-9a-f]{16}\.json$/.test(l));
    const folders = new Set([`added ${field}`, `added ${reportsDir}`, `changed ${state}: size, mtime`, `changed ${reportsDir}: size, mtime`, `changed ${state}: mtime`, `changed ${reportsDir}: mtime`]);
    const rest = lines.filter((l) => !made.includes(l) && !(made.length && folders.has(l)));
    assert.equal(rest.join('\n'), '', `${what} changed the computer:\n${rest.join('\n')}`);
    assert.equal(made.length, reports, `${what}: ${made.length} field report(s) made, ${reports} expected`);
    return r;
  };
  w.changed = async (what, fn) => {
    w.use();
    const before = snapshot(w);
    const r = await fn();
    const diff = changes(before, snapshot(w));
    assert.notEqual(diff, '', `${what} without --dry-run changed nothing: the world is not real`);
    return { r, diff };
  };
  return w;
}

/** A command's main(args, { ui, write }) run with a quiet ui. → { code, text, ui } */
export async function runCli(fn, args, uiOpts = {}) {
  const ui = await quietUi(uiOpts);
  const out = [];
  const code = await fn(args, { ui, write: (s) => out.push(s) });
  return { code, text: ui.text() + out.join(''), ui };
}
