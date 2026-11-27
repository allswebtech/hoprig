// The chat page's session rail (web/chat/rail.js), without a browser: its rows, Hide and Show, the Changes card.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

test('the rail\'s rows: the provider button sits in the value column, on the line of its label', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/chat/rail.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-rail-rows\s*\{[^}]*align-items:\s*baseline/, 'values on the line of their labels');
  // .btn.small (style.css) sets a 30 px height and 11 px of padding: the rail's link must win over it.
  const rule = [...css.matchAll(/([^{}]*\.chat-rail-link[^{}]*)\{([^}]*)\}/g)].find((m) => /padding/.test(m[2]));
  assert.ok(rule, 'a rule sets the link\'s padding');
  assert.match(rule[1], /\.btn\.small\.chat-rail-link/, 'as specific as .btn.small, and later in the page');
});

test('the session rail: where the session runs, its cost only in Verbose on a billed provider; hidden and shown, remembered', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, x) => kept.set(k, String(x)) };
  const R = await import('../../web/chat/rail.js');
  const v = { cwd: '/w/shop', short: '~/w/shop', branch: 'main', profile: { name: 'gw', label: 'Gateway', kind: 'api' }, engine: { id: 'claude' }, costTotal: 0.42, limits: { five_hour: { percent: 40 } } };
  assert.deepEqual(R.environmentRows(v, { computer: 'Laptop' }), [['Computer', 'Laptop'], ['Folder', '~/w/shop'], ['Provider', 'Gateway'], ['Branch', 'main']]);
  assert.deepEqual(R.environmentRows(v, { view: 'verbose' }).at(-1), ['Cost so far', '$0.42'], 'Verbose, billed by use');
  const sub = { ...v, profile: { name: 'max', label: 'Max', kind: 'subscription' } };
  assert.deepEqual(R.environmentRows(sub, { view: 'verbose' }).slice(-2), [['Branch', 'main'], ['Plan usage', '5 h 40%']], 'a subscription: its plan usage, never dollars');
  assert.deepEqual(R.environmentRows({ ...v, engine: { id: 'opencode', label: 'OpenCode' } }).map((x) => x[0]), ['Computer', 'Folder', 'Coding tool', 'Provider', 'Branch'], 'another coding tool is named');
  // Hide / Show: remembered in this browser; the page is told (its class, the head's words).
  const told = [];
  const rail = R.createRail({ A: '/x', view: () => 'normal', computer: () => 'This computer', onToggle: (off) => told.push(off) });
  assert.equal(rail.hidden(), false);
  rail.toggle();
  assert.deepEqual([rail.hidden(), kept.get('chat.rail'), told], [true, 'off', [true]]);
  assert.equal(R.railHidden(), true, 'a new page opens with it hidden');
  rail.toggle();
  assert.equal(R.railHidden(), false);
  // Beside the rail the dock does not say again what the rail says: the context, the plan usage, the cost.
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/chat/rail.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(min-width: 1100px\)/);
  assert.equal(R.RAIL_MIN_PX, 1100, 'the script and the sheet agree on the width');
  for (const k of ['Context', 'Plan limits', 'Cost so far']) assert.ok(css.includes(`[data-k='${k}']`), k);
  assert.doesNotMatch(css, /chat-bg|chat-strip/, 'the Background tasks part above the box shows beside the rail too');
  delete globalThis.localStorage;
});

test('the rail on an older computer: no route for the changes, no card, and it is not asked again', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const mm = globalThis.matchMedia;
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
  globalThis.fetch = async (u) => (fetched.push(String(u)), { status: 404, ok: false, json: async () => ({ error: 'not found' }) });
  try {
    const R = await import('../../web/chat/rail.js');
    const rail = R.createRail({ A: '/m/old/api/chats/x', view: () => 'normal', computer: () => 'Old box' });
    const v = { cwd: '/w/a', status: 'waiting', engine: { id: 'claude', capabilities: {} }, usage: {} };
    rail.paint(v);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetched.length, 1);
    const cards = byClass(rail.el, 'chat-rcard');
    const changes = cards.find((c) => texts(c).join('').startsWith('Changes'));
    assert.ok(changes.className.includes('hidden'), 'the Changes card stays out');
    assert.ok(cards.find((c) => /Context/.test(texts(c).join(''))).className.includes('hidden'), 'no context known: no empty Context card');
    rail.changed();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetched.length, 1, 'not asked again');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.matchMedia = mm;
  }
});

test('the rail\'s Changes card: asked again after each tool and turn, one question at a time; only new files read no "+0 −0"', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const mm = globalThis.matchMedia;
  const realFetch = globalThis.fetch;
  const asked = [];
  let answer = null;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
  // Each question waits until the test answers it: two news while one is asked make one more question, not two.
  globalThis.fetch = (u) => new Promise((res) => {
    if (String(u).endsWith('/pr')) return res({ status: 404, ok: false, json: async () => ({ error: 'not found' }) }); // the pull request is another test's
    asked.push(String(u));
    answer = () => res({ status: 200, ok: true, json: async () => ({ git: true, files: 1, added: 0, removed: 0, untracked: 1, list: [{ path: '/w/a/notes.md', new: true, added: 0, removed: 0 }] }) });
  });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  try {
    const R = await import('../../web/chat/rail.js');
    let opened = 0;
    const rail = R.createRail({ A: '/api/chats/x', view: () => 'normal', computer: () => 'This one', changes: () => opened++ });
    rail.paint({ cwd: '/w/a', status: 'working', engine: { id: 'claude', capabilities: {} }, usage: {} });
    await tick();
    assert.equal(asked.length, 1, 'asked when the session opens, also while it works');
    rail.changed();
    rail.changed();
    await tick();
    assert.equal(asked.length, 1, 'not while the first question is out');
    answer();
    await tick();
    assert.equal(asked.length, 2, 'the news while it was out: asked once more');
    answer();
    await tick();
    assert.equal(asked.length, 2);
    const card = byClass(rail.el, 'chat-rcard').find((c) => texts(c).join('').startsWith('Changes'));
    const words = texts(card).join(' ');
    assert.match(words, /1 file changed \(1 new\)/);
    assert.doesNotMatch(words, /\+0/, 'a new file has no line count to say');
    assert.equal(byClass(card, 'chat-rcard-count').length, 0, 'no count, nothing to click');
    // With lines changed, the count is the desktop app's: a click on it opens the changes.
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ git: true, files: 1, added: 12, removed: 1, untracked: 0, list: [{ path: '/w/a/src/x.js', added: 12, removed: 1 }] }) });
    rail.changed();
    await tick();
    const count = byClass(card, 'chat-rcard-count')[0];
    assert.match(texts(count).join(''), /^\+12 −1$/);
    assert.equal(count.attrs['aria-label'], '12 lines added, 1 removed: open the changes');
    count.listeners.click();
    assert.equal(opened, 1);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.matchMedia = mm;
  }
});
test('the rail\'s Context card, once opened, asks again after a turn: its percent and its "N of M tokens" say one size', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const mm = globalThis.matchMedia;
  const realFetch = globalThis.fetch;
  const asked = [];
  let usage = { contextUsed: 21000, contextWindow: 200000, contextPercent: 10.5, contextCategories: [{ name: 'Messages', tokens: 6000 }] };
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (u) => {
    asked.push(String(u));
    return String(u).endsWith('/usage') ? { status: 200, ok: true, json: async () => ({ usage }) } : { status: 200, ok: true, json: async () => ({ git: false }) };
  };
  const tick = () => new Promise((r) => setTimeout(r, 10));
  try {
    const R = await import('../../web/chat/rail.js');
    const rail = R.createRail({ A: '/api/chats/x', view: () => 'normal', computer: () => 'This one' });
    const v = { cwd: '/w/a', running: true, status: 'waiting', engine: { id: 'claude', capabilities: { usage: true } }, usage: { contextUsed: 2000, contextWindow: 200000 } };
    rail.paint(v);
    const card = byClass(rail.el, 'chat-rcard-fold')[0];
    card.open = true;
    card.listeners.toggle();
    await tick();
    assert.match(texts(card).join(' '), /11%.*21k of 200k tokens/);
    // A turn: the server's state has the new size without /context's percent (hear.mjs), and the card asks again.
    usage = { contextUsed: 2100, contextWindow: 200000, contextPercent: 1.05, contextCategories: [{ name: 'Messages', tokens: 900 }] };
    rail.paint({ ...v, usage: { contextUsed: 2100, contextWindow: 200000 } });
    const before = asked.filter((u) => u.endsWith('/usage')).length;
    rail.turnEnded();
    await tick();
    assert.equal(asked.filter((u) => u.endsWith('/usage')).length, before + 1, 'asked again while open');
    const said = texts(card).join(' ');
    assert.match(said, /Context 1%.*2\.1k of 200k tokens/);
    assert.doesNotMatch(said, /6\.0k|11%/, 'nothing of the older answer');
    // Folded, a turn asks nothing more of the coding tool.
    card.open = false;
    rail.turnEnded();
    await tick();
    assert.equal(asked.filter((u) => u.endsWith('/usage')).length, before + 1);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.matchMedia = mm;
  }
});

test('a rail stops listening to the window\'s width when its page goes: no git runs for a session nobody looks at', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const mm = globalThis.matchMedia;
  const realFetch = globalThis.fetch;
  const asked = [];
  const listeners = new Set();
  globalThis.matchMedia = () => ({ matches: true, addEventListener: (k, fn) => listeners.add(fn), removeEventListener: (k, fn) => listeners.delete(fn) });
  globalThis.fetch = async (u) => (asked.push(String(u)), { status: 200, ok: true, json: async () => ({ git: false }) });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const widen = () => [...listeners].forEach((fn) => fn({ matches: true }));
  try {
    const R = await import('../../web/chat/rail.js');
    const rail = R.createRail({ A: '/api/chats/x', view: () => 'normal', computer: () => 'This one' });
    rail.paint({ cwd: '/w/a', status: 'waiting', engine: { id: 'claude', capabilities: {} }, usage: {} });
    await tick();
    assert.equal(asked.length, 1);
    assert.equal(listeners.size, 1, 'one listener while the page is open');
    widen();
    await tick();
    assert.equal(asked.length, 2, 'grown wide enough: drawn and asked now');
    rail.stop();
    assert.equal(listeners.size, 0, 'the page went: the listener goes with it');
    widen();
    rail.changed();
    await tick();
    assert.equal(asked.length, 2, 'nothing is asked for a page that has gone');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.matchMedia = mm;
  }
});

test('the rail tells an older computer (no route: "not found") from a session that is not open for a moment', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const mm = globalThis.matchMedia;
  const realFetch = globalThis.fetch;
  const asked = [];
  let body = { error: 'this chat is not open (it was archived or opened in a terminal)' };
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (u) => (asked.push(String(u)), { status: 404, ok: false, json: async () => body });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  try {
    const R = await import('../../web/chat/rail.js');
    const rail = R.createRail({ A: '/api/chats/x', view: () => 'normal', computer: () => 'This one' });
    rail.paint({ cwd: '/w/a', status: 'waiting', engine: { id: 'claude', capabilities: {} }, usage: {} });
    await tick();
    rail.changed();
    await tick();
    assert.equal(asked.length, 2, 'a session not open for a moment: hidden for now, asked at the next news');
    body = { error: 'not found' };
    rail.changed();
    await tick();
    rail.changed();
    await tick();
    assert.equal(asked.length, 3, 'no route: an older computer, not asked again');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.matchMedia = mm;
  }
});

test('the Changes card asks again after a rewind or a reconnect (the events), and when the tab comes back, at most every few seconds', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const R = await import('../../web/chat/rail.js');
  // The page's events → what the rail is told: a rewind of files says so by a notice; a reconnect starts over.
  const ev = (...kinds) => ({ events: kinds.map((kind) => ({ kind })) });
  assert.equal(R.folderNews(ev('text')), null);
  assert.equal(R.folderNews(ev('tool-result')), 'changed');
  assert.equal(R.folderNews(ev('notice')), 'changed', 'Files rewound to before your message');
  assert.equal(R.folderNews(ev('tool-result', 'turn-end')), 'turn');
  assert.equal(R.folderNews({ reset: true, events: [] }), 'changed', 'a dashboard restart or a reconnect');

  const mm = globalThis.matchMedia;
  const realFetch = globalThis.fetch;
  const realDoc = globalThis.document;
  const realWin = globalThis.window;
  const asked = [];
  const on = new Map();
  const sub = (o) => ({ ...o, addEventListener: (k, fn) => on.set(k, fn), removeEventListener: (k, fn) => on.get(k) === fn && on.delete(k) });
  globalThis.document = sub(realDoc);
  globalThis.window = sub(realWin);
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (u) => (asked.push(String(u)), { status: 200, ok: true, json: async () => ({ git: false }) });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  try {
    let now = 100_000;
    const rail = R.createRail({ A: '/api/chats/x', view: () => 'normal', computer: () => 'This one', clock: () => now });
    rail.changed();
    await tick();
    assert.equal(asked.length, 0, 'before the first state nothing is asked (its paint asks)');
    rail.paint({ cwd: '/w/a', status: 'waiting', engine: { id: 'claude', capabilities: {} }, usage: {} });
    await tick();
    assert.equal(asked.length, 1);
    now += 10_000;
    on.get('visibilitychange')();
    await tick();
    assert.equal(asked.length, 2, 'the tab came back: an edit made outside a tool shows');
    on.get('focus')();
    await tick();
    assert.equal(asked.length, 2, 'not again within a few seconds');
    rail.stop();
    assert.ok(!on.has('visibilitychange') && !on.has('focus'), 'gone with the page');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.matchMedia = mm;
    globalThis.document = realDoc;
    globalThis.window = realWin;
  }
});

test('the branch name in the rail and in the status line is a button that copies it, as the desktop app\'s', async () => {
  const copied = [];
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => copied.push(t) } }, configurable: true });
  const mm = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ git: false }) });
  try {
    const R = await import('../../web/chat/rail.js');
    const rail = R.createRail({ A: '/api/chats/x', view: () => 'normal', computer: () => 'This one' });
    rail.paint({ cwd: '/w/a', branch: 'fix/cart-total', status: 'waiting', engine: { id: 'claude', capabilities: {} }, usage: {} });
    const btn = byClass(rail.el, 'chat-branch')[0];
    assert.ok(btn, 'the Branch row\'s value is a button');
    assert.equal(btn.attrs['aria-label'], 'Copy branch name fix/cart-total');
    await btn.listeners.click();
    const St = await import('../../web/chat/statusline.js');
    const line = St.createStatusLine();
    line.paint({ branch: 'main', engine: { id: 'claude' }, status: 'waiting' }, { view: 'normal' });
    const part = byClass(line.el, 'chat-branch')[0];
    assert.ok(part, 'the status line\'s branch too');
    await part.listeners.click();
    line.stop();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(copied, ['fix/cart-total', 'main']);
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    else delete globalThis.navigator;
    globalThis.matchMedia = mm;
    globalThis.fetch = realFetch;
  }
});

test('a state update keeps the rail\'s controls (the Provider link, the cost row) where the keyboard is: redrawn only when they change', async () => {
  const mm = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ git: false }) });
  try {
    const R = await import('../../web/chat/rail.js');
    let view = 'normal';
    const rail = R.createRail({ A: '/api/chats/x', view: () => view, computer: () => 'This one', stop() {}, canStop: () => true, jump() {}, providers() {} });
    const task = { taskId: 't1', type: 'shell', status: 'running', title: 'sleep 60', toolId: 'u1' };
    const v = { cwd: '/w/a', branch: 'main', profile: { name: 'auto', label: 'Auto' }, status: 'waiting', engine: { id: 'claude', capabilities: {} }, usage: {}, tasks: [task] };
    rail.paint(v);
    const link = () => byClass(rail.el, 'chat-rail-link').find((b) => texts(b).join('') === 'Auto');
    const l1 = link();
    assert.ok(l1);
    rail.paint({ ...v, status: 'working', usage: { contextUsed: 10 }, tasks: [{ ...task }] }); // a turn: news, nothing in these rows changed
    assert.equal(link(), l1, 'the same Provider button: its focus stays');
    // Never taken out of the page either (the browser moves the focus off a control taken out and put back).
    const out = (n) => n.taken || 0;
    const lt = out(l1);
    const kept = (why) => {
      assert.equal(link(), l1, `${why}: the same Provider button`);
      assert.equal(out(l1), lt, `${why}: the Provider button stayed in the page`);
    };
    // Verbose on a provider billed by use: the cost rises after a turn, a row of its own appears and changes.
    const billedV = { ...v, profile: { name: 'api', label: 'Auto', kind: 'api' }, costTotal: 0.1 };
    view = 'verbose';
    rail.paint(billedV);
    const said = () => texts(rail.el).join('|');
    assert.match(said(), /Cost so far\|\$0\.10/);
    kept('the Cost row appears');
    rail.paint({ ...billedV, costTotal: 0.25 });
    assert.match(said(), /Cost so far\|\$0\.25/);
    kept('the cost rises');
    rail.paint({ ...v, profile: { name: 'gw', label: 'Gateway' }, tasks: [] });
    assert.equal(link(), undefined, 'another provider: "Auto" is gone');
    assert.ok(byClass(rail.el, 'chat-rail-link').some((b) => texts(b).join('') === 'Gateway'), '… and its name is said');
    assert.equal(byClass(rail.el, 'chat-rail-task').length + byClass(rail.el, 'chat-taskstop').length, 0, 'the rail has no background tasks: they are above the box');
  } finally {
    globalThis.matchMedia = mm;
    globalThis.fetch = realFetch;
  }
});

test('the rail holds no Background tasks card and no long provider text: both moved (the tasks above the box, the words into a tooltip)', async () => {
  const mm = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ git: false }) });
  try {
    const R = await import('../../web/chat/rail.js');
    const rail = R.createRail({ A: '/api/chats/x', view: () => 'normal', computer: () => 'This one', providers() {} });
    const tasks = Array.from({ length: 6 }, (_, i) => ({ taskId: `t${i}`, type: 'shell', status: 'running', title: `sleep ${i}`, toolId: `u${i}` }));
    rail.paint({ cwd: '/w/a', status: 'waiting', profile: { name: 'auto', label: 'Auto' }, engine: { id: 'claude', capabilities: {} }, usage: {}, tasks });
    const said = texts(rail.el).join('|');
    assert.doesNotMatch(said, /Background tasks|sleep 0|Stop/);
    assert.equal(byClass(rail.el, 'chat-rail-said').length, 0, 'the provider words are not a block under the row');
    const link = byClass(rail.el, 'chat-rail-link').find((b) => texts(b).join('') === 'Auto');
    assert.match(link.attrs.title, /The AI account this chat runs on/, 'they are the button\'s tooltip');
  } finally {
    globalThis.matchMedia = mm;
    globalThis.fetch = realFetch;
  }
});

test('with a finger the head\'s and the rail\'s controls are 44 px, at every width (a tablet shows the rail too)', async () => {
  const fs = await import('node:fs');
  // Every "@media (pointer: coarse) { … }" block of a sheet, together.
  const coarse = (file) => {
    const css = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const blocks = [];
    for (let at = css.indexOf('@media (pointer: coarse)'); at >= 0; at = css.indexOf('@media (pointer: coarse)', at + 1)) {
      let depth = 0;
      let i = css.indexOf('{', at);
      const start = i;
      for (; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) break;
      }
      blocks.push(css.slice(start, i));
    }
    assert.ok(blocks.length, `${file}: a rule for a finger`);
    return blocks.join('\n');
  };
  const head = coarse('../../web/chat/chat.css');
  for (const sel of ['.chat-caret', '.chat-tbtn', 'button.chat-st-part']) assert.match(head, new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*min-height:\\s*44px`), sel);
  assert.match(head, /\.chat-caret[^{]*\{[^}]*min-width:\s*44px/);
  const rail = coarse('../../web/chat/rail.css');
  for (const sel of ['.chat-rail-link', '.chat-rcard-count', '.chat-rcard-fold > summary']) assert.ok(rail.includes(sel), sel);
  assert.match(rail, /min-height:\s*44px/);
  assert.match(coarse('../../web/desktop/desktop.css'), /\.desk-menu-item[^{]*\{[^}]*min-height:\s*44px/, 'the session menu\'s entries');
});

// The pull request in the Changes card: Create PR, the PR line with its checks and its menu; asked after a turn and when the
// rail opens (not by a timer, not at each tool); no gh, no remote, no pull request: nothing extra.
async function prRail({ changes, pr, send }) {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const mm = globalThis.matchMedia;
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
  globalThis.fetch = async (u, init = {}) => {
    asked.push(`${init.method || 'GET'} ${String(u)}`);
    const data = String(u).endsWith('/changes') ? changes : String(u).endsWith('/pr') ? pr : {};
    return { status: 200, ok: true, json: async () => data };
  };
  const R = await import('../../web/chat/rail.js');
  const rail = R.createRail({ A: '/api/chats/x', view: () => 'normal', computer: () => 'This one', changes() {}, send });
  rail.paint({ cwd: '/w/a', status: 'waiting', engine: { id: 'claude', capabilities: {} }, usage: {} });
  await new Promise((r) => setTimeout(r, 30));
  const card = byClass(rail.el, 'chat-rcard').find((c) => texts(c).join('').startsWith('Changes'));
  return { R, rail, card, asked, done: () => { globalThis.fetch = realFetch; globalThis.matchMedia = mm; } };
}
const changed = { git: true, files: 1, added: 3, removed: 0, untracked: 0, list: [{ path: 'a.js', added: 3, removed: 0 }] };

test('Create PR: shown with a remote, gh and something to send; a press sends the fixed message', async () => {
  const sent = [];
  const t = await prRail({ changes: changed, pr: { remote: true, ahead: 0, gh: true, pr: null }, send: async (x) => sent.push(x) });
  try {
    const b = byClass(t.card, 'chat-rail-create')[0];
    assert.ok(b, 'Create PR is there');
    assert.equal(texts(b).join(''), 'Create PR');
    b.listeners.click({ currentTarget: b });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent, [t.R.CREATE_PR_MESSAGE]);
    assert.match(sent[0], /commit.*push.*pull request.*gh/i);
  } finally {
    t.done();
  }
});

test('Create PR is left out: no gh, no remote, a clean branch that is pushed, a pull request that exists', async () => {
  for (const pr of [{ remote: true, ahead: 0, gh: false, pr: null }, { remote: false, ahead: null, gh: false, pr: null }, { remote: true, ahead: 0, gh: true, pr: { number: 1, title: 't', url: null, checks: null } }]) {
    const t = await prRail({ changes: changed, pr, send() {} });
    try {
      assert.equal(byClass(t.card, 'chat-rail-create').length, 0, JSON.stringify(pr));
    } finally {
      t.done();
    }
  }
  const t = await prRail({ changes: { ...changed, files: 0, list: [] }, pr: { remote: true, ahead: 0, gh: true, pr: null }, send() {} });
  try {
    assert.equal(byClass(t.card, 'chat-rail-create').length, 0, 'nothing changed and nothing unpushed');
  } finally {
    t.done();
  }
  const u = await prRail({ changes: { ...changed, files: 0, list: [] }, pr: { remote: true, ahead: 2, gh: true, pr: null }, send() {} });
  try {
    assert.equal(byClass(u.card, 'chat-rail-create').length, 1, 'two commits not pushed');
  } finally {
    u.done();
  }
});

test('the PR line: #n title and its checks, named for a screen reader; asked after a turn, not at each tool', async () => {
  const t = await prRail({ changes: changed, pr: { remote: true, ahead: 0, gh: true, pr: { number: 12, title: 'Cart totals', url: 'https://example.com/pull/12', checks: 'failing' } }, send() {} });
  try {
    const line = byClass(t.card, 'chat-rail-prtitle')[0];
    assert.match(texts(line).join(''), /^#12 Cart totals/);
    assert.match(line.attrs['aria-label'], /Pull request #12 Cart totals, checks failing/);
    assert.equal(texts(byClass(t.card, 'chat-rail-checks')[0]).join(''), 'Checks failing');
    assert.ok(byClass(t.card, 'chat-pr-failing').length);
    const prs = () => t.asked.filter((x) => x.endsWith('/pr')).length;
    assert.equal(prs(), 1, 'asked when the rail opened');
    t.rail.changed();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(prs(), 1, 'a tool ran: not asked');
    t.rail.turnEnded();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(prs(), 2, 'a turn ended: asked');
  } finally {
    t.done();
  }
});
