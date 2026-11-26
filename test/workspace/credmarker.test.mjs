// No value and no file name of the credentials folder ever leaves through Hoprig. A marker value is put in a
// credential file and a marker in its name; then everything that touches the credentials runs on a temporary home
// (credentials show, --repo, workspace link, status and --json, sync, the upkeep with the credentials switch, get of a
// project with a link) and the dashboard's workspace answers are asked. Both markers are searched for in every output,
// the map, every file of Hoprig's state and config folders (activity lines, notifications, logs), the dashboard's
// answers, and the whole history and index of every repository but the credentials one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, runCli } from '../pcsetup/dryrun-fixture.mjs';
import { SHELL_STANDINS } from '../seal.mjs';

// The stand-in gh (and ssh) of these tests are shell scripts: on Windows the runner starts them through sh.
const SH_GH = SHELL_STANDINS;

const ws = await import('../../src/workspace/cli.mjs');
const { getMain } = await import('../../src/pcsetup/getproject.mjs');
const { upkeepCredentials } = await import('../../src/workspace/credrepo.mjs');
const { apply } = await import('../../src/automation/workspacesync.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
const VALUE = 'MARKVALUE-c0ffee-4242';
const NAME = 'markname-beef17';

/** Every file below `dir` (text of each), for the search. */
function allText(dir) {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath ?? e.path, e.name);
    if (e.isFile()) out += `\n${p}\n${fs.readFileSync(p, 'latin1')}`;
  }
  return out;
}

test('the marker value and the marker name are in no output, log, map, answer or other repository', SH_GH, async (tc) => {
  const w = await dryWorld(tc, 'credmarker');
  const said = [];
  const cli = async (args, uiOpts) => {
    const r = await runCli((a, o) => ws.main(a, o), args, uiOpts);
    said.push(`$ workspace ${args.join(' ')}\n${r.text}`);
    return r;
  };
  assert.equal((await cli(['map', '--upgrade', '--yes'])).code, 0);
  const c = path.join(w.ws, 'credentials');
  fs.mkdirSync(path.join(c, 'blog'), { recursive: true });
  // The linked file holds the marker value; a second file, which no project.json names, has the marker in its name
  // (a target a project.json names is the owner's own text in his project and is said as such: point 11).
  fs.writeFileSync(path.join(c, 'blog', 'blog.env'), `DB_PASSWORD=${VALUE}\n`);
  fs.writeFileSync(path.join(c, 'blog', `${NAME}.env`), `OTHER=${VALUE}\n`);
  fs.chmodSync(c, 0o700);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(w.server, 'alex', 'credentials.git')]);

  await cli(['credentials']);
  await cli(['credentials', '--repo', gh('credentials'), '--dry-run']);
  await cli(['credentials', '--repo', gh('credentials'), '--dry-run', '--json']);
  assert.equal((await cli(['credentials', '--repo', gh('credentials')], { interactive: true, answers: () => 'credentials' })).code, 0);
  await cli(['credentials', '--json']);

  // A project whose project.json links the marked file (blog, fetched with get).
  const seed = path.join(w.root, 'seed', 'blog-marker');
  w.sh(w.root, 'clone', '-q', gh('blog-workspace'), seed);
  const pj = JSON.parse(fs.readFileSync(path.join(seed, 'project.json'), 'utf8'));
  pj.credentials = { '.env.local': 'blog/blog.env' };
  fs.writeFileSync(path.join(seed, 'project.json'), `${JSON.stringify(pj, null, 2)}\n`);
  fs.appendFileSync(path.join(seed, '.gitignore'), '/.env.local\n');
  w.sh(seed, 'commit', '-q', '-am', 'link');
  w.sh(seed, 'push', '-q');
  fs.rmSync(seed, { recursive: true, force: true });
  const g = await runCli((a, o) => getMain(a, o), ['blog', '--yes']);
  said.push(g.text);
  assert.equal(fs.readFileSync(path.join(w.projects, 'blog', '.env.local'), 'utf8'), `DB_PASSWORD=${VALUE}\n`, 'the link is made (the marker is really reachable)');
  await cli(['link', '--dry-run']);
  await cli(['link', '--yes']);
  await cli(['status']);
  await cli(['status', '--json']);
  await cli(['status', '--all', '--json']);
  await cli(['map', '--dry-run', '--json']);
  await cli(['auto', '--credentials', 'on', '--json']);

  // A change in the folder, then sync and the upkeep's round with the switch on (and once public: not pushed, told).
  fs.writeFileSync(path.join(c, 'blog', `${NAME}.env`), `OTHER=${VALUE}-2\n`);
  fs.writeFileSync(path.join(c, 'blog', 'blog.env'), `DB_PASSWORD=${VALUE}-2\n`);
  said.push(JSON.stringify(await syncAll({ dir: w.ws, projects: w.projects, push: true, upkeep: true })));
  said.push(JSON.stringify(await syncAll({ dir: w.ws, projects: w.projects, push: true, dryRun: true })));
  const records = [];
  const notes = [];
  const ctx = () => ({ record: (x) => records.push(x), notify: (x) => notes.push(x), data: {}, save: () => {}, workspaceCredentials: () => upkeepCredentials({ dir: w.ws }) });
  await apply([{ type: 'credentials' }], ctx());
  fs.writeFileSync(path.join(c, 'blog', `${NAME}.env`), `OTHER=${VALUE}-3\n`);
  fs.writeFileSync(path.join(w.server, 'alex', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
  await apply([{ type: 'credentials' }], ctx());
  assert.ok(notes.length, 'the public repository was told');
  said.push(JSON.stringify({ records, notes }));

  // The dashboard's workspace answers (the feature's own routes, the way the server calls them).
  const f = workspaceFeature({ config: () => ({}) }, { dir: w.ws, projectsDir: () => w.projects });
  for (const [method, re, fn] of f.routes) {
    if (method !== 'GET') continue;
    const url = re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
    if (/[()[\]?*+]/.test(url)) continue; // routes with a parameter
    try {
      said.push(`GET ${url}\n${JSON.stringify(await fn({ headers: {}, url, query: {} }, {}))}`);
    } catch (e) {
      said.push(`GET ${url} → ${e.message}`);
    }
  }

  const where = [];
  const look = (label, text) => {
    for (const m of [VALUE, NAME]) if (text.includes(m)) where.push(`${m} in ${label}`);
  };
  look('the outputs and answers', said.join('\n'));
  look('the map', fs.readFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), 'utf8'));
  look('Hoprig\'s state folder', allText(w.env.HOPRIG_STATE_DIR));
  look('Hoprig\'s config folder', allText(w.env.HOPRIG_CONFIG_DIR));
  // Every repository but the credentials one: its whole history, its index and its working files that git sees.
  // Found by Node, not by `find` (on Windows that name is the system's own find.exe): a folder named *.git under the
  // home and the server is a bare repository, a folder of the home that holds a .git is a working copy.
  const repos = [];
  const work = [];
  const walk = (d, inHome) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === '.git') { if (inHome) work.push(d); continue; }
      if (!e.isDirectory()) continue;
      if (e.name.endsWith('.git')) { repos.push(p); continue; }
      walk(p, inHome);
    }
  };
  walk(w.home, true);
  walk(w.server, false);
  for (const d of [...repos, ...work]) {
    if (d === c || d.endsWith(`${path.sep}credentials.git`)) continue;
    const gd = d.endsWith('.git') ? ['--git-dir', d] : ['-C', d];
    look(`the history of ${path.relative(w.root, d)}`, execFileSync('git', [...gd, 'log', '--all', '-p', '--format=%s%n%b'], { encoding: 'utf8', maxBuffer: 64 << 20 }));
    if (!d.endsWith('.git')) look(`the index of ${path.relative(w.root, d)}`, execFileSync('git', ['-C', d, 'ls-files', '-s'], { encoding: 'utf8' }) + execFileSync('git', ['-C', d, 'diff', '--cached'], { encoding: 'utf8' }));
  }
  assert.deepEqual(where, [], where.join('\n'));
  // And the credentials repository on the server has them: the search above is not blind.
  const inCreds = execFileSync('git', ['--git-dir', path.join(w.server, 'alex', 'credentials.git'), 'log', '--all', '-p'], { encoding: 'utf8' });
  assert.match(inCreds, new RegExp(VALUE));
  assert.match(inCreds, new RegExp(NAME));
});
