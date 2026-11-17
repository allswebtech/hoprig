// Tia in the real dashboard (createServer): her token's scope, the owner-only routes, on/off, the ops mapping on a
// real backend with a fake launcher (no Claude Code), the chat stream with a fake engine that drives the REAL
// `hoprig mcp`, confirm cards (one confirmed, one expired), and a job from start to "done" through the watcher.
// Runs on the built-in pty backend, and on tmux as well where tmux is installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SESSION = path.join(HERE, 'fixtures', 'fake-session.mjs');
const FAKE_TIA = path.join(HERE, 'fixtures', 'fake-tia.mjs');

const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last).slice(0, 300))})`);
};

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(u, { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, headers: res.headers, text: t });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const kinds = ['pty', ...(tmuxUsable() ? ['tmux'] : [])];

for (const kind of kinds) {
  test(`Tia in the dashboard (${kind})`, { timeout: 180_000, skip: process.platform === 'win32' && 'the fake launcher is POSIX' }, async (t) => {
    const box = sandbox('tia');
    const work = path.join(box.root, 'work');
    const proj = path.join(work, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const { saveConfig, loadConfig } = await import('../../src/config.mjs');
    const { writeProfile } = await import('../../src/profiles.mjs');
    const { hashPassword, COOKIE } = await import('../../src/server/auth.mjs');
    const { createServer } = await import('../../src/server/server.mjs');
    const { createToken } = await import('../../src/machines/tokens.mjs');
    const { stateDir } = await import('../../src/paths.mjs');
    saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: kind, roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'work' } });
    writeProfile('sub', { label: 'Main' });
    writeProfile('sub2', { label: 'Second' });
    writeProfile('api', { label: 'API', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
    writeProfile('cx', { label: 'Codex sign-in', signin: 'codex' }); // from an earlier version: nothing uses it
    writeProfile('oc', { label: 'OpenCode key', env: { OPENAI_API_KEY: 'sk-tia-feature-0123' } }); // OpenCode's

    let offset = 0; // the cards' clock: moved forward to expire a card
    const emptyConf = path.join(box.root, 'empty.conf');
    fs.writeFileSync(emptyConf, '');
    const socket = `tia-t-${process.pid}`;
    // A stand-in for src/claudecode.mjs, given to the server and to Tia's tools (each takes its own): what she
    // reports must not depend on a Claude Code installed on this computer, nor on a version lookup on the network.
    const claudecode = { claudeInfo: async () => ({ installed: '2.1.325', latest: '2.1.330', updateAvailable: true }) };
    const app = createServer({
      tmuxSocket: socket, tmuxConfigFile: emptyConf, watchTickMs: 300, dashboardFile: true,
      claudecode,
      assistant: {
        claudecode: async () => claudecode,
        now: () => Date.now() + offset,
        engine: { command: { command: process.execPath, args: [FAKE_TIA] }, resolveEnv: async () => ({ ...process.env }) },
      },
    });
    const { port } = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    t.after(async () => {
      await app.close();
      // tmux sessions outlive the dashboard on purpose; the test's own tmux server must not.
      if (kind === 'tmux') {
        spawnSync('tmux', ['-L', socket, 'kill-server']);
        // tmux leaves the socket file behind: one more in the shared tmux folder at every run.
        fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket), { force: true });
      }
      box.cleanup();
    });

    // the owner's login
    const login = await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.ok(cookie.startsWith(`${COOKIE}=`));
    const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });

    // ---- her token: written 600, reaches exactly one route ----
    const tokenPath = path.join(stateDir(), 'assistant-token');
    assert.equal((fs.statSync(tokenPath).mode & 0o777).toString(8), '600');
    const tia = fs.readFileSync(tokenPath, 'utf8').trim();
    assert.match(tia, /^tia_/);
    const asTia = (method, p, body, conv = 'conv-t') => request(base, method, p, { body, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': conv } });
    let r = await asTia('POST', '/api/assistant/call', { tool: 'list_sessions', args: {} });
    assert.equal(r.status, 200);
    assert.match(r.json.text, /^0 session\(s\)/);
    for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/assistant'], ['GET', '/api/assistant/cards'], ['POST', '/api/assistant/settings'], ['POST', '/api/sessions'], ['GET', '/api/settings'], ['POST', '/api/assistant/run'], ['GET', '/api/pc']]) {
      const x = await asTia(m, p, m === 'POST' ? {} : undefined);
      assert.equal(x.status, 403, `${m} ${p} must refuse Tia's token`);
    }
    // a machine token (another dashboard) never reaches her owner-only routes nor her call route
    const { token: machineToken } = createToken('hub-for-tests');
    const asMachine = (method, p, body) => request(base, method, p, { body, headers: { Authorization: `Bearer ${machineToken}` } });
    for (const p of ['/api/assistant', '/api/assistant/cards', '/api/assistant/settings', '/api/assistant/audit']) assert.equal((await asMachine('GET', p)).status, 403, p);
    assert.equal((await asMachine('POST', '/api/assistant/call', { tool: 'list_sessions', args: {} })).status, 403);
    assert.equal((await asMachine('POST', '/api/assistant/cards/c_000000000000/confirm', {})).status, 403);
    // …but the hub's run_command on this computer goes through
    r = await asMachine('POST', '/api/assistant/run', { command: 'echo hi-from-hub' });
    assert.equal(r.status, 200);
    assert.equal(r.json.output.trim(), 'hi-from-hub');
    // nobody: 401; a wrong tia_ token: 401 by the machines gate
    assert.equal((await request(base, 'POST', '/api/assistant/call', { body: { tool: 'list_sessions' } })).status, 401);
    assert.equal((await request(base, 'GET', '/api/assistant/cards')).status, 401);
    assert.equal((await request(base, 'POST', '/api/assistant/call', { body: { tool: 'list_sessions' }, headers: { Authorization: 'Bearer tia_wrong' } })).status, 401);

    // ---- ops on the real backend (fake launcher) ----
    const call = async (tool, args, conv = 'conv-t') => (await asTia('POST', '/api/assistant/call', { tool, args }, conv)).json;
    r = await call('start_session', { folder: proj, message: '-starts with a dash; make it work', account: 'sub' });
    assert.equal(r.isError, false, r.text);
    const name = /Started session (\S+)/.exec(r.text)[1];
    let screen = await until('the fake session', async () => {
      const x = await call('read_session', { session: name });
      return /FAKE-SESSION/.test(x.text) && x.text;
    });
    assert.match(screen, /args=\[[^\]]*"--","-starts with a dash; make it work"\]/, 'the first message arrives after "--", as one argument');
    await until('the task done', () => fs.existsSync(path.join(proj, 'TASK.txt')));
    assert.equal(fs.readFileSync(path.join(proj, 'TASK.txt'), 'utf8'), '-starts with a dash; make it work');
    r = await call('send_to_session', { session: name, text: 'hello there' });
    assert.equal(r.isError, false, r.text);
    await until('the echo', async () => /GOT: hello there/.test((await call('read_session', { session: name })).text));
    assert.equal((await call('send_to_session', { session: name, key: 'Escape' })).isError, false);
    assert.match((await call('get_accounts', {})).text, /5 provider\(s\) on this/);
    assert.match((await call('get_computer_status', { computer: 'this' })).text, /Claude Code 2\.1\.325/);
    assert.match((await call('list_projects', { folder: work })).text, /subfolder/);
    assert.equal((await call('list_projects', {})).isError, false);
    // her own session: she may move and stop it at "Do the work"
    r = await call('switch_account', { session: name, account: 'sub2' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /now continues on sub2/);
    await until('the move', async () => /profile=sub2/.test((await call('read_session', { session: name })).text));
    r = await call('stop_session', { session: name });
    assert.match(r.text, /^Stopped/);
    await until('the session gone', async () => !(await call('list_sessions', {})).text.includes(name));

    // ---- cards: one confirmed, one expired; run_command output comes back fenced ----
    r = await call('run_command', { command: 'echo card-ran > card.txt && echo ok', folder: work });
    const id1 = /card (c_[0-9a-f]{12})/.exec(r.text)[1];
    assert.equal(fs.existsSync(path.join(work, 'card.txt')), false, 'not run before the OK');
    assert.equal((await owner('GET', '/api/assistant/cards')).json.cards.length, 1);
    r = await owner('POST', `/api/assistant/cards/${id1}/confirm`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.card.status, 'done');
    assert.equal(fs.readFileSync(path.join(work, 'card.txt'), 'utf8').trim(), 'card-ran');
    assert.equal((await owner('POST', `/api/assistant/cards/${id1}/confirm`, {})).status, 409, 'single use');
    r = await call('set_auto_mode', { enabled: true });
    const id2 = /card (c_[0-9a-f]{12})/.exec(r.text)[1];
    offset = 10 * 60_000 + 1;
    r = await owner('POST', `/api/assistant/cards/${id2}/confirm`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /expired/);
    assert.equal(loadConfig().autoSwitch?.enabled ?? false, false);
    offset = 0;
    const audit = (await owner('GET', '/api/assistant/audit')).json.entries.map((e) => e.outcome);
    for (const o of ['staged', 'confirmed', 'done', 'expired']) assert.ok(audit.includes(o), o);

    // ---- chat + stream with the fake engine through the real `hoprig mcp`; a job from start to done ----
    r = await owner('POST', '/api/assistant/chat', { text: `make hello in ${proj}` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const conv = r.json.conversation;
    const streamed = [];
    const sse = http.get(`${base}/api/assistant/stream?conversation=${conv}`, { headers: { Cookie: cookie } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
      res.setEncoding('utf8');
      res.on('data', (d) => {
        for (const m of d.matchAll(/^data: (.+)$/gm)) streamed.push(JSON.parse(m[1]));
      });
    });
    t.after(() => sse.destroy());
    await until('the first turn', () => streamed.some((e) => e.kind === 'done'));
    assert.deepEqual(streamed.filter((e) => e.kind === 'tool_call').map((e) => e.tool), ['list_projects', 'start_session']);
    assert.ok(streamed.some((e) => e.kind === 'text' && /Started session proj/.test(e.text)), JSON.stringify(streamed));
    const jobs = (await owner('GET', '/api/assistant/jobs')).json.jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].sessions[0].startedByTia, true);
    // the watcher sees the session finish, wakes her, she checks and finishes the job
    let lastJob = null;
    const done = await until('the job done', async () => {
      const j = (lastJob = (await owner('GET', '/api/assistant/jobs')).json.jobs[0]);
      return j.state === 'done' && j;
    }, 45_000).catch(async (e) => {
      const st = (await owner('GET', '/api/state')).json.sessions.map((x) => [x.name, x.kind, x.status, x.lastMessage]);
      throw new Error(`${e.message}\njob: ${JSON.stringify(lastJob)}\nsessions: ${JSON.stringify(st)}\nstream: ${JSON.stringify(streamed.slice(-3))}`);
    });
    assert.match(done.log.map((l) => l.text).join('\n'), /waiting[\s\S]*done: proj finished the task/);
    assert.ok(streamed.some((e) => e.kind === 'wake' && e.reason === 'waiting'));
    assert.deepEqual(streamed.filter((e) => e.kind === 'tool_call').map((e) => e.tool).slice(2), ['read_session', 'finish_job']);
    const page = await owner('GET', `/api/assistant/chat/${conv}?from=0`);
    assert.equal(page.json.events.length >= streamed.length - 1, true);
    const settings = (await owner('GET', '/api/assistant/settings')).json;
    assert.ok(settings.usage.today.turns >= 2);
    assert.equal(settings.settings.level, 'work');

    // ---- a card staged by her shows up for the owner with every value ----
    await owner('POST', '/api/assistant/chat', { text: 'stage auto', conversation: conv });
    const card = await until('her card', async () => (await owner('GET', '/api/assistant/cards')).json.cards[0]);
    assert.equal(card.tool, 'set_auto_mode');
    assert.ok(card.lines.some((l) => /Turn it ON/.test(l)));
    assert.equal((await owner('POST', `/api/assistant/cards/${card.id}/reject`, {})).status, 200);

    // ---- settings: validated; off → 403 for her token and the tab says what to do ----
    assert.equal((await owner('POST', '/api/assistant/settings', { level: 'max' })).status, 400);
    assert.equal((await owner('POST', '/api/assistant/settings', { accounts: ['nope'] })).status, 400);
    // A provider no coding tool of this version can use is not hers to tick; she runs only on a Claude Code one.
    assert.equal((await owner('POST', '/api/assistant/settings', { accounts: ['cx'] })).status, 400);
    assert.equal((await owner('POST', '/api/assistant/settings', { runsOn: 'cx' })).status, 400);
    assert.equal((await owner('POST', '/api/assistant/settings', { runsOn: 'oc' })).status, 400);
    const choices = (await owner('GET', '/api/assistant/settings')).json.accounts;
    assert.equal(choices.some((a) => a.name === 'cx'), false);
    assert.deepEqual(choices.filter((a) => ['oc', 'sub'].includes(a.name)).map((a) => [a.name, a.thinks]), [['oc', false], ['sub', true]]);
    // A choice saved by an earlier version (another tool's sign-in, a provider removed since, her engine on an
    // OpenCode-only key) has no box on the page; the page sends back what it was given, and Save must still work.
    saveConfig({ assistant: { ...loadConfig().assistant, accounts: ['sub', 'cx', 'gone', 'auto'], runsOn: 'oc' } });
    let shown = (await owner('GET', '/api/assistant/settings')).json.settings;
    assert.deepEqual([shown.accounts, shown.runsOnSet], [['sub', 'auto'], null]);
    r = await owner('POST', '/api/assistant/settings', { level: 'ask', accounts: shown.accounts, runsOn: shown.runsOnSet });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.settings.accounts, r.json.settings.runsOnSet, r.json.settings.level], [['sub', 'auto'], null, 'ask']);
    saveConfig({ assistant: { ...loadConfig().assistant, runsOn: 'sub' } });
    shown = (await owner('GET', '/api/assistant/settings')).json.settings;
    assert.equal(shown.runsOnSet, 'sub', 'a choice that is still valid is shown as saved');
    assert.match((await owner('POST', '/api/assistant/settings', { accounts: ['cx'] })).json.error, /no provider "cx" she can use/);
    r = await owner('POST', '/api/assistant/settings', { level: 'handsoff', accounts: ['api'], runsOn: 'api', model: 'haiku' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.settings.allowed, ['api']);
    // Activity lists what the owner changed: Save sends every value again, and the ones that stayed are left out.
    r = await owner('POST', '/api/assistant/settings', { level: 'handsoff', accounts: ['api'], runsOn: 'api', model: 'haiku', maxSteps: 20, maxMinutes: 30 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    let saved = (await owner('GET', '/api/assistant/audit?n=1')).json.entries[0];
    assert.deepEqual([saved.tool, saved.input], ['tia_settings', { maxMinutes: 30 }]);
    await owner('POST', '/api/assistant/settings', { level: 'handsoff', maxMinutes: 30 });
    saved = (await owner('GET', '/api/assistant/audit?n=1')).json.entries[0];
    assert.deepEqual(saved.input, { maxMinutes: 30 }, 'nothing changed: no new entry');
    r = await owner('POST', '/api/assistant/settings', { enabled: false });
    assert.equal(r.json.settings.enabled, false);
    r = await asTia('POST', '/api/assistant/call', { tool: 'list_sessions', args: {} });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'tia-off');
    r = await owner('GET', '/api/assistant');
    assert.equal(r.json.ready.ok, false);
    assert.match(r.json.ready.problem, /turned off/);
    // Never set (a new computer): off as well, for her calls and on Settings → Tia alike (she costs money).
    const { enabled: _was, ...unset } = loadConfig().assistant;
    saveConfig({ assistant: unset });
    r = await owner('GET', '/api/assistant');
    assert.equal(r.json.ready.ok, false, 'not on until the owner turns her on');
    assert.equal((await owner('GET', '/api/assistant/settings')).json.settings.enabled, false);
    assert.equal((await asTia('POST', '/api/assistant/call', { tool: 'list_sessions', args: {} })).json.code, 'tia-off');
    // While she is off no token for the owner's own client is made: its calls would all be refused.
    r = await owner('POST', '/api/assistant/client-token', {});
    assert.deepEqual([r.status, r.json.code], [409, 'tia-off']);
    assert.match(r.json.error, /on first/);
    assert.equal((await owner('GET', '/api/assistant/settings')).json.client, null);
    await owner('POST', '/api/assistant/settings', { enabled: true });

    // ---- the owner's own MCP client: a token with the same scope ----
    r = await owner('POST', '/api/assistant/client-token', {});
    assert.match(r.json.command, /^claude mcp add --scope user -e HOPRIG_ASSISTANT_TOKEN=tia_\S+ -e HOPRIG_DASHBOARD_URL=http:\/\/127\.0\.0\.1:\d+ hoprig -- hoprig mcp$/);
    const client = r.json.token;
    r = await request(base, 'POST', '/api/assistant/call', { body: { tool: 'list_sessions', args: {} }, headers: { Authorization: `Bearer ${client}` } });
    assert.equal(r.status, 200);
    assert.equal((await request(base, 'GET', '/api/state', { headers: { Authorization: `Bearer ${client}` } })).status, 403);
    await owner('POST', '/api/assistant/client-token/revoke', {});
    assert.equal((await request(base, 'POST', '/api/assistant/call', { body: { tool: 'list_sessions', args: {} }, headers: { Authorization: `Bearer ${client}` } })).status, 401);
  });
}

test('the token file is rotated at every start and removed at the end', { skip: process.platform === 'win32' && 'POSIX modes' }, async (t) => {
  const box = sandbox('tia-rot');
  t.after(() => box.cleanup());
  const { saveConfig } = await import('../../src/config.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  saveConfig({ server: { backend: 'pty', roots: [box.root] }, assistant: { enabled: true } });
  const file = path.join(stateDir(), 'assistant-token');
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const app = createServer({ watch: false, dashboardFile: false });
    await app.listen(0, '127.0.0.1');
    seen.push(fs.readFileSync(file, 'utf8').trim());
    await app.close();
    assert.equal(fs.existsSync(file), false);
  }
  assert.notEqual(seen[0], seen[1]);
});
