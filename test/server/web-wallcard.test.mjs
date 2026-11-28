// The page's card of an act the wall held (web/handsoff.js heldActCard), its place on the session page, and the line
// about sessions a project's switch cannot cover (uncoveredLine), which stays on Settings → Hands-off instead of a
// toast that goes after a few seconds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));

const { heldActCard, uncoveredLine, OWNER_ACTS, consentSheetBody, consentPending, takeFirstConsent } = await import('../../web/handsoff.js');
const { heldCard, heldRecord } = await import('../../src/askcard.mjs');
const { WALL_TITLE } = await import('../../src/wall.mjs');
const tagged = (n, tag) => (n instanceof FakeText ? [] : [...(n.tag === tag ? [n] : []), ...n.children.flatMap((c) => tagged(c, tag))]);

test('the held card says what, as a part of a longer command, why it is his and what each answer does', () => {
  const card = heldCard(heldRecord({ kind: 'push', why: 'push', part: 'git push origin main', partOf: true }, 'Bash', 1));
  const words = texts(heldActCard(card));
  assert.deepEqual(words, [
    'A push to the main branch or a tag',
    'The session wants to run this, as part of a longer command:',
    'git push origin main',
    'This would move a default branch or a tag, which stays yours even with Hands-off on.',
    'Allow runs it this once.',
    'Do not allow: it does not run, and the session stops and waits for your message.',
    'Held by Hoprig before it ran',
  ]);
});

test('a long held part is shown up to the card\'s length and says how much more there is; a file is named as one', () => {
  const part = `sudo sh -c 'echo ${'x'.repeat(900)}'`;
  const w = texts(heldActCard(heldCard(heldRecord({ kind: 'admin', why: 'admin', part, partOf: false }, 'Bash', 1))));
  assert.equal(w[1], 'The session wants to run this:');
  assert.equal(w[2], part.slice(0, 400));
  assert.equal(w[3], ` … (${part.length - 400} more characters)`);
  const f = texts(heldActCard(heldCard(heldRecord({ kind: 'project', why: 'project', part: '/w/shop/project.json' }, 'Edit', 1))));
  assert.equal(f[1], 'The session wants to create or change this file:');
  assert.equal(heldActCard(null), null);
});

test('the session page shows the held card for a permission that was held, in place of the one-line note', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /const held = !exact && s\.ask && s\.ask\.type === 'permission' \? heldActCard\(s\.held\) : null;/);
  assert.match(src, /exact \|\| held \|\| \(s\.note \? h\('p\.sess-ok-text', s\.note\) : null\)/);
});

const links = (n) => (n instanceof FakeText ? [] : [...(n.tag === 'a' ? [n] : []), ...n.children.flatMap(links)]);

test('the line about uncovered sessions links each name to its session and says it plainly; none: no line', () => {
  const one = uncoveredLine(['shop']);
  assert.equal(one.attrs.role, 'status');
  const words = texts(one).join('');
  assert.match(words, /This session started before Hands-off could hold commands: shop\./);
  assert.match(words, /commands such as a push or a release are not held for it\. Start it again to have them held\./);
  assert.doesNotMatch(words, /none of its acts/, 'the vague word "acts" is gone');
  assert.deepEqual(links(one).map((a) => a.attrs.href), ['#/s/shop'], 'the name is a link to its session page');
  assert.match(texts(uncoveredLine(['shop', 'alpha'])).join(''), /These sessions started .*: shop, alpha\. .*not held for them\. Start them again/);
  assert.deepEqual(links(uncoveredLine(['shop', 'alpha'])).map((a) => a.attrs.href), ['#/s/shop', '#/s/alpha']);
  // On the session's own page the name is not a self-link.
  assert.equal(links(uncoveredLine(['shop'], { linked: false })).length, 0);
  assert.equal(uncoveredLine([]), null);
  assert.equal(uncoveredLine(undefined), null);
});

test('the session page shows the uncovered line when its card says so (web/session.js)', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /s\.handsOff && s\.handsOff\.uncovered \? uncoveredLine\(\[name\], \{ linked: false \}\) : null/);
});

test('Settings → Hands-off draws the line from the project\'s view, and no toast says it any more', async () => {
  const src = fs.readFileSync(path.join(WEB, 'handsoffsettings.js'), 'utf8');
  assert.match(src, /uncoveredLine\(p\.uncovered\)/);
  assert.doesNotMatch(src, /toast\(`Start again to hold their acts/);
  const { registeredSettingsPages } = await import('../../web/registry.js');
  await import('../../web/handsoffsettings.js');
  const page = registeredSettingsPages().find((p) => p.id === 'handsoff');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ projects: [{ dir: '/w/projects/shop', on: true, stale: false, note: '', uncovered: ['shop'] }] }) });
  try {
    const root = new FakeElement('div');
    root.append(...page.render());
    await new Promise((r) => setTimeout(r, 5));
    assert.match(texts(root).join(' '), /This session started before Hands-off could hold commands:\s+shop/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a held card above the terminal shows its reason and both answers whole; only a long command scrolls in its box', () => {
  const css = fs.readFileSync(path.join(WEB, 'page-session.css'), 'utf8');
  assert.match(css, /\.sess-need \.ho-card\.ho-held \{ max-height: none; overflow: visible; \}/);
  assert.match(css, /\.sess-need \.ho-held-what \{ max-height: 30dvh; overflow: auto; \}/);
  assert.match(css, /@media \(max-width: 480px\) \{ \.sess-need \.ho-held-what \{ max-height: 14dvh; \}/);
});

test('a push or a merge the wall cannot place is titled in plain words', async () => {
  const { WALL_TITLE } = await import('../../src/wall.mjs');
  assert.equal(WALL_TITLE['push-elsewhere'], 'A push Hoprig cannot place');
  assert.equal(WALL_TITLE['merge-elsewhere'], 'A merge Hoprig cannot place');
});

test('a line with more than one held act lists every one on the card; one Allow runs the whole command', () => {
  // The record carries the first act plus the rest (heldRecord `more`): the page names them all so none is hidden.
  const acts = [
    { kind: 'push', why: 'push', part: 'git push origin main', partOf: true },
    { kind: 'release', why: 'release', part: 'npm publish --access public', partOf: true },
  ];
  const card = heldCard(heldRecord({ ...acts[0], acts }, 'Bash', 1));
  const words = texts(heldActCard(card));
  assert.deepEqual(words, [
    'This command does 2 things that are yours:',
    'A push to the main branch or a tag',
    'git push origin main',
    'This would move a default branch or a tag, which stays yours even with Hands-off on.',
    'Publishing or a release',
    'npm publish --access public',
    'This would publish or release, or change what is already published, which stays yours even with Hands-off on.',
    'Allow runs the whole command once, including everything listed here.',
    'Do not allow: it does not run, and the session stops and waits for your message.',
    'Held by Hoprig before it ran',
  ]);
});

test('a line of more held acts than the card lists counts them all and says how many are not listed', () => {
  const acts = Array.from({ length: 15 }, (_, i) => ({ kind: 'admin', why: 'admin', part: `sudo true ${i}`, partOf: true }));
  const card = heldCard(heldRecord({ ...acts[0], acts }, 'Bash', 1));
  const words = texts(heldActCard(card));
  assert.equal(words[0], 'This command does 15 things that are yours:');
  assert.equal(words.filter((w) => w.startsWith('sudo true ')).length, 10);
  assert.ok(words.includes('And 5 more that are yours, not listed here. Look at the whole command in the terminal before you allow it.'));
  assert.equal(words.at(-3), 'Allow runs the whole command once, including everything listed here.');
});

test('Home and Workspace cards show the held act in place of the short note (web/sessionitem.js)', () => {
  // On Home and in the Workspace, a held act offered Allow under a 120-character note that could cut off what was
  // held. The card and the row now render the full held card (heldActCard) whenever a hold is present.
  const src = fs.readFileSync(path.join(WEB, 'sessionitem.js'), 'utf8');
  assert.match(src, /import \{ heldActCard \} from '\.\/handsoff\.js';/);
  const placed = src.match(/s\.held \? heldActCard\(s\.held\) : st\.key === 'attention' && s\.note/g) || [];
  assert.equal(placed.length, 2, 'the held card replaces the short note in both sessionCard and sessionRow');
});

test('after a keyboard answer, focus stays on the page and the buttons name the act (web/lib.js)', () => {
  // The answer replaced the buttons, so the focused one vanished and focus fell to the page body, told only by a
  // toast. The "answer was sent" line is now a focusable live region the render moves focus to, and the Allow and
  // Do not allow buttons carry an aria-label naming the act.
  const src = fs.readFileSync(path.join(WEB, 'lib.js'), 'utf8');
  assert.match(src, /role: 'status', tabindex: '-1'/, 'the sent line is a focusable live region');
  assert.match(src, /answerFocusUntil = Date\.now\(\) \+ 5000/, 'a window to move focus across the re-render');
  assert.match(src, /line\.focus\(\)/, 'focus moves to the sent line');
  assert.match(src, /'aria-label': about \? `Allow — \$\{about\}`/, 'Allow names the act for a screen reader');
  assert.match(src, /'aria-label': about \? `Do not allow — \$\{about\}`/, 'Do not allow names the act');
});

test('a card with many held acts keeps its answers in the window: the list scrolls inside the card, not the page', () => {
  const acts = Array.from({ length: 15 }, (_, i) => ({ kind: 'admin', why: 'admin', part: `sudo true ${i}`, partOf: true }));
  const card = heldActCard(heldCard(heldRecord({ ...acts[0], acts }, 'Bash', 1)));
  const find = (n, cls) => (n instanceof FakeText ? null : String(n.className).split(' ').includes(cls) ? n : n.children.map((c) => find(c, cls)).find(Boolean) || null);
  const list = find(card, 'ho-held-acts');
  assert.ok(list, 'the acts are in a box of their own');
  assert.equal(list.children.filter((c) => String(c.className).includes('ho-held-act')).length, 10, 'ten listed, in the box');
  assert.equal(list.attrs.tabindex, '0', 'the box can be reached and scrolled by keyboard');
  assert.ok(find(card, 'ho-held-answers') && !find(list, 'ho-held-answers'), 'the answers lie outside the scrolling box');
  const css = fs.readFileSync(path.join(WEB, 'page-session.css'), 'utf8');
  assert.match(css, /\.sess-need \.ho-held-acts \{ max-height: 32dvh; overflow: auto;/);
  assert.match(css, /@media \(max-width: 480px\) \{ \.sess-need \.ho-held-acts \{ max-height: 22dvh; \} \}/);
});

// ---------- the first-time consent sheet (web/handsoff.js) ----------

test('the first-time sheet lists every held act in the cards\' exact titles (WALL_TITLE), each with a plain line', () => {
  // Every WALL_TITLE kind, in its order, so nothing the wall holds is dropped from the sheet; the title is the exact
  // card title; a non-empty plain line glosses each for a non-programmer. Importing WALL_TITLE keeps them from drifting
  // and makes a new wall kind added later show up as a missing entry here instead of silently going missing on the sheet.
  assert.deepEqual(OWNER_ACTS.map((a) => a.title), Object.values(WALL_TITLE), 'every card title, in order, exactly as in the code');
  for (const a of OWNER_ACTS) {
    assert.ok(Object.values(WALL_TITLE).includes(a.title), `${a.title} is a wall card title`);
    assert.ok(typeof a.plain === 'string' && a.plain.trim().length > 0 && a.plain !== a.title, `${a.title} has a plain-words line of its own`);
  }
});

test('the first-time sheet says what Hands-off does, what stays yours, what it costs and how to stop it, and has one button to dismiss', () => {
  const body = consentSheetBody(() => {});
  const words = body.flatMap(texts).join(' ');
  assert.match(words, /answers the questions your coding tool would put to you, picking the option the tool marks as recommended/);
  assert.match(words, /These always stay yours\. When Hoprig sees the session about to do one of these, it stops and asks you first:/);
  assert.doesNotMatch(words, /asks you first, every time/, 'no absolute "every time" promise: the wall reads a line, it does not run it, so a few disguised forms get past it');
  assert.match(words, /reads each command before it runs to catch these\. It is careful, not perfect: a session that deliberately disguises a command could still slip one past it/, 'the sheet owns the limit of reading a line');
  assert.match(words, /If the tool has not marked a recommended answer, it gives your note for the project \(Settings → Hands-off\) as a written answer where the tool takes one; without a note that question still waits for you/, 'it does not promise every question carries on');
  for (const a of OWNER_ACTS) {
    assert.ok(words.includes(a.title), `the sheet names ${a.title}`);
    assert.ok(words.includes(a.plain), `the sheet glosses ${a.title} in plain words`);
  }
  assert.match(words, /costs nothing by itself/);
  assert.match(words, /To stop it, use the same switch again\. A single session also has its own Off/);
  // One button, which takes the focus (openSheet focuses [autofocus]), so the sheet is read and dismissed by keyboard.
  const buttons = body.flatMap((n) => tagged(n, 'button'));
  assert.equal(buttons.length, 1, 'one button');
  assert.deepEqual(buttons[0].children.map((c) => c.text), ['Got it']);
  assert.equal(buttons[0].attrs.autofocus, '', 'the button has the focus for the keyboard');
  assert.equal(typeof buttons[0].listeners.click, 'function', 'it is operable by click/Enter');
});

test('the sheet is shown once per browser: the flag is taken on the first turn-on and not again', () => {
  const store = { data: {}, get(k) { return this.data[k]; }, set(k, v) { this.data[k] = v; } };
  assert.equal(consentPending(store), true, 'pending before any switch is turned on');
  assert.equal(takeFirstConsent(store), true, 'the first turn-on takes it and shows the sheet');
  assert.equal(consentPending(store), false, 'no longer pending on this computer');
  assert.equal(takeFirstConsent(store), false, 'a later turn-on does not show it again');
});

test('every place a switch is turned on shows the sheet once, and Settings can read it again', () => {
  const ses = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(ses, /if \(on === true\) openConsentSheet\(\)/, 'the session bar opens it only on turn-on');
  assert.match(ses, /if \(turningOn\) openConsentSheet\(\)/, 'the session menu opens it only on turn-on');
  const set = fs.readFileSync(path.join(WEB, 'handsoffsettings.js'), 'utf8');
  assert.match(set, /if \(on === true\) openConsentSheet\(\)/, 'the project switch opens it only on turn-on');
  assert.match(set, /openConsentSheet\(\{ always: true \}\)/, 'Settings reopens it without touching the flag');
  // An App chat session turns its own switch on too (web/chat/page.js: its menu and its bar), so it must show the sheet.
  const chat = fs.readFileSync(path.join(WEB, 'chat', 'page.js'), 'utf8');
  assert.match(chat, /import \{[^}]*openConsentSheet[^}]*\} from '\.\.\/handsoff\.js'/, 'the chat imports the sheet');
  assert.equal((chat.match(/if \(on === true\) openConsentSheet\(\)/g) || []).length, 2, 'the chat menu and the chat bar each open it only on turn-on');
  assert.match(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8'), /\.ho-consent-acts/, 'the acts list is styled');
});
