// What a look at the phone found in Home and the shared parts (polish of 27 Nov): a card's
// last line as plain text, the card's shape, Home not jumping, no floating button over a row, no wrong way back, a
// gear of 44, one touch rule, the same order after a hand-over, an old address that finds its conversation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import './chat/fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
const { folderLast, lastLine, plainText, saidBy, whereNow, whereWord } = await import('../web/sessionitem.js');
const { cardOrder, firstTime, holdFirstDraw, ownNeedsOf } = await import('../web/home.js');
const { isTopPage } = await import('../web/shell.js');
const src = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), 'utf8');

test('a card\'s last line is plain text: no marks of formatting', () => {
  assert.equal(plainText('The branch is ready. **Live now:** `abc123` a [link](http://x.y/z) _fine_ __bold__'), 'The branch is ready. Live now: abc123 a link _fine_ bold');
  assert.equal(plainText('# Done\n- one\n- two\n> quoted'), 'Done one two quoted');
  assert.equal(plainText('cut at the end **Live…'), 'cut at the end Live…');
  assert.equal(plainText('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4');
  assert.equal(lastLine({ display: 't', kind: 'chat', lastMessage: '**Live now:** it works' }), 'Live now: it works');
  assert.equal(lastLine({ display: 'Same', kind: 'chat', lastMessage: '**Same**' }), null, 'never its title again');
});

test('the card says where it runs, and whose words the last line is', () => {
  assert.equal(whereWord({ kind: 'chat' }), 'App');
  assert.equal(whereWord({ kind: 'claude' }), 'Terminal');
  assert.equal(whereWord({ kind: 'shell' }), 'Terminal');
  assert.equal(whereWord({ kind: 'claude', where: 'app' }), 'App');
  assert.equal(saidBy({ kind: 'chat', lastBy: 'you' }), 'You');
  assert.equal(saidBy({ kind: 'chat', lastBy: 'claude' }), 'Claude');
  assert.equal(saidBy({ kind: 'chat', lastBy: 'claude', tool: 'codex' }), 'Codex');
  assert.equal(saidBy({ kind: 'chat' }), null, 'a computer that does not say: no name');
  assert.equal(folderLast({ short: '~/Workspace/projects/shop' }), 'shop');
  assert.equal(folderLast({ short: 'C:\\work\\shop' }), 'shop');
});

test('the card is one look: state in words at the title, one line under it, plain last words, a tight phone card', () => {
  const card = src('sessionitem.js');
  assert.match(card, /h\('div\.card-top', h\('h3\.card-name', nameOf\(s\)\), chip\(s\)\)/, 'the state in words beside the title');
  assert.doesNotMatch(card, /heading/, 'no pill that shows only the time');
  assert.match(card, /h\('div\.card-where'/);
  assert.doesNotMatch(card, /machinePill|chatTag/, 'no pills for the computer and the App');
  const css = src('page-home.css');
  assert.match(css, /\.card-where \{[^}]*flex-wrap: nowrap[^}]*white-space: nowrap/, 'the line never wraps');
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.home-groups article\.card \{ padding: 12px 14px; \}/);
  const style = src('style.css');
  assert.doesNotMatch(style.slice(style.indexOf('.card-msg {'), style.indexOf('.card-note {')), /background/, 'no grey box under the title');
});

test('Home waits for the first answer about what needs the owner, unless it failed', () => {
  assert.equal(holdFirstDraw({ asked: false }), true);
  assert.equal(holdFirstDraw({ asked: true }), false);
  assert.equal(holdFirstDraw({ asked: false, err: new Error('offline') }), false, 'an error is shown at once');
  const home = src('home.js');
  assert.match(home, /holdFirstDraw\(\{ asked: opAsked, err \}\)\) return;/);
  assert.match(home, /setTimeout\(\(\) => \{\s*if \(opAsked\) return;\s*opAsked = true;\s*again\(\);\s*\}, 3500\)/, 'a computer that does not answer: drawn anyway');
});

test('the same order after a hand-over: by state, then the conversation\'s first time', () => {
  const chat = { machine: null, kind: 'chat', chatId: 'c1', key: 'claude:c1', status: 'waiting', created: 1000, statusAt: 5000, name: 'chat-c1' };
  const other = { machine: null, kind: 'chat', chatId: 'c2', key: 'claude:c2', status: 'waiting', created: 2000, statusAt: 4000, name: 'chat-c2' };
  assert.deepEqual(cardOrder([chat, other]).map((s) => s.name), ['chat-c2', 'chat-c1'], 'newest conversation first');
  // c1 handed to a terminal: a newer record and a newer state time, the same conversation
  const handed = { ...chat, kind: 'claude', name: 'term-1', created: 9000, statusAt: 9500 };
  assert.deepEqual(cardOrder([handed, other]).map((s) => s.name), ['chat-c2', 'term-1'], 'it did not move');
  assert.equal(firstTime(handed), 1000);
});

test('an old address finds the conversation where it is now', () => {
  const list = [{ name: 'chat-c1', kind: 'chat', chatId: 'c1', sessionId: 'conv-1' }, { name: 'other', kind: 'claude', sessionId: 'conv-2' }];
  assert.equal(whereNow(list, { name: 'term-1', sessionId: 'conv-1' }).chatId, 'c1');
  assert.equal(whereNow(list, { name: 'term-1', key: 'claude:conv-1' }), null, 'a key that no card has');
  assert.equal(whereNow(list, { name: 'term-1' }), null, 'nothing known of it');
  assert.equal(whereNow([{ name: 'term-1', sessionId: 'conv-1' }], { name: 'term-1', sessionId: 'conv-1' }), null, 'itself is not "elsewhere"');
  const session = src('session.js');
  assert.match(session, /whereNow\(d\.sessions, \{ name, key: session\.key, sessionId: session\.sessionId \}\)/);
  assert.match(session, /handOver\(`#\/\$\{now\.kind === 'chat'/, 'it replaces the address');
});

test('the terminal head has the way back to the App as one visible button, not a row in More', () => {
  const session = src('session.js');
  assert.match(session, /h\('button\.btn\.small\.secondary\.sessopen\.hidden'/);
  assert.match(session, /h\('span\.sessopen-label', h\('span\.sessopen-long', 'Open in '\), 'App'\)/);
  assert.match(session, /'aria-label': 'Open in App'/);
  assert.match(session, /registeredSessionActions\(\)\.filter\(\(a\) => a\.id !== 'open-chat'\)/, 'no second place for it');
});

test('no way back on the pages of the bar, the menu and their tabs; a sub-page keeps its own', () => {
  for (const p of ['home', 'work', 'workspace', 'providers', 'computers', 'settings', 'skills', 'brain']) assert.equal(isTopPage(p), true, p);
  assert.equal(isTopPage('settings', '#/settings'), false, 'a Settings sub-page names its parent');
  assert.equal(isTopPage('brain', '#/brain'), false);
  assert.equal(isTopPage('computer'), false);
  assert.equal(isTopPage('session'), false);
  assert.match(src('shell.js'), /const way = isTopPage\(page, parent\) \? null : wayBack\(parent\)/);
});

test('Projects and Computers keep their main action in the page head, no floating button over a row', () => {
  assert.match(src('projects.js'), /primary: \{ label: 'Add project'[^\n]*\n\s*primaryInHead: true/);
  assert.match(src('projects.js'), /primary: \{ label: 'New session'[^\n]*\n\s*primaryInHead: true/);
  assert.match(src('computers.js'), /primary: \{ label: 'Add a computer'[^\n]*\n\s*primaryInHead: true/);
});

test('the head has a gear of 44 by 44, not the sliders', () => {
  assert.match(src('shell.js'), /icon\('gear', \{ size: 22 \}\)/);
  assert.match(src('icons.js'), /^\s{2}gear: \[/m);
  assert.match(src('style.css'), /@media \(max-width: 899px\) \{ \.gear-btn \{ width: 44px; height: 44px; \} \}/);
});

test('one rule for touch screens: 44 by 44 for buttons, icon buttons, tabs and switches', () => {
  const css = src('style.css');
  const at = css.indexOf('One rule for touch screens');
  assert.ok(at > 0);
  const rule = css.slice(at, css.indexOf('/* The Settings gear'));
  assert.match(rule, /@media \(pointer: coarse\)/);
  assert.match(rule, /--tap: 44px/);
  assert.match(rule, /:root:root :is\(\.btn, \.btn\.small[^{]*\.pagehead-primary\) \{ min-height: 44px; \}/);
  assert.match(rule, /:root:root :is\([^{]*\.icon-btn[^{]*\.pagehead-back[^{]*\) \{ min-width: 44px; \}/);
  assert.match(rule, /:root:root :is\(\.icon-btn, \.pagehead-back, \.btn\.icon\) \{ min-height: 44px; \}/);
  assert.match(rule, /input\.switch \{ width: 54px; height: 44px;/);
  // the numbers the look found: nothing in the shared style asks a touch screen for less
  assert.doesNotMatch(rule, /min-height: (3\d|4[0-3])px/);
});

test('one computer chosen and no sessions on it: said for that computer, the start is on it', () => {
  const home = src('home.js');
  assert.match(home, /const chosen = multi && !fixed && only !== 'all' \? all\.find\(\(m\) => keyOf\(m\.machine\) === only\) : null;/);
  assert.match(home, /`No sessions on \$\{chosen\.machineLabel\}\.`/);
  assert.match(home, /openNewSession\(\{ m: chosen\.machine \}\)/);
});

test('the terminal head keeps its room on a phone: the provider button shows its icon only', () => {
  assert.match(src('style.css'), /@media \(max-width: 520px\) \{\s*\.sessbar \.profilebtn-label \{ display: none; \}/);
});

test('the number on the badge of Home counts the same on every page: sessions that wait for you and the providers row', () => {
  const waits = { name: 'a', kind: 'claude', display: 'Fix the cart', status: 'attention' };
  const ok = { machine: null, machineLabel: 'Desk', status: 'online', profiles: [{ name: 'p', label: 'Max', kind: 'subscription', signedIn: true }], sessions: [] };
  assert.equal(ownNeedsOf([ok], false), 0, 'nothing wrong, nothing to count');
  const limited = { ...ok, profiles: [{ name: 'p', label: 'Max', kind: 'subscription', signedIn: true, limited: { resetsAt: Date.now() + 3600000 } }] };
  assert.equal(ownNeedsOf([limited], false), 1, 'a provider at its limit is one row');
  assert.equal(ownNeedsOf([], false), 0, 'no computer yet');
  assert.equal(ownNeedsOf([{ ...ok, sessions: [waits, { ...waits, name: 'b', display: 'Other' }, { name: 'c', kind: 'claude', display: 'Busy', status: 'working' }] }], false), 2, 'two conversations wait, a busy one does not');
  assert.equal(ownNeedsOf([{ ...limited, sessions: [waits] }], false), 2, 'a waiting session and the providers row');
});
