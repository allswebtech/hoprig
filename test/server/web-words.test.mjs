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
  assert.match(read('web/automation.js'), /'Claude Code and OpenCode sessions lost when the computer or the dashboard restarts/, 'restore brings back Claude Code\'s and OpenCode\'s, not Codex\'s (src/automation/restore.mjs)');
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

test('New-session defaults and New session name the modes as the App does: the page with the bypass switch has Bypass permissions', async () => {
  const { MODES, summary } = await import('../../web/sessiondefaults.js');
  const { MODE } = await import('../../web/chat/words.js');
  for (const m of ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) assert.ok(MODES[m].startsWith(`${MODE[m].chip}: `), m);
  assert.match(MODES.bypassPermissions, /^Bypass permissions: /);
  assert.equal(summary({ settings: { sessionDefaults: { permissionMode: 'acceptEdits' } } }), 'Accept edits');
});

test('New-session defaults: the coding tool\'s own default, the model Claude Code\'s', async () => {
  const { summary } = await import('../../web/sessiondefaults.js');
  assert.equal(summary({ settings: {} }), 'Each coding tool\'s own defaults');
  assert.equal(summary({ settings: { sessionDefaults: { effort: 'high' } } }), 'effort high');
  // With Claude Code alone its own name; another coding tool on: the neutral words and what its chat takes.
  const { toolWords } = await import('../../web/sessiondefaults.js');
  assert.deepEqual(toolWords(false).dflt, ['', 'Claude Code\'s own default']);
  assert.doesNotMatch(toolWords(false).desc, /another coding tool/);
  assert.deepEqual(toolWords(true).dflt, ['', 'The coding tool\'s own default']);
  assert.match(toolWords(true).desc, /another coding tool in the App takes the mode and the effort/);
});

test('the starting pill names the coding tool that starts, by its own name', async () => {
  const { markStarting, startingPill } = await import('../../web/newsession.js');
  assert.deepEqual(texts(startingPill()), ['Starting Claude Code…']);
  markStarting(null, 'oc-term', 'opencode');
  assert.deepEqual(texts(startingPill({ name: 'oc-term', machine: null, kind: 'shell' })), ['Starting OpenCode…']);
});

test('a sheet keeps Tab inside it: from the last control round to the first, and back', async () => {
  const { wrapTab } = await import('../../web/tabwrap.js');
  const [a, b, c] = ['a', 'b', 'c'];
  assert.equal(wrapTab([a, b, c], c, false), a, 'Tab on the last goes to the first');
  assert.equal(wrapTab([a, b, c], a, true), c, 'Shift+Tab on the first goes to the last');
  assert.equal(wrapTab([a, b, c], 'the sheet itself', true), c);
  assert.equal(wrapTab([a, b, c], b, false), null, 'in between: the browser\'s own step');
  assert.equal(wrapTab([a, b, c], b, true), null);
  assert.equal(wrapTab([], a, false), null);
  // A closed "Options": what is inside it is not reachable (its summary is), so Tab on the summary goes round.
  const { reachable, keepTabIn } = await import('../../web/tabwrap.js');
  const shut = { parentElement: null };
  const el = (tagName, inside = null, parentElement = null) => ({ tagName, tabIndex: 0, parentElement, getClientRects: () => [1], closest: () => inside, focus() { globalThis.document.activeElement = this; } });
  const first = el('BUTTON');
  const summary = el('SUMMARY', shut, shut);
  const hidden = el('SELECT', shut);
  assert.equal(reachable(first), true);
  assert.equal(reachable(summary), true, 'the summary of a closed details');
  assert.equal(reachable(hidden), false, 'a field inside it, though its box is still there');
  let handler = null;
  keepTabIn({ addEventListener: (t, f) => (handler = f), querySelectorAll: () => [first, summary, hidden] });
  const before = globalThis.document.activeElement;
  globalThis.document.activeElement = summary;
  let stopped = false;
  handler({ key: 'Tab', shiftKey: false, defaultPrevented: false, preventDefault: () => (stopped = true) });
  assert.equal(stopped, true, 'Tab on the summary goes round');
  assert.equal(globalThis.document.activeElement, first);
  globalThis.document.activeElement = before;
  assert.match(read('web/lib.js'), /keepTabIn\(sheetEl\)/, 'every sheet, Add provider among them');
  assert.match(read('web/tabwrap.js'), /dialog\.addEventListener\('keydown', \(e\) => \{\n\s+if \(e\.key !== 'Tab'/);
});

test('a schedule never says a provider\'s short name, also in the first moment after a load', async () => {
  const { providerWord } = await import('../../web/providerword.js');
  const profiles = [{ name: 'max', label: 'Claude Max' }];
  assert.equal(providerWord('max', profiles), 'Claude Max');
  assert.equal(providerWord('auto', undefined), 'Auto mode');
  assert.equal(providerWord('max', undefined), 'its provider', 'not known yet: never "max"');
  assert.equal(providerWord('gone', profiles), 'gone', 'a provider removed since: the name the schedule keeps');
  assert.match(read('web/providerword.js'), /off = store\.subscribe\(\(d\) => \{\n\s+if \(done \|\| !\(d && d\.profiles\)\) return;/, 'said again once the providers are known');
  assert.match(read('web/automation.js'), /const line = providerLine\(\(label\) => scheduleSentence\(s, label\)\);/, 'a schedule\'s row uses it');
});

test('rare things under a closed Advanced: Pause all automations, the map\'s list; Link now only where it belongs', () => {
  const au = read('web/automation.js');
  assert.doesNotMatch(au, /registerPage\(/, 'the automations have no page of their own: Pause all is not on every part');
  assert.match(au, /fold\('automations-advanced', 'Advanced', panel\(\{\}, pauseRow\(st, again\)\)\)/, 'it is under Settings → Automations → Advanced, on a card as the rules above it');
  assert.match(read('web/page-automations.css'), /@media \(pointer: coarse\) \{ \.au-inline \.btn \{ min-height: 44px;/, 'Resume is big enough for a finger');
  assert.match(au, /label: 'Resume', onclick: \(\) => saveSettings\(\{ paused: false \}\)/, 'while paused, the banner resumes with one tap');
  assert.match(read('web/workschedules.js'), /pausedBanner\(st, reload\)/, 'the banner shows on Work → Schedules too');
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

test('trust words: what Tia does with OpenCode, her client tools only while she is on, Hands off in the README', () => {
  // She starts and moves OpenCode chats now: no page says she works with Claude Code only.
  for (const f of ['web/codingtools.js', 'web/accounts.js']) {
    assert.doesNotMatch(read(f), /and Tia work with Claude Code only/, f);
    assert.match(read(f), /every OK of one comes to you/, f);
  }
  // Her tools for the owner's own Claude Code answer only while she is on: the page offers no token while she is off.
  assert.match(read('web/tia.js'), /s\.enabled \? null : h\('p\.hint\.tia-client-off'/);
  assert.match(read('web/tia.js'), /s\.enabled && btn\('secondary', \{ icon: 'key'/);
  const readme = read('README.md');
  assert.match(readme, /while she is on, your own Claude Code can use the same tools/);
  // "Whatever costs money … is a card" holds except where the owner chose otherwise, which the README says next.
  assert.match(readme.replace(/\s+/g, ' '), /is a card too\. Money has exceptions you choose\. Within the \*\*Daily limit for paid use \(US \$\)\*\*/);
  // The AI brain page's button is "Link" (Link now is Get started's and Skills').
  assert.match(readme, /\(or \*\*Link\*\* on the AI brain page\)/);
});

test('Settings → Workspace: the map is kept by itself only while its switch is on and nothing is paused, and the card follows the switch', async () => {
  const { mapKept } = await import('../../web/workspace.js');
  assert.equal(mapKept({ settings: {} }), true, 'on by default');
  assert.equal(mapKept({ settings: { workspace: { map: false } } }), false);
  assert.equal(mapKept({ settings: { workspace: { map: true }, paused: true } }), false, 'paused: the upkeep does not run');
  assert.equal(mapKept({ settings: { workspace: { map: true } } }, false), false, 'the switch as just saved wins');
  assert.equal(mapKept({ settings: { workspace: { map: false } } }, true), true);
  assert.equal(mapKept(null), false, 'automations not readable: "Update the map" stays first');
  const ws = read('web/workspace.js');
  assert.match(ws, /onMap\(v\); \/\/ the map's own card/, 'switching it repaints the map card without a reload');
  assert.match(ws, /autoPanel\(paintMap\)/);
});

test('a phone with the floating button: a switch on a card stops left of it, beside its label', () => {
  const css = read('web/style.css');
  const phone = css.slice(css.indexOf('/* A phone with the floating button'));
  assert.match(phone, /body\.has-fab \.card \.switchrow \{ padding-right: max\(0px, calc\(var\(--fab-w, 150px\) - 10px\)\); align-items: flex-start; \}/);
});

test('Settings → Network on a server: an open dashboard is a warning with the fix, never "not opened here"', async () => {
  const { networkWords } = await import('../../web/settings.js');
  const server = { why: 'this is a server (reached over ssh, with no desktop of its own)', ways: [], forward: '' };
  for (const host of ['0.0.0.0', '::', '10.0.0.5']) {
    const w = networkWords({ network: { host, port: 7433, server } });
    assert.match(w.warn, /^Open to the network on plain http: this is a server .* Close it on the computer: hoprig setup --access local$/, host);
    assert.equal(w.address, 'Open to the internet on plain http.');
    assert.doesNotMatch(`${w.address} ${w.lead}`, /Not opened to the network here|Other devices on the network/, host);
  }
  const closed = networkWords({ network: { host: '127.0.0.1', port: 7433, server } });
  assert.equal(closed.warn, null);
  assert.match(closed.lead, /^Not opened to the network here: this is a server/);
  const home = networkWords({ network: { host: '0.0.0.0', port: 7433 } });
  assert.equal(home.warn, null, 'a desktop at home: as before');
  assert.equal(home.address, 'Other devices on the network can open the page.');
});

test('Work → Schedules: the queue heading has no count to show, and the bypass warning shows only while it is chosen', () => {
  const ws = read('web/workschedules.js');
  assert.doesNotMatch(ws, /groupHead\('Queued messages', null\)/, 'a heading with no count never says "null"');
  const au = read('web/automation.js');
  assert.match(au, /const bypass = a\.mode === 'bypassPermissions' \? h\('p\.banner\.warn/, 'the warning is made only when bypass is chosen');
  assert.doesNotMatch(au, /bypass\.hidden/, 'a banner\'s display beats `hidden`: it was shown while unticked');
});

test('a schedule row says when and where it runs in full on a phone: its line under the sentence wraps', () => {
  assert.match(read('web/page-automations.css'), /\.au-sched-main \.row-sub \{ white-space: normal; overflow-wrap: anywhere; \}/, 'not cut to "on this com…" at 390 px');
});

test('the sign-in page: a wrong password says where the way in without one is', () => {
  const login = read('web/login.js');
  assert.match(login, /r\.status === 401 \? ` \$\{NO_PASSWORD_WAY\}`/, 'said under a wrong password');
  const way = /NO_PASSWORD_WAY = '([^']+)'/.exec(login);
  assert.ok(way, 'the line is there');
  assert.match(way[1], /Settings → Security and sign-in/);
  assert.match(way[1], /Show a sign-in code/);
  assert.ok(read('web/settings.js').includes("title: 'Security and sign-in'"), 'the page it names is called that');
  assert.ok(read('web/computers.js').includes("label: 'Show a sign-in code'"), 'the button it names is called that');
});

test('words: the git step, its rows and its sheets never say commit, push or upstream', () => {
  // Every string of the module (not its comments): what a person reads on the rows and in the sheets.
  const src = read('web/gitsetup.js');
  const strings = src.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
  assert.ok(strings.length > 50, 'the strings were found');
  for (const s of strings) assert.doesNotMatch(s, /\bcommits?\b|\bpush|upstream/i, s);
});

test('words: "provider" is the AI account only; a server is rented from a company', () => {
  for (const file of ['web/computers.js', 'web/sshkey.js', 'src/machines/keyadd.mjs']) {
    assert.doesNotMatch(read(file), /server\\?'s provider|its provider gave|provider gives? you/, file);
  }
  // The first way to add a computer: its line says the same as its title (at home or behind a router).
  assert.match(read('web/computers.js'), /value: 'join', title: 'It is at home or behind a router[^']*', sub: 'A laptop or another computer of yours, at home or anywhere else: /);
});
