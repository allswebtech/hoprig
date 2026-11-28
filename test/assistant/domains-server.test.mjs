// Tia's page tools on the real dashboard: every call runs the page's own route in-process (ctx.dispatch), so the
// same validators answer her and the page. Setup steps and git are stand-ins (no package manager, no network);
// sessions are the fake launcher's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeTools } from '../setup/helpers.mjs';
import { sandbox } from '../server/helpers.mjs';

const FAKE_SESSION = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-session.mjs');

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch((e) => e);
    if (last && !(last instanceof Error)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('Tia\'s page tools go through the page\'s own routes', { timeout: 120_000, skip: process.platform === 'win32' && 'the fake launcher is POSIX' }, async (t) => {
  const box = sandbox('tia-dom');
  // Stand-ins (gh, docker, tailscale) first on PATH: the Setup check and git steps run them, so the owner's real
  // GitHub, container daemon and private network are never reached (this test's steps are stand-ins, not the real ones).
  process.env.PATH = `${fakeTools(path.join(box.root, 'tools'))}${path.delimiter}${process.env.PATH}`;
  const work = path.join(box.root, 'work');
  const projects = path.join(work, 'projects');
  fs.mkdirSync(path.join(projects, 'shop', '.git'), { recursive: true });
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  const setupRuns = [];
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'work' }, operator: { acts: true } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watch: false, dashboardFile: false,
    claudecode: { claudeInfo: async () => ({ installed: '2.1.325', latest: '2.1.330', updateAvailable: true }) },
    pcsetup: {
      projectsDir: () => projects,
      sudoNeedsPassword: async () => false,
      runPcSetup: async (o) => {
        setupRuns.push(o.kits);
        return { ok: true, missing: [], changed: true };
      },
      status: async () => [{ group: 'kit:tools', id: 'kit:tools.gh', label: 'GitHub CLI', status: 'missing', detail: 'missing', fix: '', fixKit: 'tools' }],
      projectNew: async ([name]) => {
        fs.mkdirSync(path.join(projects, name, '.git'), { recursive: true });
        return 0;
      },
      syncWorkspace: async () => ({ memory: null, repos: [{ rel: 'code/web', did: ['pulled 2'], todo: [{ why: 'local changes are not committed', command: 'git status' }] }] }),
    },
    workspace: { dir: path.join(box.root, 'ws'), projectsDir: () => projects },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': 'dom' } })).json;
  const login = await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } });
  assert.equal(login.status, 200);
  const cookie = (await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => resolve(res.headers['set-cookie'][0].split(';')[0]));
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  }));
  const confirm = async (text) => {
    const id = /card (c_[0-9a-f]{12})/.exec(text)[1];
    return request(base, 'POST', `/api/assistant/cards/${id}/confirm`, { body: {}, headers: { Cookie: cookie } });
  };

  // The in-process request: a refused value comes back as the route's own message; another computer is the relay.
  const ops = app.features.find((f) => f.name === 'assistant').ops;
  await assert.rejects(ops.startSession({ computer: 'this', folder: '/not/allowed', profile: 'sub', mode: 'new' }), /choose a folder inside the allowed roots/);
  await assert.rejects(ops.accounts({ computer: 'nope' }), (e) => e.status >= 400);

  // Computers → setup: the check, then a fix that runs the setup part as a job (no terminal).
  let r = await call('get_computer_status', { computer: 'this', setup: true });
  assert.match(r.text, /Setup check of this: 1 check\(s\) not ok/);
  r = await call('manage_computer', { action: 'setup_fix', check: 'kit:tools.gh' });
  assert.match(r.text, /Waiting for the owner's OK/);
  const fixed = await confirm(r.text);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  const fixJob = await until('the fix job', async () => {
    const j = (await request(base, 'GET', '/api/pcsetup/job?from=0', { headers: { Cookie: cookie } })).json;
    return j.kind === 'fix' && !j.running ? j : null;
  });
  assert.equal(fixJob.result.ok, true);
  assert.deepEqual(setupRuns, [['tools']]);
  assert.equal((await ops.listSessions({ computer: 'this' })).some((s) => s.name.startsWith('fix-')), false, 'no terminal session');

  // Workspace → a new project (card, then the background job), and a sync whose decisions come back undone.
  r = await call('manage_project', { action: 'new', name: 'blog' });
  assert.match(r.text, /Create the project blog in .*blog on this/);
  const made = await confirm(r.text);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.ok(fs.existsSync(path.join(projects, 'blog', '.git')));
  r = await call('list_projects', {});
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /"project":"shop"/);
  // a sync cannot be taken back: a card, and on his tap it runs
  r = await call('manage_project', { action: 'sync', project: 'shop' });
  assert.match(r.text, /Waiting for the owner's OK.*cannot be put back/s);
  assert.equal((await confirm(r.text)).status, 200);

  // Automations: a schedule through its card, then the list says it the page's way.
  r = await call('manage_automation', { action: 'add_schedule', time: '08:15', folder: path.join(projects, 'shop'), account: 'sub', in: 'chat', text: 'run the tests' });
  assert.match(r.text, /every day at 08:15, start a chat in .*shop on sub/);
  assert.equal((await confirm(r.text)).status, 200);
  assert.deepEqual(loadConfig().automation.schedules.list.at(-1).action, { type: 'start', dir: path.join(projects, 'shop'), profile: 'sub', in: 'chat', prompt: 'run the tests' }, 'saved as a chat schedule');
  r = await call('manage_automation', { action: 'list' });
  assert.match(r.text, /1 schedule\(s\)/);
  assert.equal((await call('manage_automation', { action: 'pause' })).isError, false);
  assert.equal(loadConfig().automation.paused, true);

  // The AI brain: its index through the workspace route.
  r = await call('read_brain', {});
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /The brain index of this/);

  // The workspace map: read through its route; writing it (one file, never committed) is L1.
  r = await call('list_projects', { view: 'map' });
  assert.equal(r.isError, false, r.text);
  r = await call('manage_project', { action: 'workspace_map', dry_run: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /would change/);

  // Skills: what is installed, through the skills route.
  assert.equal((await call('manage_skills', { action: 'installed' })).isError, false);
});
