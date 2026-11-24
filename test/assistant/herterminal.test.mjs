// A terminal session Tia starts is hers, through the real start route (POST /api/sessions), the REAL launcher and a
// stand-in Claude Code that asks the hook it was handed (fixtures/probe-claude.mjs). Started through her door (her
// start_session tool, or another computer's dashboard relaying hers): an administrator command and a push to the main
// branch are held as the owner's card below Full, and the session signs in to git with the token the owner chose,
// not his own. Started by him (his page, a plain token): neither. The mark follows a move to another provider and
// goes when the session ends; a chosen file that cannot be read takes his git tokens out.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';
import { fakeBin, fakeClaude } from '../setup/helpers.mjs';
import { projectWork } from './fake-dashboard.mjs';

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'probe-claude.mjs');
const POSIX = { skip: process.platform === 'win32' && 'the stand-in and the hook gate are POSIX' };
const HER_TOKEN = 'ghp_herMadeUpToken_terminal_0001';
const HIS_TOKEN = 'ghp_hisMadeUpToken_terminal_0002';

const until = async (what, fn, ms = 30_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
};

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
        resolve({ status: res.statusCode, json, text: t });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('a terminal session she starts is hers: held below Full and signed in with her token; his own starts are not', { timeout: 240_000, ...POSIX }, async (t) => {
  const box = sandbox('herterm');
  // A claude stand-in first on PATH for the dashboard's own version and sign-in checks; the session runs PROBE.
  process.env.PATH = `${fakeBin(path.join(box.root, 'cbin'), { claude: fakeClaude({ loggedIn: false }) })}${path.delimiter}${process.env.PATH}`;
  process.env.GH_TOKEN = HIS_TOKEN; // his own sign-in, in the environment every session of his inherits
  process.env.GITHUB_TOKEN = HIS_TOKEN;
  const work = projectWork('hoprig-herterm-');
  const claudeBin = path.join(box.root, 'probe-claude.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${PROBE}' "$@"\n`, { mode: 0o755 });
  const creds = path.join(box.workspace, 'credentials');
  fs.mkdirSync(creds, { recursive: true });
  fs.writeFileSync(path.join(creds, 'tia-token'), `${HER_TOKEN}\n`, { mode: 0o600 });

  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir, hookSettingsDir } = await import('../../src/paths.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { SELF_HEADER } = await import('../../src/machines/relay.mjs');
  saveConfig({
    claudeBin,
    usage: false,
    server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests'), herGitSignin: { file: 'tia-token', at: 1 } },
    assistant: { enabled: true, level: 'handsoff', accounts: ['work', 'backup'], dailyCapUsd: 5 },
    sessionDefaults: { permissionMode: 'default' },
  });
  writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real-2' } });

  const app = createServer({ watch: false, dashboardFile: false });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
  t.after(async () => {
    await app.close().catch(() => {});
    box.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  const cookie = (await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, resolve);
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  })).headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': 'conv-herterm' } })).json;
  const { token } = createToken('hub');
  const bearer = (p, body, extra = {}) => request(base, 'POST', p, { body, headers: { Authorization: `Bearer ${token}`, ...extra } });

  const folder = (name) => {
    const d = path.join(work, name);
    fs.mkdirSync(d, { recursive: true });
    return fs.realpathSync(d);
  };
  // Every probe the stand-in wrote for a session in `dir`, oldest first.
  const probes = (dir) => fs.readdirSync(stateDir()).filter((f) => /^probe-.*\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(stateDir(), f), 'utf8'))).filter((p) => p.cwd === dir)
    .sort((a, b) => fs.statSync(path.join(stateDir(), `probe-${path.basename(a.runFile, '.json')}.json`)).mtimeMs - fs.statSync(path.join(stateDir(), `probe-${path.basename(b.runFile, '.json')}.json`)).mtimeMs);
  const probeOf = async (dir, n = 1) => {
    try {
      return await until(`probe ${n} in ${path.basename(dir)}`, async () => (probes(dir).length >= n ? probes(dir)[n - 1] : null));
    } catch (e) {
      // What the terminal showed, so a start that failed says why.
      const all = (await owner('GET', '/api/state')).json.sessions;
      const s = all.find((x) => x.cwd === dir) || all[0];
      if (!s) throw new Error(`${e.message}\n--- no session at all; probes: ${JSON.stringify(probes(dir))}; state files: ${fs.readdirSync(stateDir()).join(' ')}`);
      const screen = s ? (await owner('GET', `/api/sessions/${encodeURIComponent(s.name)}/history?lines=60`)).json?.text : '(no session)';
      throw new Error(`${e.message}\n--- screen ---\n${screen}`);
    }
  };
  const marks = () => (fs.existsSync(hookSettingsDir()) ? fs.readdirSync(hookSettingsDir()).filter((f) => f.endsWith('.tia')) : []);
  const isHers = (p) => fs.existsSync(path.join(hookSettingsDir(), `${path.basename(p.runFile)}.tia`));
  const heldAsHers = (p, what) => {
    assert.equal(p.answers['sudo true'].decision, 'ask', `${what}: an administrator command is held as his card`);
    assert.equal(p.answers['git push origin main'].decision, 'ask', `${what}: a push to the main branch is held as his card`);
    assert.equal(p.answers.ls.decision, null, `${what}: an ordinary command goes on`);
  };
  const notHeld = (p, what) => {
    for (const c of ['sudo true', 'git push origin main', 'ls']) assert.equal(p.answers[c].decision, null, `${what}: ${c} is not held (no Hands-off switch is on)`);
  };

  // ---- through HER door: her own tool, start_session ----
  const a = folder('alpha');
  const r1 = await call('start_session', { folder: a, account: 'work' });
  assert.equal(r1.isError, false, r1.text);
  const p1 = await probeOf(a);
  heldAsHers(p1, 'her start');
  assert.equal(p1.ghToken, HER_TOKEN, 'her session signs in to git with the chosen token');
  assert.equal(p1.githubToken, HER_TOKEN);
  assert.ok(isHers(p1), 'the dashboard marked her run where the hook reads it');

  // ---- through another computer's dashboard relaying hers (its token AND the mark its relay sets) ----
  const b = folder('beta');
  const r2 = await bearer('/api/sessions', { dir: b, profile: 'work', mode: 'new' }, { [SELF_HEADER]: '1' });
  assert.equal(r2.status, 200, r2.text);
  const p2 = await probeOf(b);
  heldAsHers(p2, 'her relayed start');
  assert.equal(p2.ghToken, HER_TOKEN);

  // ---- started by HIM: his page, and a plain token (another computer's page) ----
  const c = folder('gamma');
  const r3 = await owner('POST', '/api/sessions', { dir: c, profile: 'work', mode: 'new' });
  assert.equal(r3.status, 200, r3.text);
  const p3 = await probeOf(c);
  notHeld(p3, 'his own start');
  assert.equal(p3.ghToken, HIS_TOKEN, 'his own session keeps his sign-in');
  assert.ok(!isHers(p3), 'his own session is not marked');
  const d = folder('delta');
  // A body that says it is hers changes nothing: only the door decides.
  const r4 = await bearer('/api/sessions', { dir: d, profile: 'work', mode: 'new', byTia: true, hers: true });
  assert.equal(r4.status, 200, r4.text);
  const p4 = await probeOf(d);
  notHeld(p4, 'a plain token\'s start');
  assert.equal(p4.ghToken, HIS_TOKEN);

  // ---- the mark follows a move to another provider (switch): the new run is hers, with her sign-in ----
  await until('her session to report its conversation', async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.cwd === a && s.sessionId));
  const card = (await owner('GET', '/api/state')).json.sessions.find((s) => s.cwd === a);
  const moved = await owner('POST', `/api/sessions/${encodeURIComponent(card.name)}/switch`, { profile: 'backup' });
  assert.equal(moved.status, 200, moved.text);
  const p1b = await probeOf(a, 2);
  assert.notEqual(p1b.runFile, p1.runFile, 'the move started a new run');
  heldAsHers(p1b, 'her session after a move');
  assert.equal(p1b.ghToken, HER_TOKEN);
  // His session moved stays his.
  const hisCard = await until('his session to report its conversation', async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.cwd === c && s.sessionId));
  assert.equal((await owner('POST', `/api/sessions/${encodeURIComponent(hisCard.name)}/switch`, { profile: 'backup' })).status, 200);
  const p3b = await probeOf(c, 2);
  notHeld(p3b, 'his session after a move');
  assert.equal(p3b.ghToken, HIS_TOKEN);

  // ---- a chosen file that cannot be read: his git tokens are taken out, the session is still hers ----
  saveConfig({ server: { herGitSignin: { file: 'gone-token', at: 2 } } });
  const e = folder('epsilon');
  const r5 = await call('start_session', { folder: e, account: 'work' });
  assert.equal(r5.isError, false, r5.text);
  const p5 = await probeOf(e);
  heldAsHers(p5, 'her start with an unreadable token file');
  // No git sign-in at all, never his: gh's token variables hold the placeholder, so gh fails and never asks the keyring.
  assert.equal(p5.ghToken, 'none', 'no git sign-in at all, never his');
  assert.equal(p5.githubToken, 'none');

  // ---- the mark goes when the session ends ----
  const all = (await owner('GET', '/api/state')).json.sessions.filter((s) => [a, b, c, d, e].includes(s.cwd));
  for (const s of all) assert.equal((await owner('POST', `/api/sessions/${encodeURIComponent(s.name)}/kill`, {})).status, 200);
  await until('every mark gone with its session', async () => marks().length === 0);
});
