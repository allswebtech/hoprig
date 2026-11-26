// "Start with AI" for a new project (src/pcsetup/newprojectstart.mjs): the session opens in the project's folder with
// a first message that names the skill and carries docs/brief.md as written; only for a project with the skill and a
// brief, a brief edited since with hidden characters refused; the choices checked as Work's Do it checks them; the
// command route only with this dashboard's token; Tia's token refused.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { tempHome, writeTree } from '../workspace/helpers.mjs';

const t = tempHome('npstart');
process.env.HOPRIG_WORKSPACE_DIR = t.ws;
test.after(() => t.cleanup());

const { writeProfile } = await import('../../src/profiles.mjs');
const { newProjectFeature, cleanStart, readCommandToken, defaultsWords, COMMAND_PATH, COMMAND_HEADER } = await import('../../src/pcsetup/newprojectstart.mjs');
const { firstMessage } = await import('../../src/pcsetup/newproject.mjs');
writeProfile('main', { label: 'Main' });

const projects = path.join(t.ws, 'projects');
const BRIEF = 'A shop for shoes.\r\nबहुत बढ़िया.\n';
const skill = { '.claude/skills/new-project/SKILL.md': '---\nname: new-project\ndescription: x\n---\n' };
writeTree(path.join(projects, 'shop'), { ...skill, 'docs/brief.md': BRIEF });
writeTree(path.join(projects, 'noskill'), { 'docs/brief.md': BRIEF });
writeTree(path.join(projects, 'nobrief'), skill);
writeTree(path.join(projects, 'edited'), { ...skill, 'docs/brief.md': 'Hidden​ here' });
writeTree(path.join(projects, 'nocommit'), { ...skill, 'docs/brief.md': BRIEF });
// A project as `project new` leaves it: a git repository with its first commit (nocommit: one stopped before it).
const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
for (const name of ['shop', 'nocommit']) gitIn(path.join(projects, name), 'init', '-q', '-b', 'main');
gitIn(path.join(projects, 'shop'), 'add', '-A');
gitIn(path.join(projects, 'shop'), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'Start shop');
const defaults = writeTree(path.join(t.ws, 'ai_brain'), { 'project-defaults.md': '# Mine\n' });

const opened = [];
const chat = { open: async (b) => (opened.push(b), { id: `chat-${opened.length}`, sent: true, messageId: 'm1' }) };
const findProject = async (ref) => {
  const root = path.join(projects, ref);
  if (!/^[a-z]+$/.test(ref) || !fs.existsSync(root)) throw Object.assign(new Error('no such project'), { status: 404 });
  return { root, ref };
};
const ctx = { config: () => ({}), readJson: async (req) => req.body, defaultProvider: async () => 'main' };
const f = newProjectFeature(ctx, { chat, findProject, defaults: () => path.join(defaults, 'project-defaults.md') });
const call = async (method, url, body, headers = {}) => {
  const u = new URL(url, 'http://x');
  for (const [m, re, fn] of f.routes) {
    const match = re.exec(u.pathname);
    if (match && m === method) return fn(Object.assign(Readable.from([]), { body, headers }), match, u.searchParams);
  }
  throw new Error(`no route ${method} ${url}`);
};

test('the session opens in the project with the skill named and the brief as written, last and whole', async () => {
  const r = await call('POST', '/api/pcsetup/project/start', { name: 'shop', kind: 'web-app', scope: 'setup' });
  assert.deepEqual(r, { chat: 'chat-1', project: 'shop', tool: 'claude', toolName: 'Claude Code', provider: 'main', providerLabel: 'Main', model: null, effort: null, kind: 'web-app', scope: 'setup' });
  const b = opened[0];
  assert.equal(b.dir, path.join(projects, 'shop'));
  assert.equal(b.profile, 'main', 'the folder\'s default provider when none was chosen');
  assert.equal(b.defaults, true, 'Settings\' defaults, as Work\'s Do it');
  assert.match(b.text, /^<!-- hoprig:new-project shop -->\nUse the new-project skill \(\.claude\/skills\/new-project\/SKILL\.md\)/);
  // The kind is the owner's hint, never an order: the skill's fit decides it, and says so when the two differ.
  assert.match(b.text, /My hint for the kind: a web app with accounts \(`web-app`\)\. It is a hint: your fit decides the kind from the brief, and your one message says so when the two differ\./);
  assert.match(b.text, /\nScope: set-up only\. .*build no feature of the brief\./);
  assert.match(b.text, /My defaults for every project are in \.\.\/\.\.\/ai_brain\/project-defaults\.md/);
  assert.match(b.text, /do the fit \(the kind, both size tiers, the applies table and the stack\), and send me ONE message with the six points .* Read the references the skill reads always, and any other only when your applies table marks it full or light\. Then wait for my reply\./);
  assert.ok(b.text.endsWith(`----- my brief -----\n${BRIEF}`), 'the brief byte for byte, at the end');
  assert.equal(b.text, `<!-- hoprig:new-project shop -->\n${firstMessage({ brief: BRIEF, kind: 'web-app', scope: 'setup', defaults: '../../ai_brain/project-defaults.md' })}`);
  assert.match(firstMessage({ brief: 'x', scope: 'product' }), /\nScope: the whole product\./);
});

test('the defaults file is named with / between its parts, also on Windows', () => {
  assert.equal(defaultsWords('C:\\Users\\ann\\Workspace\\projects\\shop', 'C:\\Users\\ann\\Workspace\\ai_brain\\project-defaults.md', path.win32), '../../ai_brain/project-defaults.md');
  assert.equal(defaultsWords('/home/ann/Workspace/projects/shop', '/home/ann/Workspace/ai_brain/project-defaults.md', path.posix), '../../ai_brain/project-defaults.md');
});

test('a dry run says what would start and opens nothing; no kind and no defaults are said as such', async () => {
  const n = opened.length;
  const g = newProjectFeature(ctx, { chat, findProject, defaults: () => null });
  const [, re, fn] = g.routes.find(([m, x]) => m === 'POST' && x.test('/api/pcsetup/project/start'));
  const r = await fn(Object.assign(Readable.from([]), { body: { name: 'shop', dryRun: true }, headers: {} }), re.exec('/api/pcsetup/project/start'), new URLSearchParams());
  assert.equal(r.dryRun, true);
  assert.match(r.would.text, /I chose no kind: your fit works it out from the brief\./);
  assert.match(r.would.text, /Scope: as my brief says; the whole product when it says nothing\./, 'no scope chosen: a scope in the brief holds');
  assert.doesNotMatch(r.would.text, /My defaults/);
  assert.equal(opened.length, n);
});

test('only a project with the skill, a brief and a first commit; a brief with hidden characters edited in is refused', async () => {
  for (const [name, re, code] of [['noskill', /has no \.claude\/skills\/new-project\/SKILL\.md/, 'no-skill'], ['nobrief', /has no brief in docs\/brief\.md/, 'no-brief'], ['edited', /cannot be seen/, 'brief-hidden'], ['nocommit', /has no first commit: it was left half made/, 'no-commit']]) {
    await assert.rejects(call('POST', '/api/pcsetup/project/start', { name }), (e) => re.test(e.message) && e.status === 409 && e.details.code === code, name);
  }
  await assert.rejects(call('POST', '/api/pcsetup/project/start', { name: 'gone' }), /no such project/);
});

test('every choice is checked: the kind, the scope, the model, the effort, the provider, unknown keys, the name', async () => {
  const bad = [
    [{ name: 'shop', kind: 'game' }, /the kind is one of/],
    [{ name: 'shop', scope: 'everything' }, /the scope is one of: product, setup/],
    [{ name: 'shop', model: 'x y' }, /not a model/],
    [{ name: 'shop', model: 'gpt-9' }, /"gpt-9" is not one of the models Claude Code offers a subscription/], // the provider is a Claude sign-in
    [{ name: 'shop', effort: 'huge' }, /the effort must be one of/],
    [{ name: 'shop', provider: 'nobody' }, /does not serve/],
    [{ name: 'shop', path: '/etc' }, /not something this takes/],
    [{ name: '../etc' }, /not a project/],
    [{ name: 'shop', dryRun: 'yes' }, /true or false/],
  ];
  const n = opened.length;
  for (const [body, re] of bad) await assert.rejects(call('POST', '/api/pcsetup/project/start', body), re, JSON.stringify(body));
  assert.equal(opened.length, n, 'nothing opened');
  assert.deepEqual(cleanStart({ name: 'clients/shop', model: 'sonnet[1m]' }), { name: 'clients/shop', dryRun: false, model: 'sonnet[1m]' });
});

test('the choices for the page: tools, providers, models, efforts, the defaults, the kinds and the scopes', async () => {
  const c = await call('GET', '/api/pcsetup/project/start?name=newone');
  assert.equal(c.tool, 'claude');
  assert.equal(c.provider, 'main');
  assert.ok(c.providers.some((p) => p.name === 'main' && p.label === 'Main'));
  assert.ok(c.models.length && c.efforts.length);
  assert.deepEqual(c.kinds.map((k) => k.id), ['website', 'web-app', 'multi-tenant', 'internal', 'api', 'mobile-first', 'cli', 'library', 'extension', 'desktop']);
  assert.ok(c.kinds.every((k) => k.label && k.say), 'each kind in plain words');
  assert.deepEqual(c.scopes.map((x) => x.id), ['product', 'setup']);
  // The page's first step draws the kinds and scopes before it asks the server: its lists are the server's.
  const page = fs.readFileSync(new URL('../../web/newproject.js', import.meta.url), 'utf8');
  const ids = (name) => [...new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(page)[1].matchAll(/^ {2}\['([a-z-]*)', /gm)].map((m) => m[1]);
  assert.deepEqual(ids('KINDS'), ['', ...c.kinds.map((k) => k.id)], 'the page\'s kinds, after "not sure"');
  assert.deepEqual(ids('SCOPES'), c.scopes.map((x) => x.id));
  await assert.rejects(call('GET', '/api/pcsetup/project/start?name=../x'), /not a project name/);
});

test('Tia\'s token is refused', async () => {
  await assert.rejects(call('POST', '/api/pcsetup/project/start', { name: 'shop' }, { authorization: 'Bearer tia_abc' }), /owner's only/);
  await assert.rejects(call('GET', '/api/pcsetup/project/start', undefined, { authorization: 'Bearer tia_abc' }), /owner's only/);
});

test('the command route: only with this dashboard\'s token, then the same start', async () => {
  f.start();
  const token = readCommandToken();
  assert.match(token, /^hpc_[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(process.env.HOPRIG_STATE_DIR, 'project-command-token')).mode & 0o777), 0o600);
  const send = async (headers, body) => {
    let status;
    let out = '';
    const res = { writeHead: (s) => (status = s), end: (s) => (out = s) };
    const handled = await f.handle(Object.assign(Readable.from([]), { method: 'POST', url: COMMAND_PATH, headers, body }), res);
    return { handled, status, json: out ? JSON.parse(out) : null };
  };
  assert.equal((await send({}, { name: 'shop' })).status, 401);
  assert.equal((await send({ [COMMAND_HEADER]: `hpc_${'0'.repeat(64)}` }, { name: 'shop' })).status, 401);
  const ok = await send({ [COMMAND_HEADER]: token }, { name: 'shop', kind: 'cli' });
  assert.equal(ok.status, 200);
  assert.match(ok.json.chat, /^chat-/);
  const no = await send({ [COMMAND_HEADER]: token }, { name: 'nobrief' });
  assert.equal(no.status, 409);
  assert.equal(no.json.code, 'no-brief');
  assert.equal(await f.handle({ method: 'GET', url: '/api/other' }, {}), false, 'other requests are not this route\'s');
  f.close();
  assert.equal(readCommandToken(), null, 'the token goes with the dashboard');
});

test('a second start while the first session is open names that one; again opens another; a first message that did not go names its session', async () => {
  const mine = [];
  const shown = [];
  const twice = {
    open: async (b) => (mine.push(b), { id: `t-${mine.length}`, sent: b.text !== 'never' && mine.length !== 3, why: 'the coding tool ended' }),
    // The App's open sessions as cards, as the chat feature gives them (its folder is the real path).
    cards: () => [...mine.map((b, i) => ({ kind: 'chat', chatId: `t-${i + 1}`, title: b.title, cwd: fs.realpathSync(b.dir) })), ...shown],
  };
  const g = newProjectFeature(ctx, { chat: twice, findProject, defaults: () => null });
  const [, re, fn] = g.routes.find(([m, x]) => m === 'POST' && x.test('/api/pcsetup/project/start'));
  const post = (body) => fn(Object.assign(Readable.from([]), { body, headers: {} }), re.exec('/api/pcsetup/project/start'), new URLSearchParams());
  // Another chat in the same folder with another title is no start of this project.
  shown.push({ kind: 'chat', chatId: 'other', title: 'Fix the footer', cwd: path.join(projects, 'shop') });
  const first = await post({ name: 'shop' });
  assert.equal(first.chat, 't-1');
  await assert.rejects(post({ name: 'shop' }), (e) => e.status === 409 && e.details.code === 'started' && e.details.chat === 't-1' && /already open/.test(e.message));
  await assert.rejects(post({ name: 'shop', dryRun: true }), (e) => e.details.code === 'started', 'a dry run says the same');
  assert.equal(mine.length, 1, 'no second session');
  const again = await post({ name: 'shop', again: true });
  assert.equal(again.chat, 't-2', 'again: another one, as asked');
  await assert.rejects(post({ name: 'shop', again: 'yes' }), /again is true or false/);
  // One whose first message did not go: its id comes back, so the page goes to it instead of opening another.
  await assert.rejects(post({ name: 'shop', again: true }), (e) => e.details.code === 'not-sent' && e.details.chat === 't-3');
});

test('two starts sent at the same moment open one session: the second names the one the first opened', async () => {
  const mine = [];
  let entered;
  const opening = new Promise((r) => (entered = r));
  const slow = {
    // As the chat feature: the session is among the open ones only once the opening got that far.
    open: async (b) => {
      entered();
      await new Promise((r) => setTimeout(r, 30));
      mine.push(b);
      return { id: `s-${mine.length}`, sent: true };
    },
    cards: () => mine.map((b, i) => ({ kind: 'chat', chatId: `s-${i + 1}`, title: b.title, cwd: fs.realpathSync(b.dir) })),
  };
  const g = newProjectFeature({ ...ctx, defaultProvider: async () => (await new Promise((r) => setTimeout(r, 10)), 'main') }, { chat: slow, findProject, defaults: () => null });
  const [, re, fn] = g.routes.find(([m, x]) => m === 'POST' && x.test('/api/pcsetup/project/start'));
  const post = (body) => fn(Object.assign(Readable.from([]), { body, headers: {} }), re.exec('/api/pcsetup/project/start'), new URLSearchParams());
  const racing = [post({ name: 'shop' }), post({ name: 'shop' })];
  // A dry run while the session is being opened (not among the open ones yet) says the same.
  await opening;
  const both = await Promise.allSettled([...racing, post({ name: 'shop', dryRun: true })]);
  assert.equal(mine.length, 1, 'one session');
  // Which of the two gets there first is the system's to say: one opens, the other names it, and so does the dry run.
  assert.equal(both[2].status, 'rejected', 'the dry run');
  const won = both.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1, both.map((r) => r.reason && r.reason.message).join(' | '));
  assert.equal(won[0].value.chat, 's-1');
  for (const r of both.filter((x) => x.status === 'rejected')) assert.ok(r.reason.details && r.reason.details.code === 'started' && r.reason.details.chat === 's-1', r.reason.message);
  // A start that failed leaves nothing behind: the next one opens its session.
  const failing = { open: async () => { throw Object.assign(new Error('the coding tool is not installed'), { status: 409 }); }, cards: () => [] };
  const h = newProjectFeature(ctx, { chat: failing, findProject, defaults: () => null });
  const [, re2, fn2] = h.routes.find(([m, x]) => m === 'POST' && x.test('/api/pcsetup/project/start'));
  const post2 = (body) => fn2(Object.assign(Readable.from([]), { body, headers: {} }), re2.exec('/api/pcsetup/project/start'), new URLSearchParams());
  const two = await Promise.allSettled([post2({ name: 'shop' }), post2({ name: 'shop' })]);
  assert.deepEqual(two.map((r) => r.reason && r.reason.message), ['the coding tool is not installed', 'the coding tool is not installed'], 'the second waited for the first, then tried itself');
});

test('a project name longer than a chat\'s name can be: the open session is still found by the name the chat keeps', async () => {
  const { chatTitle } = await import('../../src/server/validate.mjs');
  const long = `n${'x'.repeat(75)}`; // a project's name may be 100 characters, a chat's name is cut at 80
  const root = writeTree(path.join(projects, long), { ...skill, 'docs/brief.md': BRIEF });
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'Start');
  const mine = [];
  const kept = {
    open: async (b) => (mine.push(b), { id: `l-${mine.length}`, sent: true }),
    // As the chat feature keeps a name it was given (POST /api/chats): cleaned and cut.
    cards: () => mine.map((b, i) => ({ kind: 'chat', chatId: `l-${i + 1}`, title: chatTitle(b.title), cwd: fs.realpathSync(b.dir) })),
  };
  const g = newProjectFeature(ctx, { chat: kept, findProject, defaults: () => null });
  const [, re, fn] = g.routes.find(([m, x]) => m === 'POST' && x.test('/api/pcsetup/project/start'));
  const post = (body) => fn(Object.assign(Readable.from([]), { body, headers: {} }), re.exec('/api/pcsetup/project/start'), new URLSearchParams());
  assert.equal((await post({ name: long })).chat, 'l-1');
  assert.equal(chatTitle(mine[0].title).length, 80, 'the name the chat keeps is cut');
  await assert.rejects(post({ name: long }), (e) => e.details && e.details.code === 'started' && e.details.chat === 'l-1');
  assert.equal(mine.length, 1, 'no second session');
});
