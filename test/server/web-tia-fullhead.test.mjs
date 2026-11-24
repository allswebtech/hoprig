// While Full administrator rights are on, Tia's own page says so in its head — on every tab, always,
// not only in Settings. web/tia.js fullHeadBanner(level) is that head banner; it is null at Off and at Ask (where
// his tap still comes before each command) and a plain warning that points to the setting at Full.
import assert from 'node:assert/strict';
import test from 'node:test';

// Just enough of a browser for the module to load (the same stand-in as web-words.test.mjs).
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

const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const words = (n) => texts(n).join('');
const find = (n, pred) => {
  if (n instanceof FakeElement && pred(n)) return n;
  for (const c of n.children || []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
};

const { fullHeadBanner } = await import('../../web/tia.js');

test('at Full the head banner says Full is on, that commands run with no card, and links to the setting', () => {
  const b = fullHeadBanner('full');
  assert.ok(b, 'a banner is returned at Full');
  assert.ok(b.className.split(' ').includes('tia-full-head'), 'it carries the tia-full-head class');
  assert.ok(b.className.includes('banner') && b.className.includes('warn'), 'it is a warning banner');
  const t = words(b);
  assert.match(t, /Full administrator rights are on\./);
  assert.match(t, /no card/, 'it says the commands run with no card');
  const link = find(b, (el) => el.tag === 'a');
  assert.ok(link, 'it holds a link');
  assert.equal(link.attrs.href, '#/settings/tia', 'the link goes to Settings → Tia');
});

test('at Off, at Ask, and when the level is not known the head banner is absent', () => {
  for (const level of ['off', 'ask', null, undefined, '']) {
    assert.equal(fullHeadBanner(level), null, `no banner at ${JSON.stringify(level)}`);
  }
});

test('Settings → Tia says that a session she started stays hers, as the docs do', async () => {
  const fs = await import('node:fs');
  const tia = await import('../../web/tia.js');
  assert.match(tia.STAYS_HERS || '', /^A session Tia started stays hers until it ends, also when you type into it yourself/);
  const src = fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');
  const rights = src.slice(src.indexOf('function tiaRights('), src.indexOf('// ---------- Settings → Tia ----------'));
  assert.match(rights, /h\('p\.hint\.tia-rights-stays', STAYS_HERS\)/, 'the rights section paints the sentence');
  // The hold is the coding tool's own "wait for yes" in the session, not a card on this page: the sentence says so and
  // no longer calls two different things "the same card".
  assert.match(tia.STAYS_HERS, /waits for your yes/, 'it says the session waits for his yes');
  assert.doesNotMatch(tia.STAYS_HERS, /the same card as what she runs/, 'it drops the ambiguous "card" wording');
  const doc = fs.readFileSync(new URL('../../docs/OPERATOR.md', import.meta.url), 'utf8');
  assert.match(doc, /A session of hers stays hers until it ends/, 'the docs say the same');
});

test('Settings → Tia states the limit for the coding tools Hoprig cannot hold, next to the level', async () => {
  const fs = await import('node:fs');
  const tia = await import('../../web/tia.js');
  // What the hook does not read (a script or another program the session starts), and the coding tools it cannot hold:
  // refused below Full (src/codetools/start.mjs), unheld at Full.
  assert.match(tia.TOOLS_UNHELD || '', /OpenCode/, 'it names the coding tool');
  assert.match(tia.TOOLS_UNHELD, /What a script or another program started there then does is not read/, 'it says what is not read');
  assert.match(tia.TOOLS_UNHELD, /not against a session that hides what it does/, 'it says what it does not protect against');
  assert.match(tia.TOOLS_UNHELD, /below Full she cannot start a session on them/, 'it says such a start is refused below Full');
  assert.match(tia.TOOLS_UNHELD, /change to Hoprig's own settings runs there with no card/, 'it warns what runs unheld at Full');
  assert.doesNotMatch(tia.TOOLS_UNHELD, /not bound by this level/, 'the stale words of before the refusal are gone');
  const src = fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');
  const rights = src.slice(src.indexOf('function tiaRights('), src.indexOf('// ---------- Settings → Tia ----------'));
  assert.match(rights, /h\('p\.hint\.tia-rights-stays', TOOLS_UNHELD\)/, 'the rights section paints the limit');
});

test('the git sign-in limit sits with the chosen token, not where no file is chosen', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');
  const rights = src.slice(src.indexOf('function tiaRights('), src.indexOf('// ---------- Settings → Tia ----------'));
  // "this token protects against a mistake" goes with the chosen-file line (where "this token" has a referent).
  assert.match(rights, /this token protects against a mistake/, 'the limit is stated with the chosen token');
  // The dangling "so this protects …" of the no-file state, where nothing was chosen to point at, is gone.
  assert.doesNotMatch(rights, /so this protects against a mistake/, 'no dangling limit in the no-file state');
});

test('wherever Full is described, the page says what Full does not lift', async () => {
  const fs = await import('node:fs');
  const tia = await import('../../web/tia.js');
  assert.match(tia.FULL_KEEPS || '', /a delete as administrator outside the session's own folder, a push to the main branch, a release and a change to Hoprig's own folders never run without you/);
  assert.match(tia.TOOLS_UNHELD || '', /nothing holds such a session: a delete as administrator outside the session's own folder, a push to the main branch/);
  const src = fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');
  assert.match(src, /full: \['Full', `[^`]*\$\{FULL_KEEPS\}/, 'the words under Full say it');
  // While Full is on, Full is the level chosen, so the words under it say it there; the banner above does not repeat it.
  assert.match(src, /'p\.banner\.warn\.tia-rights-full'/, 'the Full-is-on line is a banner of its own');
});

// src/hook.mjs herHeld keeps every act the wall holds in a session of hers; at Full it lifts only the administrator
// acts. So the sentence names each kind of src/wall.mjs WALL_TITLE, and the administrator one below Full only.
test('the sentence on a session she started names every act the wall keeps for him', async () => {
  const tia = await import('../../web/tia.js');
  const { WALL_TITLE } = await import('../../src/wall.mjs');
  const SAID = {
    admin: /below Full, an administrator command/,
    release: /a release/,
    pr: /a pull request/,
    push: /a push or a merge into the main branch/,
    merge: /a merge into the main branch/,
    'delete outside': /a delete outside the session's folder/,
    deploy: /a deploy/,
    project: /a change to project\.json/,
    settings: /Hoprig's own files/,
    unreadable: /a line Hoprig cannot read/,
    'api-write': /a direct call to GitHub or GitLab that can change something there/,
  };
  const kinds = Object.keys(WALL_TITLE).filter((k) => !/^(push|merge)-/.test(k));
  for (const k of kinds) {
    assert.ok(SAID[k], `a kind of the wall the sentence does not know: ${k}`);
    assert.match(tia.STAYS_HERS, SAID[k], `the sentence names ${k}`);
  }
});

// src/assistant/herrights.mjs herRightsLevel: no stored level reads Off (an install); Off and Ask do not depend on the
// version; Full chosen under another version reads Ask. So an update does not leave Off: it keeps what was chosen.
test('the words under Off say what an install and an update leave, as herRightsLevel reads them', async () => {
  const fs = await import('node:fs');
  const { herRightsLevel } = await import('../../src/assistant/herrights.mjs');
  assert.equal(herRightsLevel({}, '1.0.0'), 'off', 'an install leaves Off');
  assert.equal(herRightsLevel({ server: { herRights: { level: 'ask', version: '0.9.0' } } }, '1.0.0'), 'ask', 'an update keeps Ask');
  assert.equal(herRightsLevel({ server: { herRights: { level: 'full', version: '0.9.0' } } }, '1.0.0'), 'ask', 'an update turns Full into Ask');
  const src = fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');
  const off = (src.match(/^ {2}off: \['Off', '([^']*)'\]/m) || [])[1] || '';
  assert.match(off, /This is the default, and what an install leaves; an update keeps Off and Ask each time, and turns Full into Ask each time\./);
  assert.doesNotMatch(off, /what an update leaves/, 'an update does not leave Off');
});

// A shop owner who never opened a terminal picks a level from one short plain line each; the git, hook and coding-tool
// details stay on the page, folded under them.
test("each administrator level has one short plain line, and the technical details are folded", async () => {
  const fs = await import("node:fs");
  const tia = await import("../../web/tia.js");
  assert.deepEqual(Object.keys(tia.RIGHTS_SHORT || {}), ["off", "ask", "full"], "one line per level");
  for (const line of [...Object.values(tia.RIGHTS_SHORT), tia.STAYS_SHORT || ""]) {
    assert.ok(line && line.split(" ").length <= 20, line);
    assert.doesNotMatch(line, /sudo|hook|project\.json|Codex|OpenCode|below Full|merge/, line);
  }
  const src = fs.readFileSync(new URL("../../web/tia.js", import.meta.url), "utf8");
  const rights = src.slice(src.indexOf("function tiaRights("), src.indexOf("// ---------- Settings → Tia ----------"));
  assert.match(rights, /levels\.map\(\(l\) => h\('li\.hint', h\('strong', \`\$\{RIGHTS_WORDS\[l\]\[0\]\}: \`\), RIGHTS_SHORT\[l\]\)\)/, "every level offered gets its line");
  assert.match(rights, /fold\('tia-rights-level-more', [^)]*levelHelp\)/, "the long text of the chosen level is folded");
  assert.match(rights, /fold\('tia-rights-stays-more', '[^']*',\s*h\('p\.hint\.tia-rights-stays', STAYS_HERS\),\s*h\('p\.hint\.tia-rights-stays', TOOLS_UNHELD\)\)/, "the session details are folded, nothing taken away");
});
