// The Git and GitHub step with a stand-in for gh (the real sign-in needs a person and a browser): signing in runs
// `gh auth login` in the terminal, then `gh auth setup-git`; the commit name and GitHub's no-reply address are
// offered, never made up; a brain on GitHub is offered for restore; "start new" makes a PRIVATE repository, puts
// the map in it and pushes. git itself is real, against local bare repositories. Only the account name is shown.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-gitstep');
test.after(() => w.cleanup());
// github.com addresses go to the local "server" too (owner folders under it).
fs.appendFileSync(process.env.GIT_CONFIG_GLOBAL, `[url "${w.server}/"]\n\tinsteadOf = https://github.com/\n`);
const { capture } = await import('../../src/setup/system.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { gitState, runGitStep } = await import('../../src/workspace/gitstep.mjs');

const TOKEN_LINE = '  - Token: gho_************************************';
/** The stand-in gh: what it was asked, and a GitHub with one account, one organisation and one brain. */
function fakeGh() {
  const st = { signedIn: false, calls: [], created: null };
  const ok = (stdout = '', stderr = '') => ({ ok: true, code: 0, stdout, stderr });
  const no = (stderr = '') => ({ ok: false, code: 1, stdout: '', stderr });
  const run = async (argv, o) => {
    if (argv[0] !== 'gh') return capture(argv, o);
    st.calls.push(argv.slice(1).join(' '));
    const a = argv.slice(1).join(' ');
    if (a.startsWith('auth status')) return st.signedIn ? ok('', `github.com\n  ✓ Logged in to github.com account alex (keyring)\n${TOKEN_LINE}\n`) : no('You are not logged into any GitHub hosts.');
    if (!st.signedIn) return no('not signed in');
    if (a.startsWith('auth setup-git')) return capture(['git', 'config', '--global', 'credential.https://github.com.helper', '!gh auth git-credential']);
    if (a === 'api user --jq [.id, .login, (.name // "")] | @tsv') return ok('12345\talex\tAlex Example\n');
    if (a === 'api user --jq .login') return ok('alex\n');
    if (a === 'api user/orgs --jq .[].login') return ok('example-org\n');
    if (a.startsWith('repo list alex')) return ok(JSON.stringify([{ name: 'shop', url: 'https://github.com/alex/shop', isPrivate: true }, ...(st.created ? [{ name: st.created, url: '', isPrivate: true }] : [])]));
    if (a.startsWith('repo list example-org')) return ok('[]');
    if (a.startsWith(`api repos/alex/${st.created}/contents/workspace.json`)) return ok('workspace.json\n');
    return no(`unexpected: gh ${a}`);
  };
  // What runs in the terminal: the sign-in, and creating a repository (a bare one on the local server, pushed).
  const term = async (argv, o = {}) => {
    st.calls.push(`[terminal${o.interactive ? ', interactive' : ''}] ${argv.join(' ')}`);
    if (argv.slice(1, 3).join(' ') === 'auth login') {
      st.signedIn = true;
      return { ok: true, code: 0, output: '' };
    }
    if (argv.slice(1, 3).join(' ') === 'repo create') {
      const [owner, name] = argv[3].split('/');
      assert.ok(argv.includes('--private') && !argv.includes('--public'), 'always private');
      const dir = argv[argv.indexOf('--source') + 1];
      fs.mkdirSync(path.join(w.server, owner), { recursive: true });
      w.sh(w.server, 'init', '-q', '--bare', '-b', 'main', path.join(w.server, owner, `${name}.git`));
      w.sh(dir, 'remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`);
      w.sh(dir, 'push', '-q', '-u', 'origin', 'HEAD');
      st.created = name;
      return { ok: true, code: 0, output: '' };
    }
    return { ok: false, code: 1, output: 'unexpected' };
  };
  return { st, run, term };
}

const ui = (answers, o = {}) => {
  let text = '';
  const q = [...answers];
  const u = makeUi({ interactive: true, write: (s) => (text += s), askLine: async (question) => { if (!q.length) throw new Error(`unexpected question: ${question}`); return q.shift(); }, ...o });
  return { ui: u, text: () => text, left: () => q };
};
const has = (c) => c === 'git' || c === 'gh';

test('no terminal: nothing is signed in or set, the step says how to do it later', async () => {
  const A = w.computer('quiet');
  A.use();
  const gh = fakeGh();
  const { ui: u, text } = ui([], { interactive: false });
  const r = await runGitStep({ ui: u, run: gh.run, term: gh.term, has, dir: A.ws });
  assert.equal(r.ok, true);
  assert.ok(!gh.st.calls.some((c) => c.includes('auth login')));
  assert.match(text(), /not signed in\. Later: hoprig workspace git/);
});

test('in a terminal: sign in, gh auth setup-git, the no-reply address offered; only the account name is shown; then "later"', async () => {
  const A = w.computer('alex');
  A.use();
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8').replace(/\[user\][^[]*/, ''));
  const gh = fakeGh();
  // confirm the sign-in, Enter for the name, Enter for the e-mail, "later" for the workspace.
  const { ui: u, text, left } = ui(['y', '', '', 'l']);
  const r = await runGitStep({ ui: u, run: gh.run, term: gh.term, has, dir: A.ws });
  assert.equal(r.ok, true);
  assert.deepEqual(left(), []);
  assert.ok(gh.st.calls.includes('[terminal, interactive] gh auth login --hostname github.com --git-protocol https --web'));
  assert.ok(gh.st.calls.includes('auth setup-git --hostname github.com'));
  assert.equal(w.sh(w.root, 'config', '--global', 'user.name'), 'Alex Example');
  assert.equal(w.sh(w.root, 'config', '--global', 'user.email'), '12345+alex@users.noreply.github.com');
  assert.match(text(), /signed in to GitHub/);
  assert.match(text(), /No AI brain of yours on GitHub yet/);
  assert.ok(!text().includes('gho_') && !JSON.stringify(r.state).includes('gho_'), 'no token is ever shown');
  assert.equal(r.state.gh.account, 'alex');
  assert.equal(r.state.helper, true);
});

test('start new: the brain made, a PRIVATE repository created, the map committed and pushed', async () => {
  const A = w.computer('alex');
  A.use();
  const gh = fakeGh();
  gh.st.signedIn = true;
  // "n" (start new), the first account, Enter for the name (ai_brain), yes to create.
  const { ui: u, text, left } = ui(['n', '1', '', 'y']);
  const r = await runGitStep({ ui: u, run: gh.run, term: gh.term, has, dir: A.ws });
  assert.equal(r.ok, true, text());
  assert.deepEqual(left(), []);
  assert.ok(gh.st.calls.some((c) => c.includes('gh repo create alex/ai_brain --private --source')));
  const bare = path.join(w.server, 'alex', 'ai_brain.git');
  const map = JSON.parse(w.sh(bare, 'show', 'main:workspace.json'));
  assert.equal(map.brain.url, 'https://github.com/alex/ai_brain.git');
  assert.equal(r.state.brain.remote, 'https://github.com/alex/ai_brain.git');
  assert.match(text(), /hoprig workspace restore alex\/ai_brain/);
  // Run again: the brain is on GitHub, nothing is asked.
  const again = ui([]);
  await runGitStep({ ui: again.ui, run: gh.run, term: gh.term, has, dir: A.ws });
  assert.match(again.text(), /your AI brain is on https:\/\/github\.com\/alex\/ai_brain\.git/);
});

test('a fresh computer: the brain on GitHub is offered and restored', async () => {
  const B = w.computer('box2');
  B.use();
  const gh = fakeGh();
  gh.st.signedIn = true;
  gh.st.created = 'ai_brain';
  const { ui: u, text } = ui(['1']);
  const r = await runGitStep({ ui: u, run: gh.run, term: gh.term, has, dir: B.ws });
  assert.match(text(), /1 {2}restore alex\/ai_brain/);
  assert.equal(r.ok, true, text());
  assert.ok(fs.existsSync(path.join(B.ws, 'ai_brain', 'workspace.json')));
  assert.equal((await gitState({ run: gh.run, has, dir: B.ws })).brain.remote, 'https://github.com/alex/ai_brain.git');
});
