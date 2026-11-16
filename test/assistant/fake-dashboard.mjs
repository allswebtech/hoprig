// A fake dashboard for the assistant's tests and its real-model eval: in-memory state behind the OPS interface
// (src/assistant/tools.mjs), every call recorded, hosted with the real core.mjs over the same HTTP route the real
// dashboard will serve (POST /api/assistant/call, bearer token). Nothing here touches tmux, files or the network
// beyond 127.0.0.1.
import http from 'node:http';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));

export function baseState() {
  return {
    computers: [{ name: 'this', label: 'Laptop', online: true }, { name: 'box2', label: 'Build box', online: true }],
    sessions: [
      { computer: 'this', name: 'api-fix', kind: 'claude', status: 'working', profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/api', title: 'Fix the login test', lastMessage: 'Running the tests now.', note: '', limit: null, sessionId: '11111111-1111-4111-8111-111111111111', statusAt: Date.now() - 60_000, created: 1_700_000_001_000 },
      { computer: 'this', name: 'web-ui', kind: 'claude', status: 'waiting', profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/web', title: 'Dark mode', lastMessage: 'Dark mode is done. Should I also update the screenshots?', note: '', limit: null, sessionId: '22222222-2222-4222-8222-222222222222', statusAt: Date.now() - 5 * 60_000, created: 1_700_000_002_000 },
      { computer: 'box2', name: 'shell', kind: 'shell', cwd: '/home/owner', title: '', statusAt: Date.now() - 3_600_000, created: 1_700_000_003_000 },
    ],
    screens: {
      'this|api-fix': '> npm test\n  ✔ 41 passing\n  ✖ 1 failing: login keeps the session\n',
      'this|web-ui': 'Dark mode is done. Should I also update the screenshots?\n> ',
      'box2|shell': 'owner@box2:~$ ',
    },
    roots: ['/home/owner/projects'],
    recent: ['/home/owner/projects/api', '/home/owner/projects/web', '/home/owner/projects/hoprig'],
    subdirs: { '/home/owner/projects': ['api', 'web', 'hoprig', 'shop'], '/home/owner/projects/hoprig': ['src', 'test'] },
    conversations: { '/home/owner/projects/api': [{ id: '33333333-3333-4333-8333-333333333333', at: Date.now() - 86_400_000, title: 'Refactor the auth module' }] },
    profiles: [
      { name: 'sub', label: 'Main', kind: 'subscription', inUse: 2, limited: null, usage: { fiveHour: { pct: 40 } } },
      { name: 'sub2', label: 'Second', kind: 'subscription', inUse: 0, limited: null, usage: null },
      { name: 'api', label: 'API key', kind: 'api', inUse: 0, limited: null, usage: null },
    ],
    autoSwitch: { enabled: false, order: ['sub', 'sub2'], returnToPreferred: false, prompt: 'Continue from where you stopped.', cooldownMinutes: 300 },
    status: {
      this: { load: [0.8, 0.7, 0.6], memory: { usedPct: 61 }, disks: [{ mount: '/', usedPct: 72 }], processes: [{ pid: 4242, command: 'node build.js --watch', cpu: 95, mem: 3, started: 1700000000 }, { pid: 777, command: 'claude', cpu: 4, mem: 2, started: 1700000100 }], claude: { version: '2.1.325', latest: '2.1.330' } },
      box2: { load: [2.1, 1.9, 1.5], memory: { usedPct: 48 }, disks: [{ mount: '/', usedPct: 91 }], processes: [{ pid: 9001, command: 'postgres', cpu: 12, mem: 9, started: 1700000200 }], claude: { version: '2.1.320', latest: '2.1.330' } },
    },
    settings: { server: { quickActions: [{ label: 'continue', text: 'continue' }], roots: ['/home/owner/projects'], publicUrl: '', notify: { url: 'https://ntfy.sh/secret-topic' } }, uploads: { dir: '.uploads', maxMB: 25 }, autoSwitch: null, sessionDefaults: { effort: 'high' } },
    projects: {
      projectsDir: '/home/owner/projects',
      workspaces: [{ id: 'shop', name: 'shop', dir: '/home/owner/projects/shop', repos: [{ rel: 'code/web', branch: 'main', changes: 0, ahead: 0, behind: 2, upstream: true, ok: true, installs: ['npm ci'] }, { rel: 'code/api', branch: 'main', changes: 1, ahead: 0, behind: 0, upstream: true, ok: true, installs: [] }] }],
      repos: [
        { id: 'api', rel: 'api', dir: '/home/owner/projects/api', branch: 'main', changes: 0, ahead: 3, behind: 0, upstream: true, ok: true, installs: [] },
        { id: 'hoprig', rel: 'hoprig', dir: '/home/owner/projects/hoprig', branch: 'main', changes: 0, ahead: 0, behind: 0, upstream: true, ok: true, installs: ['npm ci'] },
      ],
    },
    workspaceMap: {
      exists: true,
      entries: [
        { kind: 'project', label: 'shop', url: 'https://git.example.com/owner/shop.git', path: '~/projects/shop', state: 'here' },
        { kind: 'project', label: 'blog', url: 'https://git.example.com/owner/blog.git', path: '~/projects/blog', state: 'missing' },
        { kind: 'other', label: 'tools/notes', url: null, path: '~/Workspace/tools/notes', state: 'unmapped' },
      ],
      map: { projects: [{ name: 'shop' }, { name: 'blog' }], others: [] },
      tools: [],
      saved: { unsaved: true },
    },
    mapNotes: ['tools/notes has no online address: it is listed without one'],
    git: { identity: { set: true, name: 'Owner', email: 'owner@example.com' }, gh: { installed: true, signedIn: true, account: 'owner' }, gitUsesGh: true, brain: { remote: 'https://git.example.com/owner/brain.git', inStep: true } },
    syncLines: ['shop/code/web  pulled 2', 'brain  2 commits to push'],
    syncRepos: [{ label: 'shop/code/web', did: ['pulled 2'], todo: [] }, { label: 'brain', did: [], todo: [{ kind: 'push', why: '2 local commits are not uploaded', command: 'git -C ~/Workspace/ai_brain push' }] }],
    workspace: { dir: '/home/owner/Workspace', projectsDir: '/home/owner/projects', folders: [{ id: 'projects', rel: 'projects', exists: true }, { id: 'ai_brain', rel: 'ai_brain', exists: false }, { id: 'backups', rel: 'backups', exists: false }] },
    brain: { brain: { learnings: { id: 'learnings', title: 'Learnings' }, pending: { id: 'pending', title: 'Pending' } }, projects: [{ id: 'p:shop', title: 'shop memory' }] },
    brainItems: { learnings: { id: 'learnings', title: 'Learnings', file: 'learnings.md', text: 'Use npm ci, not npm install.', size: 28 }, pending: { id: 'pending', title: 'Pending', file: 'PENDING.md', text: 'Finish the checkout page.', size: 25 }, 'p:shop': { id: 'p:shop', title: 'shop memory', file: 'shop/MEMORY.md', text: 'The shop uses Stripe test keys.', size: 30 } },
    setup: { ok: false, checks: [{ id: 'kit:node.node', label: 'Node.js', status: 'ok', detail: 'v26' }, { id: 'kit:tools.gh', label: 'GitHub CLI', status: 'missing', detail: 'missing', fixKit: 'tools' }, { id: 'os.updates', label: 'System updates', status: 'warn', detail: '3 pending', fix: 'sudo apt upgrade' }] },
    kits: [{ id: 'tools', title: 'Developer tools', items: [{ name: 'gh', state: 'missing' }], commands: ['apt install gh'], admin: true }, { id: 'node', title: 'Node.js', items: [], commands: [], admin: false }],
    addons: [{ id: 'trouteai', title: 'TRouteAI', installed: true, running: false, version: '1.2.0' }],
    publicLink: { on: false, kind: 'temporary', state: 'off', url: null, custom: { state: 'none' } },
    // Settings → Coding tools and Settings → Updates (src/codetools/feature.mjs, src/automation/updater.mjs)
    codingTools: [
      { id: 'claude', name: 'Claude Code', on: true, managed: false, installed: '2.1.325', providers: ['sub', 'sub2', 'api'] },
      { id: 'opencode', name: 'OpenCode', on: false, managed: true, installed: null, providers: [] },
    ],
    updates: {
      mode: 'manual', notify: true, running: null,
      items: [
        { id: 'hoprig', title: 'Hoprig', whenRunning: 'The new version is used after the dashboard restarts.', installed: '0.9.0', latest: '0.9.0', updateAvailable: false, canUpdate: true, action: null, blocked: null },
        { id: 'claude', title: 'Claude Code', whenRunning: 'Running sessions keep the version they started with and use the new one when they start again.', installed: '2.1.325', latest: '2.1.330', updateAvailable: true, canUpdate: true, action: 'update', blocked: null },
        { id: 'opencode', title: 'OpenCode', whenRunning: 'Close its sessions first: the update replaces the program\'s files.', installed: null, latest: '2.3.0', updateAvailable: false, canUpdate: true, action: 'install', blocked: null, note: 'Installs 2.3.0, the version this Hoprig is tested with.' },
        { id: 'cloudflared', title: 'Tunnel helper (cloudflared)', whenRunning: 'Never while a public link is on.', installed: '2025.1.0', latest: '2025.1.0', updateAvailable: false, canUpdate: true, action: null, blocked: null },
      ],
    },
    automation: { settings: { paused: false, queue: { enabled: true }, schedules: { enabled: true, list: [] }, restore: { enabled: null }, retry: { enabled: false }, updates: { claude: 'off' }, idle: { shells: false, gateway: false } }, schedules: [{ id: 'abcd1234', label: 'Morning tests', enabled: true, when: { kind: 'daily', time: '08:00' }, action: { type: 'start', dir: '/home/owner/projects/shop', profile: 'sub', prompt: 'run the tests' }, nextAt: null }], queues: {} },
    skills: { user: { skills: [{ name: 'tdd', source: 'catalog' }] }, settings: { weekly: false } },
    reviews: { 'pdf-tools': { id: 'r1', name: 'pdf-tools', description: 'Read PDFs.', source: { type: 'git', repo: 'acme/skills', path: 'pdf', commit: 'abcdef123' }, scope: { kind: 'user' }, files: [{ path: 'SKILL.md' }, { path: 'run.sh' }], findings: [{ severity: 'warn', rule: 'script', message: 'runs a shell script', file: 'run.sh' }], counts: { block: 0 }, skillMd: '# PDF tools\nUse pdftotext.' } },
    assistant: { enabled: true, level: 'work' }, // config.json "assistant" (src/assistant/tia.mjs); she is off by default, the tests turn her on
  };
}

export class FakeOps {
  constructor(state = baseState()) {
    this.s = clone(state);
    this.calls = []; // every write: { op, args }
    this.reads = []; // every read: { op, args }
  }

  #session(computer, name) {
    const c = this.s.sessions.find((x) => x.computer === computer && x.name === name);
    if (!c) throw Object.assign(new Error('no such session'), { status: 404 });
    return c;
  }
  #read(op, args) {
    this.reads.push({ op, args });
  }
  #write(op, args) {
    this.calls.push({ op, args: clone(args) });
  }
  #lastMade = 0;
  // When a terminal was made, as its card's `created`: never the same twice, as a real terminal's.
  #made() {
    this.#lastMade = Math.max(Date.now(), this.#lastMade + 1);
    return this.#lastMade;
  }

  async listSessions({ computer }) {
    this.#read('listSessions', { computer });
    return clone(this.s.sessions.filter((c) => !computer || c.computer === computer));
  }
  async capture({ computer, session, lines }) {
    this.#read('capture', { computer, session, lines });
    this.#session(computer, session);
    return this.s.screens[`${computer}|${session}`] || '';
  }
  async recentFolders() {
    return { folders: this.s.recent, roots: this.s.roots };
  }
  async browse({ path }) {
    // Every folder this fake dashboard lists elsewhere (a project, a repository, a recent folder) exists here too.
    const known = [...this.s.projects.workspaces.map((w) => w.dir), ...this.s.projects.repos.map((r) => r.dir), ...this.s.recent];
    const dirs = this.s.subdirs[path] || (known.includes(path) ? [] : null);
    if (!dirs) throw Object.assign(new Error('folder not found or not allowed'), { status: 404 });
    return { path, dirs: dirs.map((n) => ({ name: n, path: `${path}/${n}` })) };
  }
  async conversations({ folder }) {
    return clone(this.s.conversations[folder] || []);
  }
  async accounts() {
    const recommended = this.s.autoSwitch.enabled ? 'auto' : 'sub';
    return { profiles: clone(this.s.profiles), autoSwitch: clone(this.s.autoSwitch), recommended };
  }
  async computers() {
    return clone(this.s.computers);
  }
  async computerStatus({ computer }) {
    this.#read('computerStatus', { computer });
    const st = this.s.status[computer];
    if (!st) throw Object.assign(new Error('no such computer'), { status: 404 });
    return clone(st);
  }
  async settings() {
    return clone(this.s.settings);
  }
  async assistantSettings() {
    return clone(this.s.assistant);
  }

  async startSession(a) {
    this.#write('startSession', a);
    this.#toolReady(a);
    if (!this.s.roots.some((r) => a.folder === r || a.folder.startsWith(r + '/'))) throw Object.assign(new Error('choose a folder inside the allowed roots'), { status: 400 });
    if (!this.s.profiles.some((p) => p.name === a.profile) && !(a.profile === 'auto' && this.s.autoSwitch.enabled)) throw Object.assign(new Error('unknown profile'), { status: 400 });
    // One conversation, one process (src/chat/handoff.mjs claim): a conversation that runs already gives that place.
    const runs = a.sessionId && this.s.sessions.find((x) => x.sessionId === a.sessionId && (x.computer || 'this') === a.computer);
    if (runs) return runs.kind === 'chat' ? { chat: runs.chatId, existing: true, ...(a.prompt ? { sent: false } : {}) } : { name: runs.name, existing: true, ...(a.prompt ? { sent: false } : {}) };
    const base = a.folder.split('/').pop() || 'session';
    let name = base;
    for (let i = 2; this.s.sessions.some((c) => c.computer === a.computer && c.name === name); i++) name = `${base}-${i}`;
    this.s.sessions.push({ computer: a.computer, name, kind: a.tool && a.tool !== 'claude' ? a.tool : 'claude', status: 'working', profile: { name: a.profile, label: a.profile, kind: 'subscription' }, cwd: a.folder, title: a.prompt ? a.prompt.slice(0, 60) : '', lastMessage: '', note: '', limit: null, sessionId: '44444444-4444-4444-8444-44444444444' + (this.s.sessions.length % 10), statusAt: Date.now(), created: this.#made() });
    return { name };
  }
  // A chat (src/chat) is "chat:<id>" among the sessions.
  async startChat(a) {
    this.#write('startChat', a);
    this.#toolReady(a);
    if (!this.s.roots.some((r) => a.folder === r || a.folder.startsWith(r + '/'))) throw Object.assign(new Error('choose a folder inside the allowed roots'), { status: 400 });
    if (!this.s.profiles.some((p) => p.name === a.profile) && !(a.profile === 'auto' && this.s.autoSwitch.enabled)) throw Object.assign(new Error('there is no such provider'), { status: 400 });
    // As the dashboard does: a conversation an open chat runs gives that chat, as it is (feature.mjs openChat).
    const open = a.sessionId && this.s.sessions.find((x) => x.kind === 'chat' && x.sessionId === a.sessionId && (x.computer || 'this') === a.computer);
    if (open) return { id: open.chatId, existing: true, permissionMode: open.permissionMode || null, ...(a.text ? { sent: false, why: 'this conversation is already open in a chat; write to that chat' } : {}) };
    const id = a.sessionId || `55555555-5555-4555-8555-5555555555${String(this.s.sessions.length % 100).padStart(2, '0')}`;
    this.s.sessions.push({ computer: a.computer, name: `chat:${id}`, kind: 'chat', ...(a.tool && a.tool !== 'claude' ? { tool: a.tool } : {}), chatId: id, byTia: true, status: a.text ? 'working' : 'waiting', profile: { name: a.profile, label: a.profile, kind: 'subscription' }, cwd: a.folder, title: a.text ? a.text.slice(0, 60) : '', lastMessage: '', note: '', limit: null, sessionId: id, statusAt: Date.now(), created: this.#made() });
    return { id };
  }
  async sendToChat(a) {
    this.#write('sendToChat', a);
    const c = this.#session(a.computer, `chat:${a.id}`);
    const queued = c.status === 'working';
    c.status = 'working';
    return { id: 'm1', queued };
  }
  async answerChat(a) {
    this.#write('answerChat', a);
    const c = this.#session(a.computer, `chat:${a.id}`);
    c.status = 'working';
    c.ask = null;
    return { ok: true };
  }
  async stopChat(a) {
    this.#write('stopChat', a);
    this.#session(a.computer, `chat:${a.id}`).status = 'waiting';
    return { ok: true };
  }
  async sendText(a) {
    this.#write('sendText', a);
    this.#session(a.computer, a.session).status = 'working';
  }
  async pressKey(a) {
    this.#write('pressKey', a);
  }
  async renameSession(a) {
    this.#write('renameSession', a);
    this.#session(a.computer, a.session).name = a.name;
    return { name: a.name };
  }
  async notify(a) {
    this.#write('notify', a);
    return { sent: true };
  }
  async killSession(a) {
    this.#write('killSession', a);
    this.s.sessions = this.s.sessions.filter((c) => !(c.computer === a.computer && c.name === a.session));
  }
  async switchAccount(a) {
    this.#write('switchAccount', a);
    const c = this.#session(a.computer, a.session);
    c.profile = { name: a.profile, label: a.profile, kind: (this.s.profiles.find((p) => p.name === a.profile) || {}).kind || 'auto' };
    c.limit = null;
  }
  async setAutoSwitch(a) {
    this.#write('setAutoSwitch', a);
    Object.assign(this.s.autoSwitch, a.patch);
  }
  async updateClaude(a) {
    this.#write('updateClaude', a);
    return { started: true };
  }
  // ---- the coding tools and Settings → Updates ----
  async codingTools({ computer }) {
    this.#read('codingTools', { computer });
    return { tools: clone(this.s.codingTools) };
  }
  async setCodingTool(a) {
    this.#write('setCodingTool', a);
    const t = this.s.codingTools.find((x) => x.id === a.id);
    if (!t) throw Object.assign(new Error('there is no such coding tool'), { status: 404 });
    if (!a.on && !this.s.codingTools.some((x) => x.on && x.id !== a.id)) throw Object.assign(new Error('choose at least one coding tool'), { status: 400 });
    t.on = a.on;
    return { tools: clone(this.s.codingTools) };
  }
  async updates({ computer }) {
    this.#read('updates', { computer });
    return clone(this.s.updates);
  }
  async checkUpdates({ computer }) {
    this.#read('checkUpdates', { computer });
    return clone(this.s.updates);
  }
  async runUpdate(a) {
    this.#write('runUpdate', a);
    const r = this.s.updates.items.find((x) => x.id === a.id);
    if (a.id !== 'all' && (!r || !r.action)) throw Object.assign(new Error('nothing to update'), { status: 409 });
    return { started: true, ids: a.id === 'all' ? this.s.updates.items.filter((x) => x.action === 'update' && x.updateAvailable).map((x) => x.id) : [a.id], skipped: [] };
  }
  /** As the computer checks a start of another coding tool: on, installed, and a provider that serves it. */
  #toolReady(a) {
    if (!a.tool || a.tool === 'claude') return;
    const t = this.s.codingTools.find((x) => x.id === a.tool);
    if (!t) throw Object.assign(new Error('there is no such coding tool'), { status: 400 });
    if (!t.on || !t.installed) throw Object.assign(new Error(`${t.name} is not ${t.installed ? 'turned on' : 'installed'} on this computer`), { status: 400 });
    const p = this.s.profiles.find((x) => x.name === a.profile);
    if (!p || !(p.tools || ['claude']).includes(a.tool)) throw Object.assign(new Error(`The provider cannot be used for ${t.name}.`), { status: 400 });
  }
  // ---- projects, workspace, brain ----
  async projects() {
    return clone(this.s.projects);
  }
  async projectPreview({ name }) {
    return { name, dir: `/home/owner/projects/${name}`, exists: this.s.projects.workspaces.some((w) => w.id === name), template: 'built-in', files: ['README.md', 'AGENTS.md'], github: { signedIn: true, account: 'owner' } };
  }
  #job(op, a, data = null) {
    this.#write(op, a);
    return { started: true, job: { ok: true, error: null, data, lines: [`${op} done`] } };
  }
  async projectNew(a) {
    return this.#job('projectNew', a, { name: a.name });
  }
  async projectGet(a) {
    return this.#job('projectGet', a);
  }
  async projectAdd(a) {
    return this.#job('projectAdd', a);
  }
  async projectSync(a) {
    return this.#job('projectSync', a, { repos: [{ rel: 'code/web', did: [{ kind: 'pulled', count: 2 }], todo: [] }, { rel: 'code/api', did: [], todo: [{ kind: 'changes', why: 'local changes are not committed', command: 'git status' }] }] });
  }
  async projectInstall(a) {
    return this.#job('projectInstall', a);
  }
  async workspace() {
    return clone(this.s.workspace);
  }
  async workspaceSetup(a) {
    if (!a.dryRun) this.#write('workspaceSetup', a);
    return { dryRun: !!a.dryRun, did: this.s.workspace.folders.filter((f) => !f.exists).map((f) => ({ path: `~/Workspace/${f.rel}`, what: 'folder' })), left: [] };
  }
  // ---- the workspace map, git, restore, sync ----
  async workspaceMap() {
    return clone(this.s.workspaceMap);
  }
  async workspaceMapWrite(a) {
    if (!a.dryRun) this.#write('workspaceMapWrite', a);
    return { diff: { added: ['tools/notes'], removed: [], changed: [] }, notHere: ['blog'], notes: clone(this.s.mapNotes) };
  }
  async workspaceGit() {
    return clone(this.s.git);
  }
  async workspaceRestore(a) {
    const plan = [
      { kind: 'brain', label: 'ai_brain', url: a.url, dest: '~/Workspace/ai_brain', action: 'clone' },
      { kind: 'project', label: 'shop', url: 'https://git.example.com/owner/shop.git', dest: '~/projects/shop', action: 'here' },
    ];
    if (a.dryRun) return { ok: true, dryRun: true, plan, notes: [] };
    this.#write('workspaceRestore', a);
    return { started: true, job: { ok: true, data: { plan }, lines: ['cloned ai_brain'] } };
  }
  async workspaceSync(a) {
    if (!a.dryRun) this.#write('workspaceSync', a);
    return { started: true, job: { ok: true, data: { repos: clone(this.s.syncRepos), memory: [], tools: [] }, lines: clone(this.s.syncLines) } };
  }
  async workspacePlaces(a) {
    this.#write('workspacePlaces', a);
    return { changed: ['projects'], notes: [] };
  }
  async workspaceForget(a) {
    this.#write('workspaceForget', a);
    return { forgotten: a.name, wasInMap: true };
  }
  async brainIndex() {
    return clone(this.s.brain);
  }
  async brainItem({ id }) {
    const it = this.s.brainItems[id];
    if (!it) throw Object.assign(new Error('no such item'), { status: 404 });
    return clone(it);
  }
  // ---- computer setup, add-ons ----
  async setupStatus() {
    return clone(this.s.setup);
  }
  async setupKits() {
    return { kits: clone(this.s.kits) };
  }
  async setupFix(a) {
    this.#write('setupFix', a);
    return { started: true };
  }
  async setUp(a) {
    this.#write('setUp', a);
    return { started: true };
  }
  async renameComputer(a) {
    this.#write('renameComputer', a);
    return { label: a.label };
  }
  async addons() {
    return { addons: clone(this.s.addons) };
  }
  async addon(a) {
    this.#write('addon', a);
    return { started: true };
  }
  async publicLink() {
    return clone(this.s.publicLink);
  }
  async setPublicLink(a) {
    this.#write('setPublicLink', a);
    if (a.on && this.s.publicLink.refuse) return { ok: false, need: this.s.publicLink.refuse, error: 'Some text from that computer' };
    Object.assign(this.s.publicLink, { on: a.on, kind: a.kind || this.s.publicLink.kind, state: a.on ? 'starting' : 'off' });
    return { ok: true, ...clone(this.s.publicLink) };
  }
  // ---- automations ----
  async automation() {
    return clone(this.s.automation);
  }
  async automationSettings(a) {
    this.#write('automationSettings', a);
    if (a.patch.paused !== undefined) this.s.automation.settings.paused = a.patch.paused;
    return {};
  }
  async schedules(a) {
    this.#write('schedules', a);
    if (a.body.op === 'add') this.s.automation.schedules.push({ ...a.body.schedule, id: 'new12345' });
    if (a.body.op === 'delete') this.s.automation.schedules = this.s.automation.schedules.filter((x) => x.id !== a.body.id);
    return { schedules: clone(this.s.automation.schedules) };
  }
  async queue(a) {
    this.#write('queue', a);
    return {};
  }
  // ---- skills ----
  async skillsInstalled({ project }) {
    return { user: clone(this.s.skills.user), project: project ? { skills: [] } : null, settings: clone(this.s.skills.settings) };
  }
  async skillsSuggested() {
    return { suggestions: [{ id: 'pdf-tools', name: 'pdf-tools', why: ['the project has PDFs'], installed: false, scope: 'project' }] };
  }
  async skillsFind({ query }) {
    return { query, catalog: [{ id: 'pdf-tools', name: 'pdf-tools', source: 'acme/skills/pdf', add: 'pdf-tools' }], online: [] };
  }
  async skillsCheck() {
    return { user: [], project: null };
  }
  async skillReview(a) {
    this.#read('skillReview', a);
    const r = this.s.reviews[a.spec];
    if (!r) throw Object.assign(new Error('no such skill'), { status: 404 });
    return clone(r);
  }
  async skillUpdateReview(a) {
    return { ...clone(this.s.reviews['pdf-tools']), id: 'r2', name: a.name, diff: { changed: ['SKILL.md'] } };
  }
  async skillApprove(a) {
    this.#write('skillApprove', a);
    return { ok: true };
  }
  async skillRemove(a) {
    this.#write('skillRemove', a);
    return { ok: true };
  }
  async projectsFolder(a) {
    this.#write('projectsFolder', a);
    return {};
  }
  async workingRules(a) {
    this.#write('workingRules', a);
    return {};
  }
  async skillsWeekly(a) {
    this.#write('skillsWeekly', a);
    return {};
  }
  async killProcess(a) {
    this.#write('killProcess', a);
    const st = this.s.status[a.computer];
    st.processes = st.processes.filter((p) => p.pid !== a.pid);
  }
  async changeSettings(a) {
    this.#write('changeSettings', a);
  }
  async runCommand(a) {
    this.#write('runCommand', a);
    return { code: 0, output: `ran: ${a.command}`, timedOut: false };
  }
  async addComputer(a) {
    this.#write('addComputer', a);
    const name = a.name || 'new-pc';
    this.s.computers.push({ name, label: a.sshTarget, online: true });
    return { name };
  }
  async removeComputer(a) {
    this.#write('removeComputer', a);
    this.s.computers = this.s.computers.filter((m) => m.name !== a.computer);
  }
  async power(a) {
    this.#write('power', a);
  }
}

/**
 * Host a core over HTTP like the real dashboard will: POST /api/assistant/call with Authorization: Bearer <token>
 * and X-Hoprig-Conversation. Owner-only routes (confirm, reject) are NOT reachable with the token.
 * Returns { url, token, core, ops, close() }.
 */
export async function startFakeDashboard({ ops = new FakeOps(), token = 'test-token-not-a-secret', skills, now } = {}) {
  const core = createAssistantCore({
    ops,
    jobs: new JobStore({ dir: null, ...(now ? { now } : {}) }),
    audit: new AuditLog({ file: null }),
    cards: new CardStore(now ? { now } : {}),
    skills: skills || new Skills({ dirs: [{ dir: '/nonexistent-owner-skills', source: 'owner' }, { dir: new URL('../../skills', import.meta.url).pathname, source: 'built-in' }] }),
    ...(now ? { now } : {}),
  });
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.method === 'POST' && req.url === '/api/assistant/call') {
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'log in first' });
      let b;
      try {
        b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'invalid JSON' });
      }
      const conv = String(req.headers['x-hoprig-conversation'] || 'direct');
      const r = await core.call(b.tool, b.args, { conversation: conv, actor: 'assistant' });
      return send(200, { text: r.text, isError: r.isError });
    }
    return send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    core,
    ops,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
