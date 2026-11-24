// `hoprig setup --dry-run` writes nothing: a whole-home snapshot (the home, the settings, the state folder, the
// workspace, every file and link with its mode) before and after a full dry run, with the computer, Git and workspace
// steps, on a simulated server (ssh, no desktop session, a cloud's hardware, a locale the computer lacks, the settings
// still open to the network from an earlier version) and on a desktop (a local graphical session, a reason an earlier
// set-up over ssh saved). Every program is a stand-in that writes down how it was called, in a folder outside the
// snapshot: a dry run starts none that changes anything.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, recorder } from './helpers.mjs';
import { sealedPath } from '../seal.mjs';

const posix = process.platform !== 'win32';
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-dryhome-log-'));
test.after(() => fs.rmSync(outside, { recursive: true, force: true }));
globalThis.fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.300' });
const log = path.join(outside, 'calls.txt');
const rec = (n) => `printf '%s :: %s\\n' ${n} "$*" >> '${log}'`;
const bin = fakeBin(path.join(outside, 'bin'), {
  claude: fakeClaude({ loggedIn: false }),
  sudo: `${rec('sudo')}\nexit 1`,
  'apt-get': rec('apt-get'),
  loginctl: `${rec('loginctl')}\ncase "$1" in show-user) echo Linger=no ;; *) exit 1 ;; esac`,
  systemctl: `${rec('systemctl')}\nexit 0`,
  git: `${rec('git')}\ncase "$1" in --version) echo "git version 2.43.0" ;; config) exit 1 ;; *) exit 0 ;; esac`,
  gh: `${rec('gh')}\ncase "$1" in --version) echo "gh version 2.40.0" ;; auth) echo "You are not logged into any GitHub hosts." >&2; exit 1 ;; *) exit 1 ;; esac`,
  npm: `${rec('npm')}\ncase "$1" in --version) echo 10.9.0 ;; esac`,
  tmux: 'echo "tmux 3.4"', rg: 'echo "ripgrep 14.1.0"', jq: 'echo "jq-1.7.1"', curl: 'echo "curl 8.5.0"', unzip: 'echo "UnZip 6.00"',
  make: 'echo "GNU Make 4.3"', cc: 'echo "cc 13.2.0"', 'c++': 'echo "c++ 13.2.0"',
  python3: 'case "$*" in *pip*) echo "pip 24.0" ;; *venv*) echo "venv ok" ;; *) echo "Python 3.12.3" ;; esac',
});

/** Every file and link under `root` → its mode and hash (a link: where it points); every folder by its mode. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) {
        out[`${rel}/`] = (fs.statSync(p).mode & 0o777).toString(8);
        walk(p);
      } else out[rel] = `${(fs.statSync(p).mode & 0o777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

const KEYS = ['HOME', 'HOPRIG_CONFIG_DIR', 'HOPRIG_STATE_DIR', 'CLAUDE_CONFIG_DIR', 'HOPRIG_WORKSPACE_DIR', 'HOPRIG_PROFILES_DIR', 'PATH', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL', 'LC_CTYPE'];

/** A home as an earlier version left it, every Hoprig folder inside it; process.env points there until `restore`. */
async function home(kind) {
  const was = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hoprig-dryhome-${kind}-`)));
  const env = {
    HOME: path.join(root, 'home'),
    HOPRIG_CONFIG_DIR: path.join(root, 'config'),
    HOPRIG_STATE_DIR: path.join(root, 'state'),
    CLAUDE_CONFIG_DIR: path.join(root, 'home', '.claude'),
    HOPRIG_WORKSPACE_DIR: path.join(root, 'home', 'Workspace'),
  };
  for (const d of Object.values(env)) fs.mkdirSync(d, { recursive: true });
  Object.assign(process.env, env);
  delete process.env.HOPRIG_PROFILES_DIR;
  process.env.PATH = sealedPath(pathWith(outside, bin));
  for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'LC_CTYPE', 'LC_ALL']) delete process.env[k];
  if (kind === 'server') Object.assign(process.env, { SSH_CONNECTION: '10.0.0.5 50000 10.0.0.9 22', SSH_CLIENT: '10.0.0.5 50000 22', SSH_TTY: '/dev/pts/0', LC_ALL: 'xx_YY.UTF-8', LANG: 'xx_YY.UTF-8' });
  else Object.assign(process.env, { DISPLAY: ':0', LANG: 'C.UTF-8' });
  // What an earlier version left: settings (on the server still open to the network), a saved server reason, the
  // person's shell files, a project in the workspace.
  fs.writeFileSync(path.join(env.HOPRIG_CONFIG_DIR, 'config.json'), `${JSON.stringify({ usage: false, server: kind === 'server' ? { host: '0.0.0.0' } : {} })}\n`);
  fs.writeFileSync(path.join(env.HOPRIG_STATE_DIR, 'server.json'), '{"kind":"ssh"}\n');
  for (const f of ['.bashrc', '.profile']) fs.writeFileSync(path.join(env.HOME, f), '# the person\'s own\n');
  fs.mkdirSync(path.join(env.HOPRIG_WORKSPACE_DIR, 'projects', 'shop'), { recursive: true });
  fs.writeFileSync(path.join(env.HOPRIG_WORKSPACE_DIR, 'projects', 'shop', 'README.md'), '# shop\n');
  return {
    root,
    restore: () => {
      for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const kind of ['server', 'desktop']) {
  test(`setup --dry-run on a ${kind}: the whole home is the same after it, and no program that changes anything ran`, { timeout: 120_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
    const h = await home(kind);
    t.after(h.restore);
    const K = await import('../../src/setup/checks.mjs');
    const SU = await import('../../src/setup/setup.mjs');
    const { makeUi } = await import('../../src/setup/ui.mjs');
    const r = recorder();
    const ui = makeUi({ interactive: false, dryRun: true, write: r.write, askLine: async () => '' });
    const sys = K.sysInfo({
      env: { ...process.env }, platform: 'linux', pm: 'apt', root: false, user: 'alex', serviceSupported: true, publicIps: [],
      dmi: kind === 'server' ? { vendor: 'Google', product: 'Google Compute Engine' } : {}, localDisplay: kind === 'desktop', savedServer: undefined,
      locales: new Set(['c', 'c.utf8', 'posix']), release: { ID: 'ubuntu', ID_LIKE: 'debian' },
    });
    sys.probe = async () => 0; // no dashboard runs
    sys.running = async () => null;
    fs.rmSync(log, { force: true });
    const before = snapshot(h.root);
    const code = await SU.setup(['--dry-run'], { ui, sys });
    const after = snapshot(h.root);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    t.diagnostic(`${kind}: ${Object.keys(before).length} entries before, ${Object.keys(after).length} after; programs: ${JSON.stringify(calls)}`);

    assert.equal(code, 0, r.text);
    assert.match(r.text, /Dry run: nothing was changed/);
    assert.ok(Object.keys(before).length >= 10, 'the snapshot sees the home');
    assert.deepEqual(changes(before, after), [], `nothing in the whole home changed:\n${r.text}`);
    const CHANGES = /^(sudo|apt-get) |^systemctl :: --user (daemon-reload|enable|restart|start)|^loginctl :: enable-linger|^npm :: (install|i|link|uninstall|rebuild)\b|^git :: (init|clone|commit|push|remote add)\b|^git :: config --global (?!--get)\S+ \S|^git :: config --global --(add|unset|replace-all)\b|^gh :: auth login/;
    assert.deepEqual(calls.filter((c) => CHANGES.test(c)), [], calls.join('\n'));
    if (kind === 'server') {
      assert.match(r.text, /Would close it to this computer only|Close it to this computer only/);
      assert.doesNotMatch(r.text, /Closed it to this computer only/);
    }
    assert.equal(fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'server.json'), 'utf8'), '{"kind":"ssh"}\n');
  });
}
