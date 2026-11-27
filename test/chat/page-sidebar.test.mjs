// The App's session list at the left (web/chat/sidebar.js), without a browser: its groups, its order, what needs the
// owner, the session open now, and the width it shows from.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
const S = await import('../../web/chat/sidebar.js');

const machines = [
  { machine: null, machineLabel: 'Workstation', status: 'online', sessions: [
    { name: 'chat:a', kind: 'chat', chatId: 'a', display: 'Fix the cart', cwd: '/w/shop', short: '~/w/shop', status: 'waiting', statusAt: 100 },
    { name: 'shop', kind: 'claude', cwd: '/w/shop', short: '~/w/shop', status: 'attention', statusAt: 50 },
    { name: 'api', kind: 'claude', cwd: '/w/api', short: '~/w/api', status: 'working', statusAt: 300 },
  ] },
  { machine: 'laptop', machineLabel: 'Laptop', status: 'online', sessions: [
    { name: 'chat:b', kind: 'chat', chatId: 'b', display: 'Blog post', cwd: '/w/shop', short: '~/w/shop', status: 'waiting', statusAt: 200, limit: { text: 'limit' } },
  ] },
  { machine: 'old', machineLabel: 'Old box', status: 'offline', sessions: [{ name: 'gone', kind: 'claude', cwd: '/w/x', status: 'waiting' }] },
];

test('the list groups the sessions of every computer by folder, a folder per computer, the newest group first', () => {
  const g = S.sideGroups(machines, { multi: true });
  assert.deepEqual(g.map((x) => [x.label, x.sub, x.sessions.map((s) => s.name)]), [
    ['api', 'Workstation', ['api']],
    ['shop', 'Laptop', ['chat:b']],
    ['shop', 'Workstation', ['chat:a', 'shop']],
  ], 'the same folder on two computers is two groups; a computer that cannot be reached adds nothing');
  assert.equal(g[2].title, '~/w/shop', 'the heading names the folder\'s path on hover');
  assert.deepEqual(g.map((x) => x.needs), [0, 1, 1], 'a limit and an OK that waits both need the owner');
  assert.equal(S.sideGroups(machines, { multi: false })[0].sub, '', 'one computer: no computer name on the heading');
});

test('a chat on a branch of its own is listed under its project, with its branch said, not as a project of its own', async () => {
  const wt = '/w/shop/.claude/worktrees/chat-a1b2c3';
  const m = [{ machine: null, machineLabel: 'Workstation', status: 'online', sessions: [
    { name: 'chat:a', kind: 'chat', chatId: 'a', display: 'Fix the cart', cwd: '/w/shop', short: '~/w/shop', status: 'waiting', statusAt: 100 },
    { name: 'chat:w', kind: 'chat', chatId: 'w', display: 'Try a thing', cwd: wt, short: `~/w/shop/.claude/worktrees/chat-a1b2c3`, status: 'waiting', statusAt: 200 },
  ] }];
  const g = S.sideGroups(m);
  assert.deepEqual(g.map((x) => [x.label, x.title, x.sessions.map((s) => s.name)]), [['shop', '~/w/shop', ['chat:w', 'chat:a']]]);
  assert.equal(S.branchOf(m[0].sessions[1]), 'worktree-chat-a1b2c3');
  assert.equal(S.branchOf(m[0].sessions[0]), null);
  // Home's card names the project and the branch in its folder line.
  const { folderLine, folderWorthShowing } = await import('../../web/sessionitem.js');
  assert.equal(folderLine(m[0].sessions[1]), '~/w/shop · worktree-chat-a1b2c3');
  assert.equal(folderWorthShowing(m[0].sessions[1]), true);
  assert.equal(folderLine(m[0].sessions[0]), '~/w/shop');
});

test('Group by State and Computer, Sort by Name', () => {
  assert.deepEqual(S.sideGroups(machines, { group: 'state' }).map((x) => [x.label, x.sessions.map((s) => s.name)]), [
    ['Needs you', ['chat:b', 'shop']], ['Working', ['api']], ['Ready', ['chat:a']],
  ], 'Home\'s order: what needs the owner first');
  assert.deepEqual(S.sideGroups(machines, { group: 'computer' }).map((x) => x.label), ['Workstation', 'Laptop']);
  const byName = S.sideGroups(machines, { sort: 'name', multi: true });
  assert.deepEqual(byName.map((x) => `${x.label} ${x.sub}`), ['api Workstation', 'shop Laptop', 'shop Workstation']);
  assert.deepEqual(byName[2].sessions.map((s) => S.nameOf(s)), ['Fix the cart', 'shop'], 'sessions by their names too');
});

test('the session open now is the App session of this id on this computer only', () => {
  const [a] = machines[0].sessions;
  assert.equal(S.isCurrent({ ...a, machine: null }, { chat: 'a', machine: null }), true);
  assert.equal(S.isCurrent({ ...a, machine: 'laptop' }, { chat: 'a', machine: null }), false, 'the same id on another computer is another session');
  assert.equal(S.isCurrent({ ...machines[0].sessions[1], machine: null }, { chat: 'a', machine: null }), false, 'a terminal is never the App session');
});

test('the next and the previous session go in the list\'s order as drawn, round at the ends', () => {
  const g = S.sideGroups(machines, { multi: true }); // api, chat:b, chat:a, shop
  const here = { chat: 'a', machine: null };
  assert.equal(S.sessionAfter(g, here, 1).name, 'shop');
  assert.equal(S.sessionAfter(g, here, -1).name, 'chat:b');
  assert.equal(S.sessionAfter(g, { chat: 'b', machine: 'laptop' }, -1).name, 'api');
  assert.equal(S.sessionAfter(g, { chat: 'x' }, 1).name, 'api', 'the open one not in the list: the first');
  assert.equal(S.sessionAfter([{ sessions: [machines[0].sessions[0]] }], here, 1), null, 'one session: nowhere to go');
  const ring = [{ sessions: [{ ...machines[0].sessions[0], machine: null }, { name: 'z', kind: 'claude' }] }];
  assert.equal(S.sessionAfter(ring, here, 1).name, 'z');
  assert.equal(S.sessionAfter([{ sessions: [ring[0].sessions[1], ring[0].sessions[0]] }], here, 1).name, 'z', 'the last row goes on to the first');
});

test('the list draws its groups, marks what needs the owner and the session open now, and links every row', () => {
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, x) => kept.set(k, String(x)) };
  globalThis.location = { hash: '' };
  let fn = null;
  const store = { all: machines.map((m) => ({ ...m, sessions: m.sessions.map((s) => ({ ...s, machine: m.machine, machineLabel: m.machineLabel })) })), multi: true, subscribe: (f) => ((fn = f), f(), () => (fn = null)) };
  let made = 0;
  const side = S.createSidebar({ store, current: { chat: 'a', machine: null }, newSession: () => made++ });
  const all = [];
  const walk = (n) => {
    all.push(n);
    for (const c of n.children || []) walk(c);
  };
  walk(side.el);
  const rows = all.filter((n) => String(n.className).includes('chat-side-row'));
  assert.equal(rows.length, 4);
  const cur = rows.filter((r) => r.attrs['aria-current'] === 'page');
  assert.equal(cur.length, 1, 'one row is the session open now');
  assert.match(cur[0].className, /\bcurrent\b/);
  assert.equal(rows.filter((r) => /\bneeds\b/.test(r.className)).length, 2, 'the OK that waits and the limit are marked');
  assert.ok(rows.every((r) => String(r.attrs.href || '').startsWith('#/')), 'each row is a link to its session');
  assert.ok(rows.some((r) => r.attrs.href === '#/m/laptop/chat/b'), 'a session of another computer opens there');
  const newBtn = all.find((n) => String(n.className).includes('chat-side-new'));
  newBtn.listeners.click();
  assert.equal(made, 1, '"+ New" opens a new session');
  side.stop();
  assert.equal(fn, null, 'it stops following the store when the page goes');
  delete globalThis.localStorage;
});

test('the list shows from the width the script names, and only there the head\'s Back hides', () => {
  const css = fs.readFileSync(new URL('../../web/chat/sidebar.css', import.meta.url), 'utf8');
  assert.equal(S.SIDE_MIN_PX, 900);
  const wide = css.split('@media (min-width: 900px)')[1];
  assert.ok(wide, 'a rule for the width the script names');
  assert.match(css.split('@media (min-width: 900px)')[0], /\.chat-side \{ display: none; \}/, 'narrower: no list');
  assert.match(wide, /\.chat-wrap\.chat-has-side \.chatback \{ display: none; \}/, 'the Back hides only beside the list');
  const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="chat\/sidebar\.css"/, 'the page loads the list\'s sheet');
  const page = fs.readFileSync(new URL('../../web/chat/page.js', import.meta.url), 'utf8');
  assert.match(page, /const side = BARE \? null : createSidebar\(/, 'not inside a window of the desktop');
});

test('a long computer name gives way in a folder group\'s heading: the folder name stays, both are whole in its title', () => {
  const css = fs.readFileSync(new URL('../../web/chat/sidebar.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-side-gsub \{ flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(css, /\.chat-side-glabel \{ flex: 0 1 auto; min-width: 3em;/);
  const src = fs.readFileSync(new URL('../../web/chat/sidebar.js', import.meta.url), 'utf8');
  assert.match(src, /title: `\$\{g\.title \|\| g\.label\}\$\{g\.sub \? ` · \$\{g\.sub\}` : ''\}`/);
});

test('the keyboard: the list is one tab stop (the open session), the arrow keys move inside it; each row says its state in words', () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.location = { hash: '' };
  const store = { all: machines.map((m) => ({ ...m, sessions: m.sessions.map((s) => ({ ...s, machine: m.machine, machineLabel: m.machineLabel })) })), multi: true, subscribe: (f) => (f(), () => {}) };
  const side = S.createSidebar({ store, current: { chat: 'a', machine: null }, newSession() {} });
  document.body.append(side.el); // on the page: it can have the focus
  const list = side.el.querySelector('.chat-side-list');
  const rows = list.querySelectorAll('.chat-side-row');
  assert.ok(rows.length >= 3);
  assert.deepEqual(rows.filter((r) => r.getAttribute('tabindex') === '0').map((r) => r.classList.contains('current')), [true], 'one tab stop: the session open now');
  assert.equal(rows.filter((r) => r.getAttribute('tabindex') === '-1').length, rows.length - 1);
  const at = rows.findIndex((r) => r.classList.contains('current'));
  let prevented = false;
  list.listeners.keydown({ key: 'ArrowDown', target: rows[at], preventDefault: () => (prevented = true) });
  assert.ok(prevented);
  assert.equal(document.activeElement, rows[at + 1]);
  assert.equal(rows[at + 1].getAttribute('tabindex'), '0', 'the tab stop moves with it');
  list.listeners.keydown({ key: 'Home', target: rows[at + 1], preventDefault() {} });
  assert.equal(document.activeElement, rows[0]);
  const said = rows.map((r) => r.querySelector('.chat-sr')).map((x) => x && x.children.map((c) => c.text).join(''));
  assert.ok(said.every((t) => t && t.startsWith(', ')), 'each row\'s state in words, not only in its dot and title');
  side.stop();
  side.el.remove();
});

test('Archived and a row\'s own menu: the list\'s menu has Archived; a row has Open in new window, and Archive for an App session here', () => {
  const src = fs.readFileSync(new URL('../../web/chat/sidebar.js', import.meta.url), 'utf8');
  assert.match(src, /\{ label: 'Archived', icon: 'archive', run: \(\) => archivedSheet\(\) \},\n\s*\{ label: 'Select to delete'.*\n\s*\{ label: 'Trash'.*\n\s*\{ label: 'View all'/, 'View all stays the last row');
  assert.match(src, /list = \(await api\('\/api\/chats\/archived'\)\)\.list/);
  assert.match(src, /await api\('\/api\/chats', \{ dir: x\.cwd, tool: x\.tool, profile: x\.profile, sessionId: x\.conversationId \}\)/, 'continued in a new session');
  assert.match(src, /oncontextmenu: \(e\) => rowMenu\(e, s\)/);
  assert.match(src, /label: 'Open in new window'/);
  assert.match(src, /if \(s\.kind === 'chat' && \(s\.machine \?\? null\) === null\) \{\n\s*items\.push\(\{ label: 'Archive', icon: 'archive', run: \(\) => archiveSession\(/, 'one archive function for the row menu and the session menu');
  assert.doesNotMatch(src.slice(src.indexOf("label: 'Archive', icon: 'archive', run: () => archiveSession")).split('\n')[0], /confirmSheet/, 'no question first');
});

test('Archive asks nothing, shows Archived with Undo, and asks only for a working session', async () => {
  const st = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms) => st(f, ms).unref();
  globalThis.location = { hash: '', href: 'http://x/' };
  const calls = [];
  const restore = { dir: '/w/shop', tool: 'claude', profile: 'sub', sessionId: 'conv-1' };
  globalThis.fetch = async (u, init) => {
    calls.push([String(u).replace(/^https?:\/\/[^/]+/, ''), init && init.body]);
    return { ok: true, status: 200, json: async () => (String(u).endsWith('/close') ? { ok: true, restore } : { id: 'a' }) };
  };
  let refreshed = 0;
  let gone = 0;
  const before = document.body.children.length;
  assert.equal(await S.archiveSession({ chatId: 'a', refresh: () => refreshed++, gone: () => gone++ }), true);
  assert.deepEqual(calls.map((c) => c[0]), ['/api/chats/a/close'], 'closed at once, no sheet in between');
  assert.deepEqual([refreshed, gone], [1, 1]);
  const toastBox = document.body.children.slice(before).flatMap((n) => n.children || []);
  const t = toastBox.at(-1);
  assert.match(texts(t).join(''), /ArchivedUndo/);
  const undo = byClass(t, 'toast-action')[0];
  undo.listeners.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.at(-1), ['/api/chats', JSON.stringify(restore)], 'Undo opens the same conversation again');
  assert.equal(refreshed, 2);
  globalThis.setTimeout = st;
});

test('the session menu\'s Archive is the list\'s archiveSession; a branch of its own with nothing uncommitted is archived at once', async () => {
  const page = fs.readFileSync(new URL('../../web/chat/page.js', import.meta.url), 'utf8');
  assert.match(page, /async close\(\) \{\n\s*await archiveSession\(\{/, 'one archive function for the menu and the list');
  assert.doesNotMatch(page.slice(page.indexOf('async close()'), page.indexOf('async remove()')), /confirmSheet/);
  const st = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms) => st(f, ms).unref();
  globalThis.location = { hash: '', href: 'http://x/' };
  const calls = [];
  globalThis.fetch = async (u) => {
    calls.push(String(u).replace(/^https?:\/\/[^/]+/, ''));
    return { ok: true, status: 200, json: async () => (String(u).endsWith('/changes') ? { git: true, files: 0 } : { ok: true, restore: null }) };
  };
  assert.equal(await S.archiveSession({ chatId: 'w', cwd: '/w/shop/.claude/worktrees/chat-ab12cd', gone() {} }), true);
  assert.deepEqual(calls, ['/api/chats/w/changes', '/api/chats/w/close'], 'its changes are looked at first, nothing to ask');
  calls.length = 0;
  await S.archiveSession({ chatId: 'p', cwd: '/w/shop' });
  assert.deepEqual(calls, ['/api/chats/p/close'], 'a plain folder is not looked at');
  globalThis.setTimeout = st;
});

test('a row says the name on a line of its own, and under it the state in words and the time', () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const mk = (extra) => ({ all: [{ machine: null, machineLabel: 'W', status: 'online', sessions: [{ name: 'chat:a', kind: 'chat', chatId: 'a', display: 'A very long name of a session that goes on', cwd: '/w/shop', short: '~/w/shop', status: 'working', background: true, statusAt: Date.now() - 60000, ...extra }] }], multi: false, subscribe: (f) => (f(), () => {}) });
  const side = S.createSidebar({ store: mk({}), current: null, newSession() {} });
  const row = side.el.querySelector('.chat-side-row');
  const text = row.querySelector('.chat-side-text');
  assert.deepEqual(text.children.map((c) => c.className), ['chat-side-name', 'chat-side-meta'], 'the name, then the line under it');
  assert.equal(texts(text.children[0]).join(''), 'A very long name of a session that goes on', 'the name whole in the page (the style cuts it with ...)');
  assert.match(texts(text.children[1]).join(''), /^Working in the background · /);
  const needs = S.createSidebar({ store: mk({ status: 'attention' }), current: null, newSession() {} }).el.querySelector('.chat-side-row');
  assert.ok(needs.querySelector('.chat-side-mark'), 'what needs him has its mark at the right');
  assert.equal(row.querySelector('.chat-side-mark'), null);
  side.stop();
});

test('narrower than 900: the list opens over the chat, closes by a tap outside or Escape', () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const events = [];
  const keys = [];
  const prev = document.addEventListener;
  const prevOff = document.removeEventListener;
  document.addEventListener = (k, f) => keys.push([k, f]);
  document.removeEventListener = () => {};
  const store = { all: [], multi: false, subscribe: (f) => (f(), () => {}) };
  const side = S.createSidebar({ store, current: null, newSession() {}, onOverlay: (on) => events.push(on) });
  const wrap = document.createElement('div');
  wrap.append(side.el);
  const classes = new Set();
  wrap.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
  assert.equal(side.overlay(), true);
  assert.ok(classes.has('chat-side-over'));
  const scrim = wrap.children.find((c) => c.className === 'chat-side-scrim');
  assert.ok(scrim, 'a scrim behind it');
  scrim.listeners.click();
  assert.ok(!classes.has('chat-side-over'), 'a tap outside closes it');
  side.overlay();
  keys.at(-1)[1]({ key: 'Escape' });
  assert.ok(!classes.has('chat-side-over'), 'Escape closes it');
  assert.deepEqual(events, [true, false, true, false]);
  document.addEventListener = prev;
  document.removeEventListener = prevOff;
  const css = fs.readFileSync(new URL('../../web/chat/sidebar.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 899\.98px\)[^]*chat-side-over \.chat-side \{[^}]*position: fixed/);
});
