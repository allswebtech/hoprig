// What the terminal page sends for a key it answers itself (web/termkeys.js), and the key bar's keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { KEY_BAR, KEY_HELP, NEW_LINE, termKey } from '../../web/termkeys.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const key = (o) => ({ type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...o });

test('Shift+Enter opens a new line: the page sends a line feed (Ctrl+J), never the carriage return of Enter', () => {
  assert.equal(NEW_LINE, '\n');
  assert.equal(termKey(key({ shiftKey: true })), '\n');
  assert.equal(termKey(key({ type: 'keypress', shiftKey: true })), '', 'its keypress is stopped too: no Enter follows the new line');
  assert.equal(termKey(key({ type: 'keyup', shiftKey: true })), null);
});

test('Enter alone, other chords and a composing input method stay with the terminal library', () => {
  assert.equal(termKey(key({})), null, 'Enter still sends');
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(termKey(key({ shiftKey: true, [mod]: true })), null, mod);
  assert.equal(termKey(key({ shiftKey: true, isComposing: true })), null, 'Enter ends a composition');
  assert.equal(termKey(key({ key: 'a', shiftKey: true })), null);
});

test('the terminal page stops a key it answers itself, so nothing else is sent for it', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  const handler = src.slice(src.indexOf('term.attachCustomKeyEventHandler('), src.indexOf('term.parser.registerOscHandler('));
  assert.match(handler, /const own = termKey\(e\);\s*if \(own !== null\) \{\s*e\.preventDefault\(\);\s*if \(own\) input\(own\);\s*return false;/);
  assert.match(src, /KEY_BAR\.map\(/, 'the key bar is drawn from the list in termkeys.js');
});

test('the key bar keeps its order and gains New line beside Enter; the desktop grid has a column for every key', () => {
  assert.deepEqual(KEY_BAR.map(([label]) => label), ['Esc', 'Tab', '⇧Tab', 'Ctrl', 'Ctrl C', '/', 'Enter', 'New line', '←', '↑', '↓', '→']);
  const nl = KEY_BAR.find(([label]) => label === 'New line');
  assert.deepEqual(nl.slice(1), [NEW_LINE, 'New line (Shift+Enter)']);
  const css = fs.readFileSync(path.join(WEB, 'page-session.css'), 'utf8');
  const cols = Number(/\.keybar \{[^}]*repeat\((\d+),/.exec(css)[1]);
  assert.equal(cols, KEY_BAR.length + 1, 'every key and Paste on one row');
});

test('a long paste goes in frames the server takes, whole, in order, and no emoji is cut in two', async () => {
  const { inputFrames } = await import('../../web/termkeys.js');
  const line = (i) => `line ${i} 😀 नमस्ते \x1b ${'x'.repeat(30)}\n`;
  let text = '\x1b[200~';
  for (let i = 0; text.length < 1 << 20; i++) text += line(i);
  text += '\x1b[201~';
  const frames = inputFrames(text);
  assert.ok(frames.length > 100);
  assert.equal(frames.join(''), text);
  for (const f of frames) {
    assert.ok(Buffer.byteLength(JSON.stringify({ t: 'in', d: f })) <= 64 * 1024, 'under the server\'s frame limit');
    assert.doesNotMatch(f, /^[\udc00-\udfff]|[\ud800-\udbff]$/, 'no half of a character at either end');
  }
  assert.deepEqual(inputFrames('a'), ['a']);
  assert.deepEqual(inputFrames(''), []);
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /for \(const m of inputMessages\(d\)\) sendWs\(m\)/, 'every input of the terminal goes through it (inputMessages cuts with inputFrames)');
});

test('the key bar\'s Ctrl: the next key goes with Ctrl (the way to Ctrl+T, Ctrl+W, Ctrl+N a browser keeps), then it lets go', async () => {
  const { stickyCtrl, withCtrl } = await import('../../web/termkeys.js');
  assert.deepEqual(['r', 'T', 'w', 'n', 'o', ' ', '_'].map(withCtrl), ['\x12', '\x14', '\x17', '\x0e', '\x0f', '\x00', '\x1f']);
  assert.equal(withCtrl('word'), 'word', 'a word from the phone\'s suggestions goes as it is');
  const b = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const c = stickyCtrl();
  assert.equal(c.apply('t'), 't', 'not held: as typed');
  c.toggle(b);
  assert.equal(b.attrs['aria-pressed'], 'true');
  assert.equal(c.apply('\x1b[I'), '\x1b[I', 'a focus report is not a key: Ctrl stays held');
  assert.equal(c.apply('t'), '\x14');
  assert.equal(b.attrs['aria-pressed'], 'false', 'let go after one key');
  assert.equal(c.apply('t'), 't');
  c.toggle(b);
  assert.equal(c.apply('\x1b[D'), '\x1b[1;5D', 'Ctrl+Left: a word to the left');
  c.toggle(b);
  c.toggle(b);
  assert.equal(c.on, false, 'a second press lets go');
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /async function input\(d\) \{\s*d = ctrl\.apply\(d\);/, 'every key of the terminal goes through it, the keyboard\'s too');
  assert.match(src, /if \(b\.dataset\.act === 'ctrl'\) return ctrl\.toggle\(b\);/);
  assert.match(src, /title: 'Show or hide the key bar: [^']*Ctrl, then T, W or N/, 'the way to the keys a browser keeps is said where a person looks');
});

test('an image comes through Ctrl+V or a drop now (termdrop.js): no word of the page says it cannot', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /'aria-label': 'Attach a file', title: 'Attach a file or an image: it goes into the session folder and its path into your message'/);
  assert.doesNotMatch(src + KEY_HELP.join('\n'), /cannot (?:take|be pasted)[^\n]*image|image[^\n]*cannot/i);
});

test('a dropped or pasted file\'s path is typed in the same line as every key: nothing of its own closes the history view', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  const typing = src.slice(src.indexOf('async function typeIntoTerminal('), src.indexOf('let sending = '));
  assert.match(typing, /term\.paste\(text\);/, 'term.paste ends in onData, so in input() and its order');
  assert.doesNotMatch(typing, /scroller|sendWs|ws\.send/, 'a close of its own let it go beside the keys typed before it');
  assert.match(src, /term\.onData\(\(d\) => input\(d\)\);/);
  // The paste key with nothing to paste, and Ctrl+V on a Mac without a picture: the byte goes the same way.
  assert.match(src, /e\.stopPropagation\(\);\s*input\(CTRL_V\);/);
  assert.match(src, /else input\(CTRL_V\);/);
});

test('keys typed while the history view closes wait for it and arrive in the order typed', async () => {
  const { inOrder } = await import('../../web/termkeys.js');
  // The page's history view: closing it is a request (tmux leaves copy mode when it answers).
  const sent = [];
  let inCopyMode = true;
  const scroller = { offset: 3, exiting: null };
  scroller.exit = () => {
    scroller.offset = 0;
    scroller.exiting = new Promise((r) => setTimeout(() => { inCopyMode = false; r(); }, 30));
    return scroller.exiting;
  };
  const { backToLive } = await import('../../web/termkeys.js');
  const ordered = inOrder(() => backToLive(scroller));
  const typed = ['b', 'c', 'd', 'e'].map((k) => ordered(() => sent.push([k, inCopyMode])));
  await Promise.all(typed);
  assert.deepEqual(sent, [['b', false], ['c', false], ['d', false], ['e', false]], 'none reaches copy mode, none passes another');
  await ordered(() => { throw new Error('a send that fails'); });
  await ordered(() => sent.push(['f', inCopyMode]));
  assert.deepEqual(sent.at(-1), ['f', false], 'one failure does not stop the keys after it');
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /const ordered = inOrder\(\(\) => backToLive\(scroller\)\);/);
  assert.match(src, /return ordered\(\(\) => \{\s*for \(const m of inputMessages\(d\)\)/, 'every key of the terminal goes through it');
  assert.match(src, /term\.onBinary\(\(d\) => ordered\(/, 'mouse reports too');
});

test('a key typed while the first scroll-up request runs waits for it, closes the view and reaches the program', async () => {
  const { backToLive, inOrder } = await import('../../web/termkeys.js');
  // The wheel turned: tmux is in copy mode as soon as it takes the request, the page knows the view is open (offset)
  // only when the answer comes.
  const sent = [];
  let inCopyMode = true;
  const scroller = { offset: 0, pending: 0, exiting: null, exits: 0 };
  scroller.flushing = new Promise((r) => setTimeout(() => { scroller.offset = 5; scroller.flushing = null; r(); }, 30));
  scroller.pending = 2; // more wheel lines, not sent yet
  scroller.exit = () => {
    scroller.exits++;
    scroller.offset = 0;
    scroller.exiting = new Promise((r) => setTimeout(() => { inCopyMode = false; scroller.exiting = null; r(); }, 20));
    return scroller.exiting;
  };
  const ordered = inOrder(() => backToLive(scroller));
  await Promise.all(['b', 'a'].map((k) => ordered(() => sent.push([k, inCopyMode]))));
  assert.deepEqual(sent, [['b', false], ['a', false]], 'sent at once, the key reached copy mode and was eaten');
  assert.equal(scroller.exits, 1);
  assert.equal(scroller.pending, 0, 'wheel lines from before the key are not sent after it');
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /this\.flushing = run;/, 'the page keeps its running scroll requests where backToLive waits for them');
});

test('an attach that tmux ends at once while the session runs: the page waits longer each time, then stops and says so', async () => {
  const { QUICK_TRIES, reconnectWait } = await import('../../web/termkeys.js');
  const state = { retry: 0, quick: 0 };
  const waits = [];
  for (let i = 0; i < 10; i++) waits.push(reconnectWait(state, { code: 4001, lived: 40 })); // opened, "detached" 40 ms later
  assert.deepEqual(waits.slice(0, QUICK_TRIES - 1), [500, 1000, 2000, 4000], 'reset on every open, it stayed at 500 ms for ever');
  assert.equal(waits[QUICK_TRIES - 1], null, 'then it stops');
  const link = { retry: 0, quick: 0 }; // a link that drops after a while, again and again
  for (let i = 0; i < 10; i++) assert.equal(reconnectWait(link, { code: 1006, lived: 60_000 }), 500, 'a socket that lived a while starts the wait again');
  const detach = { retry: 0, quick: 0 }; // a detach key of the user's tmux, pressed now and then
  assert.equal(reconnectWait(detach, { code: 4001, lived: 30_000 }), 500);
  assert.equal(reconnectWait(detach, { code: 4001, lived: 30_000 }), 500);
  const down = { retry: 0, quick: 0 }; // the dashboard is away: no socket opens
  const d = [];
  for (let i = 0; i < 8; i++) d.push(reconnectWait(down, { code: 1006, lived: 0 }));
  assert.deepEqual(d, [500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000], 'it keeps trying while the dashboard is away');
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /const wait = reconnectWait\(again, \{ code: e\.code, lived: opened \? Date\.now\(\) - opened : 0 \}\);\s*if \(wait === null\)/);
  assert.doesNotMatch(src, /retry = 0;/, 'an open alone no longer starts the wait again');
});

test('a second "Try again" while the first socket still connects opens no second one', async () => {
  const { mayConnect } = await import('../../web/termkeys.js');
  assert.equal(mayConnect(null), true, 'the first connect');
  assert.equal(mayConnect({ readyState: 0 }), false, 'connecting: a quick second click does nothing');
  assert.equal(mayConnect({ readyState: 1 }), false, 'open');
  assert.equal(mayConnect({ readyState: 2 }), true, 'closing');
  assert.equal(mayConnect({ readyState: 3 }), true, 'closed: Try again, or the wait after a lost link');
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /function connect\(\) \{\n\s*if \(disposed \|\| !mayConnect\(ws\)\) return;\n\s*clearTimeout\(retryTimer\);\n\s*fit\.fit\(\);\n\s*ws = new WebSocket\(/, 'connect() asks before it opens one');
});

test('the key bar\'s New line goes into the message box when the person writes there, else to the terminal', async () => {
  const { keyBarTarget } = await import('../../web/termkeys.js');
  assert.equal(keyBarTarget(NEW_LINE, true), 'box', 'a line break in the message being written');
  assert.equal(keyBarTarget(NEW_LINE, false), 'terminal');
  for (const [, seq] of KEY_BAR.filter(([, s]) => s !== null && s !== NEW_LINE)) assert.equal(keyBarTarget(seq, true), 'terminal', seq);
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /if \(keyBarTarget\(seq, document\.activeElement === textarea\) === 'box'\) \{\s*textarea\.setRangeText\(seq, textarea\.selectionStart, textarea\.selectionEnd, 'end'\);\s*prefs\.set\(draftKey, textarea\.value\);/);
});

test('the key bar\'s Ctrl lets go when the person goes to the message box, so no later terminal key becomes a chord', async () => {
  const { stickyCtrl } = await import('../../web/termkeys.js');
  const b = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const c = stickyCtrl();
  c.release();
  assert.equal(c.on, false, 'not held: nothing to let go');
  c.toggle(b);
  c.release();
  assert.equal(c.on, false);
  assert.equal(b.attrs['aria-pressed'], 'false');
  assert.equal(c.apply('u'), 'u', 'u, not Ctrl+U (which clears the prompt)');
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /textarea\.addEventListener\('focus', \(\) => ctrl\.release\(\)\);/);
  assert.match(src, /textarea\.addEventListener\('input', \(\) => ctrl\.release\(\)\);/);
});

test('the program\'s title shows in the page\'s title, and its bell flashes the terminal\'s frame', async () => {
  const { pageTitle } = await import('../../web/termkeys.js');
  assert.equal(pageTitle('shop', ''), 'shop', 'no title of its own: the session\'s name');
  assert.equal(pageTitle('shop', '✳ Fix the cart'), 'shop · ✳ Fix the cart');
  assert.equal(pageTitle('shop', 'shop'), 'shop');
  assert.equal(pageTitle('shop', 'a\x07b\x1b'), 'shop · ab', 'no control characters');
  assert.equal(pageTitle('shop', 'x'.repeat(500)).length, 'shop · '.length + 80);
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /term\.onTitleChange\(\(t\) => pageNotify\.setTitleBase\(pageTitle\(name, t\)\)\);/);
  assert.match(src, /term\.onBell\(\(\) => \{\s*box\.classList\.add\('bell'\);/);
  assert.match(fs.readFileSync(path.join(WEB, 'page-session.css'), 'utf8'), /\.term-box\.bell \{/);
});

test('the way to Ctrl+T, Ctrl+W, Ctrl+N and to an image is said in words a touch screen shows, not only in titles', async () => {
  const { KEY_HELP } = await import('../../web/termkeys.js');
  const all = KEY_HELP.join('\n');
  assert.match(all, /Ctrl\+T, Ctrl\+W and Ctrl\+N[^\n]*tap Ctrl, then the letter/);
  assert.match(all, /image: paste it with Ctrl\+V or drop it[^\n]*File on the key bar[^\n]*paperclip/);
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /\{ value: 'keys', label: 'Keys and images'/, 'an entry of the session\'s More menu');
  assert.match(src, /else if \(what === 'keys'\) openSheet\(\{ title: 'Keys and images' \}, \(\) => KEY_HELP\.map\(/);
});
