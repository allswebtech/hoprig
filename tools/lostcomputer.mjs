// The release proof that a lost computer costs nothing (RELEASING.md). One run builds a workspace on a temporary
// home A as an owner has it (an AI brain with memory, a credentials repository, a group holding one member, three
// projects with code repositories, work in progress), runs the upkeep and a drop as he would, keeps what the
// whole-computer check (`hoprig pc leave --check`) names, DELETES home A, restores on a second home B that has only
// the git server, and compares every repository A had: each branch's head and every tracked file of it, the work not
// committed, and the memory folders. The proof holds when the only differences are ones the check had named.
//
// The git server is a stand-in: bare repositories in a folder of the run's own, reached through made-up
// https://git.example.test/ addresses that each home's own git settings turn into those folders; no protocol but
// file is allowed. It runs only behind the suite's runner (tools/test.mjs), in folders of the temporary folder.
//
// Every product step runs as a child process (`node bin/hoprig.mjs …`, or tools/lostcomputer-step.mjs for the
// upkeep's engines and the check) with that home's own environment. This process never switches its own
// environment: the product reads the home, the settings and the workspace folder from it, and a module that kept
// a value of it, or a step that failed half-way, would otherwise leave the runner's process pointing at a home.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bare, commit, compare, git, gitSettings, namedBy, snapHome, write } from './lostcomputer-git.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'hoprig.mjs');
const STEP = path.join(ROOT, 'tools', 'lostcomputer-step.mjs');
export const PREFIX = 'hoprig-lostcomputer-';
export const REFUSED = 'tools/lostcomputer.mjs runs only behind the suite\'s runner (node tools/test.mjs test/workspace/lostcomputer.test.mjs), in a temporary home: nothing was made.';
const STEP_MS = 120_000;

const within = (p, top) => p === top || p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Why this run may not go on, or '' (the runner's traps, a home that is not the account's own). */
export function refusal(env = process.env) {
  if (!env.HOPRIG_TEST_TRAPS || !fs.existsSync(env.HOPRIG_TEST_TRAPS)) return REFUSED;
  if (!env.HOME || !path.isAbsolute(env.HOME) || real(env.HOME) === real(os.userInfo().homedir) || !within(real(env.HOME), real(os.tmpdir())) || real(env.HOME) === real(os.tmpdir())) return REFUSED;
  return '';
}

/** A home's environment: its own home, settings, state, workspace, Claude folder and git settings, nothing inherited of git. */
function homeEnv(base, home) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!/^(GIT_|XDG_CONFIG_HOME$|XDG_STATE_HOME$|XDG_DATA_HOME$|HOPRIG_(CONFIG|STATE|PROFILES|WORKSPACE|TOOLS)_DIR$|CLAUDE_CONFIG_DIR$)/.test(k)) env[k] = v;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    HOPRIG_CONFIG_DIR: path.join(home, '.config', 'hoprig'),
    HOPRIG_STATE_DIR: path.join(home, '.local', 'state', 'hoprig'),
    HOPRIG_PROFILES_DIR: path.join(home, '.config', 'hoprig', 'profiles'),
    HOPRIG_WORKSPACE_DIR: path.join(home, 'Workspace'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
  };
}

/** The projects of the map: name → { parent files, code repositories }. Made-up names only. */
const PROJECTS = {
  shop: { code: ['shop-api', 'shop-web'], memory: true },
  blog: { code: ['blog-site'] },
  notes: { code: ['notes-app'] },
};
const MEMBER = { group: 'kits', place: 'packs', name: 'tool', code: 'tool-core' };
const DROPPED = 'shop';

/** The stand-in server, filled as the owner's other computers left it. → the map */
function fillServer(env, server, scratch) {
  const map = { version: 2, brain: { url: bare(env, server, 'brain') }, credentials: { url: bare(env, server, 'credentials', { 'README.md': '# credentials\n', 'shop/shop.env': 'KEY=example-not-a-secret\n' }, scratch) }, groups: [], projects: [], others: [] };
  for (const [name, p] of Object.entries(PROJECTS)) {
    const repos = p.code.map((c) => ({ dir: `code/${c}`, url: bare(env, server, c, { 'README.md': `# ${c}\n`, 'src/index.js': `export const name = '${c}';\n` }, scratch) }));
    const memories = p.memory ? { '.': 'ai_brain/claude-memory' } : {};
    const files = { 'project.json': `${JSON.stringify({ name, repos, memories }, null, 2)}\n`, '.gitignore': '/code/*\n', 'README.md': `# ${name}\n` };
    if (p.memory) files['ai_brain/claude-memory/MEMORY.md'] = `# ${name} memory\n`;
    map.projects.push({ name, url: bare(env, server, `${name}-workspace`, files, scratch), ...(p.memory ? { memories } : {}), repos });
  }
  const core = bare(env, server, MEMBER.code, { 'README.md': `# ${MEMBER.code}\n` }, scratch);
  const member = { dir: `code/${MEMBER.code}`, url: core };
  map.groups.push({ dir: MEMBER.group, url: bare(env, server, MEMBER.group, { '.gitignore': `/${MEMBER.place}/*/code/\n`, [`${MEMBER.place}/${MEMBER.name}/project.json`]: `${JSON.stringify({ name: MEMBER.name, repos: [member], memories: {} }, null, 2)}\n`, [`${MEMBER.place}/${MEMBER.name}/config/settings.txt`]: 'kept by the group\n' }, scratch), holds: [{ dir: MEMBER.place, parent: 'group' }] });
  map.projects.push({ name: MEMBER.name, in: `${MEMBER.group}/${MEMBER.place}`, url: null, repos: [member] });
  return map;
}

/**
 * The whole proof. opts: { env (the environment the run starts from; default process.env), afterCheck (a test's
 * hook: called with { home, ws, env, git } after the check and before home A is deleted) }.
 * → { equal, onlyNamed, differences: [{ where, what, kind, named }], named: [itemId], steps: [line], compared, refused? }
 */
export async function main(opts = {}) {
  const base = opts.env || process.env;
  const steps = [];
  const no = refusal(base);
  if (no) return { refused: no, equal: false, onlyNamed: false, differences: [], named: [], steps: [no] };
  const tmp = real(os.tmpdir());
  const root = real(fs.mkdtempSync(path.join(tmp, PREFIX)));
  if (!within(root, tmp) || root === tmp) throw new Error(`the run's folder ${root} is not inside the temporary folder`);
  const made = (name) => {
    const p = path.join(root, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  try {
    const server = made('server');
    const scratch = made('scratch');
    const homeA = made('a');
    const envA = homeEnv(base, homeA);
    gitSettings(homeA, server);
    const say = (line) => steps.push(line);
    // A product command or an engine step, in the home of `env`; a failure stops the run with what it said.
    const product = (env, what, argv) => {
      const r = spawnSync(process.execPath, argv, { env, cwd: env.HOME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: STEP_MS });
      const said = `${r.stdout || ''}${r.stderr || ''}`.trim();
      if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status ?? r.signal}): ${said.split('\n').slice(-12).join('\n')}`);
      return said;
    };
    const hoprig = (env, ...args) => product(env, `hoprig ${args.join(' ')}`, [BIN, ...args]);
    let n = 0;
    const engine = (env, step, arg) => {
      const out = path.join(scratch, `step-${++n}.json`);
      product(env, `the ${step} step`, [STEP, step, out, ...(arg === undefined ? [] : [JSON.stringify(arg)])]);
      return JSON.parse(fs.readFileSync(out, 'utf8'));
    };

    // The server, as the owner's other computers left it.
    const map = fillServer(envA, server, scratch);
    say(`the stand-in git server holds ${fs.readdirSync(path.join(server, 'team')).length} repositories`);

    // Home A: the brain made and pushed, the rest restored and fetched with the owner's own commands.
    const wsA = envA.HOPRIG_WORKSPACE_DIR;
    const brainA = path.join(wsA, 'ai_brain');
    fs.mkdirSync(wsA, { recursive: true });
    git(envA, wsA, 'clone', '-q', map.brain.url, brainA);
    write(brainA, 'workspace.json', `${JSON.stringify(map, null, 2)}\n`);
    write(brainA, 'claude-memory/MEMORY.md', '# memory\n- the workspace is kept in git\n');
    git(envA, brainA, 'add', '-A');
    git(envA, brainA, 'commit', '-q', '-m', 'The workspace map and its memory');
    git(envA, brainA, 'push', '-q', '-u', 'origin', 'main');
    hoprig(envA, 'workspace', 'restore', map.brain.url, '--yes');
    hoprig(envA, 'workspace', 'label', 'alpha');
    const names = [...Object.keys(PROJECTS), `${MEMBER.group}/${MEMBER.place}/${MEMBER.name}`];
    hoprig(envA, 'get', ...names, '--yes');
    say(`home A: the brain, the credentials, the group ${MEMBER.group} and the projects ${names.join(', ')}`);

    // Work in progress, as an owner leaves it.
    const proj = path.join(wsA, 'projects');
    const api = path.join(proj, 'shop', 'code', 'shop-api');
    git(envA, api, 'checkout', '-q', '-b', 'feature/login');
    commit(envA, api, 'src/login.js', 'export const login = () => true;\n', 'Add the login');
    git(envA, api, 'checkout', '-q', 'main');
    commit(envA, path.join(proj, 'notes', 'code', 'notes-app'), 'src/today.js', 'export const today = 1;\n', 'A commit not pushed');
    write(path.join(proj, 'blog', 'code', 'blog-site'), 'README.md', '# blog-site\nchanged and not committed\n');
    write(brainA, 'claude-memory/new-note.md', '# a new note\n');
    say('work in progress: feature/login of shop-api committed, a commit on main of notes-app, a change in blog-site not committed, a new memory file in the brain');

    // The upkeep as it runs by itself: the map with commit, memory and push; the other branches in every place; sync.
    const upkeep = (round) => {
      const m = engine(envA, 'map');
      if (m.error || m.busy) throw new Error(`the map round failed: ${m.error || m.busy}`);
      const lines = [...(m.lines || [])];
      if (round === 1) {
        const b = engine(envA, 'branches', ['projects', `${MEMBER.group}/${MEMBER.place}`]);
        lines.push(...b.repos.filter((x) => x.pushed.length).map((x) => `${x.label}: pushed ${x.pushed.join(', ')}`));
      }
      const s = engine(envA, 'sync');
      if (s.error || s.busy) throw new Error(`the sync round failed: ${s.error || s.busy}`);
      lines.push(...s.repos.flatMap((x) => x.did.map((d) => `${x.label}: ${d}`)));
      say(`upkeep round ${round}: ${lines.length ? lines.join('; ') : 'nothing to do'}`);
    };
    upkeep(1);

    // The project to drop is kept as it is now: it is compared with its fresh copy on home B too.
    const droppedDir = path.join(proj, DROPPED);
    const before = snapHome(envA, homeA, wsA, [droppedDir]);
    hoprig(envA, 'drop', DROPPED);
    if (fs.existsSync(droppedDir)) throw new Error(`hoprig drop ${DROPPED} left its folder`);
    say(`hoprig drop ${DROPPED}: dropped`);
    upkeep(2);

    // The check of the whole computer: what it names is what may differ.
    const check = engine(envA, 'check');
    const items = check.items || [];
    say(`the check named ${items.length}: ${items.map((i) => i.id).join(', ') || 'nothing'}`);
    if (opts.afterCheck) await opts.afterCheck({ home: homeA, ws: wsA, env: envA, git });

    // Home A as it is when it is lost, then gone.
    const now = snapHome(envA, homeA, wsA);
    const snap = { repos: { ...before.repos, ...now.repos }, memories: { ...before.memories, ...now.memories } };
    if (path.dirname(homeA) !== root || !within(homeA, tmp)) throw new Error(`home A ${homeA} is not the folder this run made`);
    fs.rmSync(homeA, { recursive: true, force: true });
    say(`home A deleted (${Object.keys(snap.repos).length} repositories and ${Object.keys(snap.memories).length} memory folders kept to compare)`);

    // Home B: only the git server.
    const homeB = made('b');
    const envB = homeEnv(base, homeB);
    gitSettings(homeB, server);
    hoprig(envB, 'workspace', 'restore', map.brain.url, '--yes');
    hoprig(envB, 'get', ...names, '--yes');
    say(`home B: restored, and got ${names.join(', ')}`);

    const c = compare(snap, envB, homeB);
    const differences = c.differences.map((d) => ({ where: d.where, what: d.what, kind: d.kind, named: namedBy(d, items) }));
    const onlyNamed = differences.every((d) => d.named);
    // An empty comparison proves nothing: a run that compared no branch, file or memory file is not equal.
    const something = c.compared.branches > 0 && c.compared.files > 0 && c.compared.memoryFiles > 0;
    say(`compared ${c.compared.repos} repositories, ${c.compared.branches} branches, ${c.compared.files} files and ${c.compared.memoryFiles} memory files: ${differences.length} differences, ${differences.filter((d) => !d.named).length} not named`);
    return { equal: onlyNamed && something, onlyNamed, differences, named: items.map((i) => i.id), steps, compared: c.compared };
  } finally {
    if (path.dirname(root) === tmp && root.startsWith(path.join(tmp, PREFIX))) fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The short report a person reads. */
export function report(r) {
  if (r.refused) return r.refused;
  const out = [...r.steps.map((s) => `- ${s}`)];
  for (const d of r.differences) out.push(`  ${d.named ? 'named' : 'NOT NAMED'}  ${d.where}: ${d.what}${d.named ? ` (${d.named})` : ''}`);
  out.push(r.equal ? 'A lost computer costs nothing: home B has everything home A had, except what the check named before.' : `SOMETHING WOULD BE LOST: ${r.differences.filter((d) => !d.named).length} differences the check had not named (above).`);
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  const no = refusal();
  if (no) {
    process.stderr.write(`${no}\n`);
    process.exit(2);
  }
  const r = await main();
  process.stdout.write(`${report(r)}\n`);
  process.exit(r.equal ? 0 : 1);
}
