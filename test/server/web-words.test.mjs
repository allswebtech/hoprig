// What a person reads says what is true with two coding tools (Claude Code and OpenCode): a sentence about any
// coding tool uses the neutral word or the tool's own name, and only what is Claude Code's (its sign-in, its model,
// Auto mode, its own retries) names it. Also the page fixes of the same pass: Tab stays in a sheet, a schedule never
// shows a provider's short name, a chat that closes is told by its stream, the rare switches under Advanced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Just enough of a browser for the modules to load (the same stand-in as web.test.mjs).
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));

// Sentences that said "Claude" for what any coding tool does, by the file they were in.
const GONE = {
  'web/home.js': [/Your Claude Code sessions/, /the provider Claude should use/],
  'web/newsession.js': [/a chat with Claude opens/, /the provider Claude should use/, /Claude gets its memory/, /Starting Claude in/],
  'web/projects.js': [/a chat with Claude/, /Claude gets its memory/, /Claude can put it there/, /Claude can bring/, /Ask Claude to sort/, /skills Claude uses/, /ready for Claude/, /ask Claude there/, /the rules Claude and other AI tools/],
  'web/workspace.js': [/ready for Claude/],
  'web/automation.js': [/interrupts Claude/, /Claude session/, /Claude finishes/, /Claude needs your OK/, /When Claude\\'s servers/, /What Claude should do next/],
  'web/skillhub.js': [/teaches Claude Code one kind/, /Claude uses these/, /what Claude will read/, /Claude Code stops using it/, /Claude Code follows with your permissions/],
  'web/settings.js': [/Claude Code is drawn for a dark terminal/],
  'web/sessiondefaults.js': [/What Claude may do/, /How often Claude stops/, /Which Claude answers/, /every new Claude session/, /a screenshot for Claude/, /'Claude can then run/],
  'web/session.js': [/A Claude conversation can be continued/],
  'web/chat/composer.js': [/'Message to Claude'/, /'Stop Claude/],
  'web/chat/asks.js': [/'Claude wrote no plan text/],
  'web/chat/timeline.js': [/compacted: Claude goes on/],
  'web/pcsetup.js': [/needed for coding with Claude Code/],
  'src/setup/onboarding.mjs': [/'Working rules for Claude'/, /'Skills for Claude'/],
  'src/workspace/layout.mjs': [/the rules Claude gets everywhere/],
  'src/skillhub/catalog.json': [/Teaches Claude Code to use Hoprig/],
  'bin/hoprig.mjs': [/Claude Code under several profiles/, /Claude Code skills for you/],
};

test('words: what any coding tool does is said without "Claude"; Codex is named nowhere a person reads', () => {
  for (const [file, list] of Object.entries(GONE)) {
    const src = read(file);
    for (const re of list) assert.doesNotMatch(src, re, `${file}: ${re}`);
  }
  // What stays Claude Code's is said as its own.
  assert.match(read('web/sessiondefaults.js'), /'Which Claude model answers in Claude Code\./, 'the model setting is Claude Code\'s only');
  assert.match(read('web/automation.js'), /'In a Claude Code session: when the provider\\'s servers are busy/, 'the retry reads Claude Code\'s own error kinds');
  assert.match(read('web/accounts.js'), /Claude Code restarts on that provider/, 'Auto mode is Claude Code\'s');
  // The command line and the package say both coding tools, and never Codex.
  const help = read('bin/hoprig.mjs');
  const helpText = help.slice(help.indexOf('const HELP = `'), help.indexOf('`;', help.indexOf('const HELP = `')));
  assert.match(helpText, /^const HELP = `Hoprig — Claude Code and OpenCode under several providers/);
  assert.doesNotMatch(helpText, /Codex/);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.description, /Claude Code and OpenCode/);
  assert.doesNotMatch(pkg.description, /Codex/);
  // A new project's AGENTS.md names what reads it, not a list of tools this version does not offer.
  const template = read('src/pcsetup/workspace.mjs');
  assert.doesNotMatch(template, /\(Claude Code, Codex, Gemini, Cursor, Copilot\)/);
  assert.match(template, /OpenCode and most others read it, Claude Code through\nCLAUDE\.md/);
});

test('New-session defaults: the coding tool\'s own default, the model Claude Code\'s', async () => {
  const { summary } = await import('../../web/sessiondefaults.js');
  assert.equal(summary({ settings: {} }), 'Each coding tool\'s own defaults');
  assert.equal(summary({ settings: { sessionDefaults: { effort: 'high' } } }), 'effort high');
});

test('the starting pill names the coding tool that starts, by its own name', async () => {
  const { markStarting, startingPill } = await import('../../web/newsession.js');
  assert.deepEqual(texts(startingPill()), ['Starting Claude Code…']);
  markStarting(null, 'oc-term', 'opencode');
  assert.deepEqual(texts(startingPill({ name: 'oc-term', machine: null, kind: 'shell' })), ['Starting OpenCode…']);
});

test('a sheet keeps Tab inside it: from the last control round to the first, and back', async () => {
  const { wrapTab } = await import('../../web/lib.js');
  const [a, b, c] = ['a', 'b', 'c'];
  assert.equal(wrapTab([a, b, c], c, false), a, 'Tab on the last goes to the first');
  assert.equal(wrapTab([a, b, c], a, true), c, 'Shift+Tab on the first goes to the last');
  assert.equal(wrapTab([a, b, c], 'the sheet itself', true), c);
  assert.equal(wrapTab([a, b, c], b, false), null, 'in between: the browser\'s own step');
  assert.equal(wrapTab([a, b, c], b, true), null);
  assert.equal(wrapTab([], a, false), null);
  assert.match(read('web/lib.js'), /sheetEl\.addEventListener\('keydown', \(e\) => \{\n\s+if \(e\.key !== 'Tab'/, 'every sheet, Add provider among them');
});

test('a schedule never says a provider\'s short name, also in the first moment after a load', async () => {
  const { providerWord } = await import('../../web/automation.js');
  const profiles = [{ name: 'max', label: 'Claude Max' }];
  assert.equal(providerWord('max', profiles), 'Claude Max');
  assert.equal(providerWord('auto', undefined), 'Auto mode');
  assert.equal(providerWord('max', undefined), 'its provider', 'not known yet: never "max"');
  assert.equal(providerWord('gone', profiles), 'gone', 'a provider removed since: the name the schedule keeps');
  assert.match(read('web/automation.js'), /off = store\.subscribe\(\(d\) => \{\n\s+if \(done \|\| !\(d && d\.profiles\)\) return;/, 'said again once the providers are known');
});

test('rare things under a closed Advanced: Pause all automations, the map\'s list; Link now only where it belongs', () => {
  const au = read('web/automation.js');
  assert.match(au, /body: \[tabs, bannerSlot, content\]/, 'Pause all is not the first thing on every part any more');
  assert.match(au, /fold\('automations-advanced', 'Advanced', pauseRow\(st\)\)/, 'it is under Rules → Advanced');
  assert.match(au, /label: 'Resume', onclick: \(\) => setPaused\(false\)/, 'while paused, the banner on every part resumes with one tap');
  const ws = read('web/workspace.js');
  assert.match(ws, /fold\('settings-map-list', 'Advanced',/, 'every repository of the map, under Advanced');
  assert.match(ws, /h\('div\.savebar\.start', rare \? null : update\(\),/, '"Update the map" is not offered first while the map keeps itself up to date');
  assert.doesNotMatch(ws, /openSheet\(\{ title: 'Update the map', subtitle: 'From what is on this computer', wide: true \}/, 'not a tall wide sheet for a few lines');
  // The brain's Link now: in Get started, Skills and the AI brain page's own Coding tools part; not on Setup or Settings → Workspace.
  assert.doesNotMatch(read('web/pcsetup.js'), /linkBrainNote/);
  assert.doesNotMatch(read('web/brain.js'), /linkBrainNote\(/);
  assert.match(read('web/skillhub.js'), /linkBrainNote\(\{ only: \['skills'\]/);
  assert.match(read('web/getstarted.js'), /kind === 'link-brain'/);
});

test('a chat that closes: its stream says so, and the page shows it without asking again', async () => {
  // A fetch that answers one look, and an EventSource the test drives.
  const looks = [];
  globalThis.fetch = async (u) => {
    looks.push(String(u));
    return { ok: true, status: 200, json: async () => ({ epoch: 1, next: 0, events: [], reset: true }) };
  };
  let es = null;
  globalThis.EventSource = class {
    constructor(u) {
      this.url = u;
      this.on = {};
      this.closed = false;
      es = this;
    }
    addEventListener(k, fn) {
      this.on[k] = fn;
    }
    close() {
      this.closed = true;
    }
  };
  const { follow } = await import('../../web/chat/stream.js');
  let gone = null;
  const stop = follow({ A: '/api/chats/c1', events: () => {}, state: () => {}, live: () => {}, gone: (e) => (gone = e), connection: () => {} });
  for (let i = 0; i < 50 && !es; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(es, 'the stream opened after the first look');
  const closed = { cwd: '/w/p', conversationId: 'c1', title: null, tool: 'claude' };
  es.on.closed({ data: JSON.stringify({ closed }) });
  assert.deepEqual(gone, { status: 404, data: { closed } }, 'what a 404 of a look would carry');
  assert.equal(es.closed, true);
  assert.equal(looks.length, 1, 'no second look at a chat that is gone (it was a 404 in the console at a hand-off)');
  stop();
  // The empty chat that closed does not invite to write where nothing can be sent.
  assert.match(read('web/chat/page.js'), /if \(!v \|\| !scroll\.querySelector\('\.chat-item, \.chat-userrow'\)\) \{/);
});
