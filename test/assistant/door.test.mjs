// The door between Tia's tools and the dashboard's routes (src/assistant/door.mjs): only the routes her tools use,
// never the owner's own, no value from the model can move a request to another route, and nothing but the door
// calls ctx.dispatch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { ALLOW, NEVER, checkRoute, gatedDispatch } from '../../src/assistant/door.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { createOps } from '../../src/assistant/ops.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { tokenMayReach } from '../../src/machines/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const refused = (fn) => assert.throws(fn, (e) => e.status === 403 && e.code === 'tia-route');

/** A ctx whose dispatch records what reached it and answers like a friendly dashboard. */
function stubCtx(answer = () => ({})) {
  const seen = [];
  const ctx = {
    seen,
    config: () => ({ server: { roots: ['/home/owner/projects'] }, sessionDefaults: { permissionMode: 'default' }, assistant: { enabled: true, level: 'work' } }),
    poke() {},
    notify: async () => ({ sent: false }),
    async dispatch(method, url, body) {
      const u = new URL(url, 'http://x');
      seen.push({ method, path: u.pathname, url, body });
      return { status: 200, json: answer(method, u.pathname, body) };
    },
  };
  return ctx;
}

// The owner's own routes (L3 and "owner only"), with the method the page uses.
const OWNERS_ONLY = [
  ['POST', '/api/settings/password'], ['POST', '/api/login'], ['POST', '/api/login/link'], ['POST', '/api/login/links'], ['GET', '/api/login/links/abcdef123456'],
  ['POST', '/api/logout'], ['GET', '/api/me'],
  ['GET', '/api/tokens'], ['POST', '/api/tokens/abcdef123456/revoke'], ['POST', '/api/tokens/self/revoke'],
  ['POST', '/api/pair/code'], ['POST', '/api/pair/claim'], ['GET', '/api/joins'], ['POST', '/api/joins/x/leave'], ['POST', '/api/links/code'],
  ['POST', '/api/machines/url'], ['POST', '/api/machines/box2/remove'], ['POST', '/api/machines/install'], ['POST', '/api/machines/box2/test'],
  ['POST', '/api/profiles/add'], ['POST', '/api/profiles/sub/delete'], ['POST', '/api/profiles/sub/available'], ['GET', '/api/accounts'], ['POST', '/api/accounts/api'],
  // Claude Code's own sign-in: who is signed in, signing in (also as another account) and out are the owner's
  ['GET', '/api/accounts/claude-login/account'], ['POST', '/api/accounts/claude-login/start'], ['POST', '/api/accounts/claude-login/logout'], ['POST', '/api/accounts/claude-login/code'],
  ['POST', '/api/workspace/git/terminal'], ['POST', '/api/workspace/git/identity'], ['POST', '/api/workspace/git/signin'], ['POST', '/api/workspace/git/brain'], ['POST', '/api/addons/trouteai/setup'], ['POST', '/api/notify/test'], ['POST', '/api/onboarding/run'], ['POST', '/api/pcsetup/recipe'],
  ['GET', '/api/assistant'], ['POST', '/api/assistant/settings'], ['POST', '/api/assistant/client-token'], ['POST', '/api/assistant/cards/c_000000000000/confirm'],
  ['POST', '/api/assistant/chat'], ['POST', '/api/assistant/call'], ['GET', '/ws/term'],
];

test('the never-list: every owner-only route is refused at the door, here and on another computer, before any dispatch', () => {
  for (const [method, p] of OWNERS_ONLY) {
    refused(() => checkRoute(method, p, {}, stubCtx()));
    refused(() => checkRoute(method, `/m/box2${p}`, {}, stubCtx()));
    assert.ok(!ALLOW.some((e) => e.method === method && e.re.test(p)), `${method} ${p} must not be in ALLOW`);
  }
  for (const re of NEVER) assert.ok(!ALLOW.some((e) => re.test(e.path.replace(/\[\^\/\]\+/g, 'x').replace(/\((.+?)\|.*\)/, '$1'))), `${re} overlaps ALLOW`);
  const ctx = stubCtx();
  for (const [method, p] of OWNERS_ONLY) assert.throws(() => gatedDispatch(ctx, method, p, {}), /owner's own step|not a route Tia's tools use/);
  assert.equal(ctx.seen.length, 0, 'nothing reached dispatch');
});

test('dot segments, encoded dots, a foreign origin and odd computers cannot reach another route', () => {
  for (const url of [
    '/api/state/../settings/password', '/api/sessions/x/../../settings/password', '/api/sessions/x/%2e%2e/%2e%2e/settings/password',
    '/api/brain/../tokens', '//evil.example/api/state', 'http://evil.example/api/state', '/m/../api/settings/password', '/m/Box2/api/state',
    '/m/box2/../../api/logout', '/m/box2/api/../settings/password', '/api/state%2f..%2f..%2fsettings%2fpassword',
  ]) refused(() => checkRoute(url.includes('state') && !url.includes('password') ? 'GET' : 'POST', url, {}, stubCtx()));
  refused(() => checkRoute('DELETE', '/api/state', {}, stubCtx()));
  assert.equal(checkRoute('GET', '/m/box2/api/state', undefined, stubCtx()).computer, 'box2');
});

test('settings bodies carry only her keys; the permission mode of new sessions only unchanged', () => {
  const ctx = stubCtx();
  for (const body of [
    { server: { trustProxy: true } }, { server: { allowedOrigins: ['https://evil.example'] } }, { server: { notify: { url: 'https://x' } } },
    { server: { passwordHash: 'x' } }, { server: { host: '0.0.0.0' } }, { network: {} }, { sessionDefaults: { permissionMode: 'bypassPermissions' } }, null,
  ]) refused(() => checkRoute('POST', '/api/settings', body, ctx));
  assert.ok(checkRoute('POST', '/api/settings', { sessionDefaults: { model: 'sonnet', permissionMode: 'default' } }, ctx));
  assert.ok(checkRoute('POST', '/api/settings', { server: { uploadMaxMB: 50 }, autoSwitch: { enabled: true } }, ctx));
  refused(() => checkRoute('POST', '/api/automation/settings', { updates: { claude: 'auto' } }, ctx));
  refused(() => checkRoute('POST', '/api/automation/settings', { schedules: { list: [] } }, ctx));
  assert.ok(checkRoute('POST', '/api/automation/settings', { paused: true }, ctx));
  assert.ok(checkRoute('POST', '/api/automation/settings', { workspace: { push: true, everyHours: 6 } }, ctx));
  refused(() => checkRoute('POST', '/api/automation/settings', { workspace: { remote: 'x' } }, ctx));
});

// Each operation with an id from the model, the route it must reach, and its arguments with the id slot.
const SLOTS = [
  ['capture', 'GET', /^\/api\/sessions\/[^/]+\/history$/, (v) => ({ computer: 'this', session: v })],
  ['sendText', 'POST', /^\/api\/sessions\/[^/]+\/send$/, (v) => ({ computer: 'this', session: v, text: 'hi' })],
  ['pressKey', 'POST', /^\/api\/sessions\/[^/]+\/key$/, (v) => ({ computer: 'this', session: v, key: 'Enter' })],
  ['renameSession', 'POST', /^\/api\/sessions\/[^/]+\/rename$/, (v) => ({ computer: 'this', session: v, name: 'x' })],
  ['killSession', 'POST', /^\/api\/sessions\/[^/]+\/kill$/, (v) => ({ computer: 'this', session: v })],
  ['switchAccount', 'POST', /^\/api\/sessions\/[^/]+\/switch$/, (v) => ({ computer: 'this', session: v, profile: 'sub' })],
  ['queue', 'POST', /^\/api\/automation\/queue\/[^/]+$/, (v) => ({ computer: 'this', session: v, body: { op: 'clear' } })],
  ['renameComputer', 'POST', /^\/api\/machines\/[^/]+\/rename$/, (v) => ({ computer: v, label: 'x' })],
  ['addon', 'POST', /^\/api\/addons\/[^/]+\/start$/, (v) => ({ computer: 'this', id: v, action: 'start' })],
  ['browse', 'GET', /^\/api\/folders\/browse$/, (v) => ({ computer: 'this', path: v })],
  ['conversations', 'GET', /^\/api\/folders\/sessions$/, (v) => ({ computer: 'this', folder: v })],
  ['projectPreview', 'GET', /^\/api\/pcsetup\/project\/preview$/, (v) => ({ computer: 'this', name: v })],
  ['brainItem', 'GET', /^\/api\/brain\/item$/, (v) => ({ computer: 'this', id: v })],
  ['skillsFind', 'GET', /^\/api\/skillhub\/find$/, (v) => ({ computer: 'this', query: v })],
  ['skillsInstalled', 'GET', /^\/api\/skillhub$/, (v) => ({ computer: 'this', project: `/home/owner/projects/${v}` })],
  ['skillApprove', 'POST', /^\/api\/skillhub\/approve$/, (v) => ({ computer: 'this', id: v })],
  ['skillRemove', 'POST', /^\/api\/skillhub\/remove$/, (v) => ({ computer: 'this', name: v })],
  ['schedules', 'POST', /^\/api\/automation\/schedules$/, (v) => ({ computer: 'this', body: { op: 'delete', id: v } })],
  ['workspaceForget', 'POST', /^\/api\/workspace\/forget$/, (v) => ({ computer: 'this', name: v })],
  ['workspaceRestore', 'POST', /^\/api\/workspace\/restore$/, (v) => ({ computer: 'this', url: v, dryRun: true })],
  ['workspacePlaces', 'POST', /^\/api\/workspace\/settings$/, (v) => ({ computer: 'this', projects: `/home/owner/${v}` })],
  ['projectSync', 'POST', /^\/api\/pcsetup\/project\/sync$/, (v) => ({ computer: 'this', name: v })],
  ['setupFix', 'POST', /^\/api\/pcsetup\/fix$/, (v) => ({ computer: 'this', id: v })],
  ['startSession', 'POST', /^\/api\/sessions$/, (v) => ({ computer: 'this', folder: `/home/owner/projects/${v}`, profile: 'sub', mode: 'new' })],
];
const HOSTILE = ['a/../../settings', 'a%2f..%2f..%2fsettings', 'a?x=1', 'a#b', 'a\nb', '', 'x'.repeat(5000), '../../api/settings/password', '..', '%2e%2e'];

test('no value from the model changes the route: each reaches its own route or is refused at the door', async () => {
  for (const [op, method, route, args] of SLOTS) {
    for (const v of HOSTILE) {
      if (op === 'renameComputer' && v === '') continue; // no computer means this computer, by design (its own route)
      const ctx = stubCtx(() => ({ started: false }));
      const ops = createOps({ ctx, runShell: async () => ({}), jobWaitMs: 0 });
      let err = null;
      try {
        await ops[op](args(v));
      } catch (e) {
        err = e;
      }
      for (const s of ctx.seen) {
        assert.equal(s.method, method, `${op}(${JSON.stringify(v).slice(0, 30)})`);
        assert.match(s.path, route, `${op}(${JSON.stringify(v).slice(0, 30)}) reached ${s.path}`);
      }
      if (err) assert.ok(err.status === 403 && err.code === 'tia-route', `${op}(${JSON.stringify(v).slice(0, 30)}) threw ${err.message}`);
      else assert.ok(ctx.seen.length >= 1, `${op} dispatched nothing`);
    }
  }
});

test('through the tools: hostile values reach only the tool\'s own routes, or the tool refuses them', async () => {
  const ctx = stubCtx(() => ({}));
  const core = createAssistantCore({
    ops: createOps({ ctx, runShell: async () => ({}), jobWaitMs: 0 }), cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }),
    skills: new Skills({ dirs: [{ dir: '/nonexistent', source: 'owner' }] }),
  });
  // What any call may read for its checks (the level, the session, the providers), besides the tool's own routes.
  const COMMON = [/^\/api\/state$/, /^\/api\/settings$/, /^\/api\/machines\/sessions$/];
  const own = (tool) => ALLOW.filter((e) => e.tool.split(/,\s*/).some((t) => t.split(' ')[0] === tool)).map((e) => e.re);
  const calls = [
    (v) => ['read_session', { session: v }], (v) => ['send_to_session', { session: v, text: 'x' }], (v) => ['stop_session', { session: v }],
    (v) => ['read_brain', { item: v }], (v) => ['manage_project', { action: 'sync', project: v }], (v) => ['manage_skills', { action: 'install', review: v }],
    (v) => ['manage_skills', { action: 'remove', skill: v }], (v) => ['manage_automation', { action: 'delete_schedule', schedule: v }],
    (v) => ['manage_computer', { action: 'setup_fix', check: v }], (v) => ['manage_computer', { action: 'rename', label: 'x', computer: v }],
    (v) => ['list_projects', { folder: v }], (v) => ['manage_skills', { action: 'review', spec: v }], (v) => ['manage_project', { action: 'new', name: v }],
    (v) => ['manage_skills', { action: 'find', query: v }], (v) => ['manage_project', { action: 'get', spec: v }], (v) => ['start_session', { folder: v }],
  ];
  for (const make of calls) {
    for (const v of HOSTILE) {
      const [tool, args] = make(v);
      const from = ctx.seen.length;
      const r = await core.call(tool, args, { conversation: 'door' });
      const label = `${tool} ${JSON.stringify(v).slice(0, 30)}`;
      for (const s of ctx.seen.slice(from)) assert.ok([...COMMON, ...own(tool)].some((re) => re.test(s.path)), `${label} reached ${s.method} ${s.path}`);
      if (r.isError) assert.match(r.text, /^Error: /, label);
    }
  }
});

test('every route her tools use is in the table, and nothing else', async () => {
  const ctx = stubCtx((m, p) => (/^\/api\/(pcsetup|workspace)\/job$/.test(p) ? { running: false, result: { ok: true } } : p === '/api/machines/ssh' ? { machine: { name: 'x' } } : { started: true }));
  const ops = createOps({ ctx, runShell: async () => ({}), jobWaitMs: 0 });
  const c = 'this';
  const runs = [
    ops.listSessions({}), ops.listSessions({ computer: 'box2' }), ops.capture({ computer: c, session: 's' }), ops.startSession({ computer: c, folder: '/p', profile: 'sub', mode: 'new' }),
    ops.sendText({ computer: c, session: 's', text: 't' }), ops.pressKey({ computer: c, session: 's', key: 'Enter' }), ops.renameSession({ computer: c, session: 's', name: 'n' }),
    ops.killSession({ computer: c, session: 's' }), ops.switchAccount({ computer: c, session: 's', profile: 'sub' }), ops.recentFolders({ computer: c }),
    ops.browse({ computer: c, path: '/p' }), ops.conversations({ computer: c, folder: '/p' }), ops.projects({ computer: c }), ops.projectPreview({ computer: c, name: 'n' }),
    ops.projectNew({ computer: c, name: 'n' }), ops.projectGet({ computer: c, spec: 'a/b' }), ops.projectAdd({ computer: c, name: 'n', repo: 'r' }),
    ops.projectSync({ computer: c, name: 'n' }), ops.projectInstall({ computer: c, dir: 'n' }), ops.workspace({ computer: c }), ops.workspaceSetup({ computer: c, dryRun: true }),
    ops.brainIndex({ computer: c }), ops.brainItem({ computer: c, id: 'i' }), ops.accounts({ computer: c }), ops.setAutoSwitch({ computer: c, patch: { enabled: true } }),
    ops.computers(), ops.computerStatus({ computer: c }), ops.setupStatus({ computer: c }), ops.setupKits({ computer: c }), ops.setupFix({ computer: c, id: 'i' }),
    ops.setUp({ computer: c, kits: ['k'] }), ops.updateClaude({ computer: c }), ops.killProcess({ computer: c, pid: 9 }), ops.power({ computer: c, action: 'reboot' }),
    ops.addComputer({ sshTarget: 'a@b' }), ops.renameComputer({ computer: c, label: 'l' }), ops.renameComputer({ computer: 'box2', label: 'l' }), ops.addons({ computer: c }),
    ops.addon({ computer: c, id: 'a', action: 'stop' }), ops.publicLink({ computer: c }), ops.setPublicLink({ computer: c, on: true, kind: 'temporary' }), ops.automation({ computer: c }), ops.automationSettings({ computer: c, patch: { paused: true } }),
    ops.schedules({ computer: c, body: { op: 'delete', id: 'x' } }), ops.queue({ computer: c, session: 's', body: { op: 'clear' } }), ops.skillsInstalled({ computer: c }),
    ops.skillsSuggested({ computer: c }), ops.skillsFind({ computer: c, query: 'q' }), ops.skillReview({ computer: c, spec: 's' }), ops.skillUpdateReview({ computer: c, name: 'n' }),
    ops.skillApprove({ computer: c, id: 'i' }), ops.skillRemove({ computer: c, name: 'n' }), ops.skillsCheck({ computer: c }), ops.projectsFolder({ computer: c, dir: '/p' }),
    ops.workingRules({ computer: c, add: true }), ops.skillsWeekly({ computer: c, weekly: true }), ops.settings({ computer: c }),
    ops.changeSettings({ computer: c, patch: { server: { uploadMaxMB: 5 } } }), ops.runCommand({ computer: c, command: 'true' }),
    ops.workspaceMap({ computer: c }), ops.workspaceMapWrite({ computer: c, dryRun: true }), ops.workspaceGit({ computer: c }),
    ops.workspaceRestore({ computer: c, url: 'https://git.example.com/o/b.git', dryRun: true }), ops.workspaceRestore({ computer: c, url: 'https://git.example.com/o/b.git' }),
    ops.workspaceSync({ computer: c, dryRun: true }), ops.workspaceSync({ computer: c, with: 'box2' }), ops.workspacePlaces({ computer: c, projects: '/p' }),
    ops.workspaceForget({ computer: c, name: 'blog' }),
    ops.startChat({ computer: c, folder: '/p', profile: 'sub', text: 't' }), ops.sendToChat({ computer: c, id: '44444444-4444-4444-8444-444444444444', text: 't' }),
    ops.answerChat({ computer: c, id: '44444444-4444-4444-8444-444444444444', request: 'r', allow: true, always: false }), ops.stopChat({ computer: c, id: '44444444-4444-4444-8444-444444444444' }),
    ops.startChat({ computer: c, folder: '/p', profile: 'sub', tool: 'opencode' }), ops.startSession({ computer: c, folder: '/p', profile: 'sub', mode: 'new', tool: 'opencode' }),
    ops.codingTools({ computer: c }), ops.setCodingTool({ computer: c, id: 'opencode', on: true }), ops.updates({ computer: c }),
    ops.checkUpdates({ computer: c }), ops.runUpdate({ computer: c, id: 'claude' }),
    ops.moveChat({ computer: c, id: '44444444-4444-4444-8444-444444444444', profile: 'sub2' }),
  ];
  const results = await Promise.allSettled(runs);
  const errors = results.filter((x) => x.status === 'rejected').map((x) => x.reason.message);
  assert.deepEqual(errors, [], 'no route of hers is missing from the table');
  const used = new Set(ctx.seen.map((s) => `${s.method} ${s.path.replace(/^\/m\/[^/]+/, '')}`));
  const unused = ALLOW.filter((e) => ![...used].some((u) => u.startsWith(`${e.method} `) && e.re.test(u.slice(e.method.length + 1))));
  assert.deepEqual(unused.map((e) => `${e.method} ${e.path}`), [], 'every table entry is a route a tool uses');
});

test('only the door calls ctx.dispatch', () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if ((e.name.endsWith('.mjs') || e.name.endsWith('.js')) && /\.dispatch\(|\{[^}]*\bdispatch\b[^}]*\}\s*=/.test(fs.readFileSync(p, 'utf8'))) callers.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'web'));
  assert.deepEqual(callers, [path.join('src', 'assistant', 'door.mjs')]);
});

test('the other computer decides too: its gate refuses a hub token on the owner-only routes it guards', () => {
  // A relayed request arrives with the hub's machine token and meets that computer's TOKEN_FORBIDDEN gate.
  for (const p of ['/api/settings/password', '/api/login', '/api/logout', '/api/tokens', '/api/pair/code', '/api/machines/x/remove', '/api/joins', '/api/links/code', '/api/accounts', '/api/assistant/settings', '/api/assistant/client-token', '/api/assistant/cards/c_1/confirm', '/api/machine/label']) {
    assert.equal(tokenMayReach(p), false, p);
  }
  // What a hub may call there (the same owner): the door here is what keeps these from Tia.
  for (const p of ['/api/profiles/add', '/api/notify/test', '/api/pcsetup/recipe', '/api/settings', '/api/assistant/run']) assert.equal(tokenMayReach(p), true, p);
});

test('setup and fix: Tia sends the kits or the check, never a password and never the terminal fallback', () => {
  assert.equal(checkRoute('POST', '/api/pcsetup/setup', { kits: ['basics'] }, stubCtx()).tool, 'manage_computer set_up');
  // The public link: only through its own route, with on/kind and nothing else; never its old add-on routes or its set-up.
  assert.equal(checkRoute('POST', '/api/public-link', { on: true, kind: 'custom' }, stubCtx()).tool, 'manage_computer public_link');
  assert.throws(() => checkRoute('POST', '/api/public-link', { on: true, password: 'x' }, stubCtx()), /"password" is the owner's to send/);
  for (const p of ['/api/addons/public-link/start', '/api/addons/public-link/do/fixed-on', '/api/public-link/custom/sign-in', '/api/public-link/temporary/add-service']) {
    assert.throws(() => checkRoute('POST', p, {}, stubCtx()), `${p} is refused`);
  }
  assert.equal(checkRoute('POST', '/api/addons/trouteai/start', {}, stubCtx()).tool, 'manage_computer addon');
  assert.equal(checkRoute('POST', '/m/box2/api/pcsetup/fix', { id: 'extras.tmux' }, stubCtx()).computer, 'box2');
  for (const [p, b] of [['/api/pcsetup/setup', { kits: ['basics'], password: 'x' }], ['/api/pcsetup/setup', { kits: ['basics'], terminal: true }], ['/api/pcsetup/fix', { id: 'x', password: 'x' }], ['/api/pcsetup/fix', 'x']]) {
    refused(() => checkRoute('POST', p, b, stubCtx()));
  }
});

test('an encoded spelling is read as the route reads it: the public link\'s old routes stay closed however they are spelled', () => {
  // A route decodes its ids (the add-on's, a session's): the door decodes each segment once, the same way, and judges
  // that. A segment that would still hold an encoded character after it (a doubly encoded one) is refused outright.
  for (const p of [
    '/api/addons/public-link/start', '/api/addons/public%2Dlink/start', '/api/addons/%70ublic-link/start', '/m/laptop/api/addons/public%2dlink/start',
    '/api/addons/public%252Dlink/start', '/api/addons/public%2dlink/do/fixed-on', '/api/addons/public-link%2fstart', '/api/addons/%E0%A4%A/start',
    '/api/updates/%73ettings', '/api/codetools/opencode/%73ignin', '/api/%61ssistant/settings', '/api/sessions/a%5cb/send', '/api/sessions/a%00b/send',
  ]) refused(() => checkRoute('POST', p, {}, stubCtx()));
  // What her tools send still passes, and an encoded character that is an ordinary one is read as that character.
  assert.equal(checkRoute('POST', '/api/addons/trouteai/start', {}, stubCtx()).tool, 'manage_computer addon');
  assert.equal(checkRoute('POST', '/api/addons/%74routeai/start', {}, stubCtx()).route, '/api/addons/trouteai/start');
  assert.equal(checkRoute('POST', '/api/sessions/my%20work/send', {}, stubCtx()).route, '/api/sessions/my work/send');
});
