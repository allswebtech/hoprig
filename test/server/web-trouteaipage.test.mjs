// TRouteAI's own page (web/trouteaipage.js, #/providers/trouteai): the order of its parts, what the first phone screen
// holds, that Stop and Remove are only inside Manage, that every press asks and names the computer, and the small words
// the page computes (a compact account line, the public address's refusals).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => t, getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const page = read('trouteaipage.js');
const { publicNeed, PUBLIC_SENTENCE, ROWS_SHOWN, GATEWAY_NEEDS } = await import('../../web/trouteaipage.js');
const { GATEWAY_NEEDS: SERVER_NEEDS, GATEWAY_PIN } = await import('../../src/addons/gateways.mjs');
const { publicOffWords } = await import('../../web/trouteai.js');

test('the parts come in the order of the design: status, problem, Open, Accounts, Add account, then the folds', () => {
  const run = page.slice(page.indexOf('const parts = [statusLine'));
  const at = (s) => run.indexOf(s);
  const order = ['statusLine(ctx, gw, others)', 'const problem', "'Open TRouteAI'", 'accountsPart(ctx, accounts.accounts, limits)', "label: 'Add account'", 'combosPart(', 'pubFold);', 'sharing(gw, load', 'manageFold(ctx, gw));\n    fill(body'];
  let last = -1;
  for (const s of order) {
    assert.ok(at(s) > last, `${s} comes after the part before it`);
    last = at(s);
  }
});

test('the first phone screen holds five things: status, Open, Accounts, Add account, the top of the first fold', () => {
  // Everything before the first fold is these four; the folds all start closed (shell.fold remembers a person's own choice).
  const before = page.slice(page.indexOf("h('div.tr-open'"), page.indexOf('combosPart('));
  assert.equal((before.match(/btn\('primary block'/g) || []).length, 1, 'one Open button');
  assert.equal((before.match(/label: 'Add account'/g) || []).length, 1);
  assert.equal(ROWS_SHOWN, 5, 'at most five rows, then All N accounts');
  assert.match(page, /All \$\{accounts\.length\} accounts/);
});

test('Stop and Remove are only inside the Manage fold, never on the first screen', () => {
  const manage = page.slice(page.indexOf('function manageFold'), page.indexOf('/** The status line'));
  assert.match(manage, /manageRow\('stop', 'Stop'/);
  assert.match(manage, /manageRow\('trash', 'Remove TRouteAI'/);
  const outside = page.replace(manage, '');
  assert.doesNotMatch(outside, /label: 'Stop'|label: 'Remove TRouteAI'|stopIt\(ctx\)|removeIt\(ctx\)/);
  // Remove is last in Manage, and its own colour says it is dangerous.
  assert.ok(manage.indexOf("'Remove TRouteAI'") > manage.indexOf("'Stop'"));
  assert.match(manage, /'\.tr-danger'/);
});

test('the folds are closed at first and nothing polls', () => {
  assert.doesNotMatch(page, /setInterval|setTimeout/);
  for (const key of ['trouteai-public', 'trouteai-manage']) assert.match(page, new RegExp(`fold\\('${key}'`));
  assert.match(read('shell.js'), /prefs\.get\(`fold\.\$\{key\}`, false\)/);
});

test('each state of the page: not set up, not running, running with a problem', () => {
  assert.match(page, /TRouteAI is not set up on this computer\./);
  assert.match(page, /setupBlock\(mine, \{ done: load \}\)/, 'not set up: the one-press set-up is all that shows');
  assert.match(page, /'Not running'/);
  assert.match(page, /label: 'Start'/);
  assert.match(page, /g\.problem \? btn\('small secondary', \{ label: 'Update'[^]*label: 'Restart'/, 'a problem line has its one button');
  assert.match(page, /label: 'Use it for my sessions'/);
});

test('an account row keeps Test, Turn off or on and Remove on the row itself, with its limits', () => {
  const src = read('trouteai.js');
  const row = src.slice(src.indexOf('export function accountRow'), src.indexOf('/** The keys Hoprig made'));
  for (const w of ["label: 'Test'", "a.on ? 'Turn off' : 'Turn on'", "label: 'Remove'", 'lim.windows.map(limitLine)', '/remove`']) assert.ok(row.includes(w), w);
  assert.doesNotMatch(row, /openSheet/, 'no sheet between the row and its buttons');
  assert.match(read('trouteaipage.js'), /accountRow\(a, limits && limits\[a\.id\], ctx, ctx\.reload\)/);
});

test('every refusal of the public address has one sentence and at most one press', () => {
  const need = (n, extra = {}) => publicNeed({ need: n, hostname: 'tai-pc.example.com', ...extra });
  // Each says the one thing to do in Settings, Public link, and has the one press that opens it.
  assert.deepEqual(need('link-custom'), ['Hoprig\'s public link is not a Custom one yet. In Settings, Public link, choose Custom (your own domain on a named tunnel), then come back here.', 'settings']);
  assert.deepEqual(need('link-off'), ['Hoprig\'s public link is off. In Settings, Public link, turn it on, then come back here.', 'settings']);
  // A tunnel token: the server's own sentence says why the address cannot be made from here.
  assert.match(need('link-custom', { why: 'With a tunnel token the names are set in the Cloudflare dashboard, so TRouteAI\'s address cannot be made from here. Set up Hoprig\'s public link as Custom first (Settings, Public link).' })[0], /^With a tunnel token/);
  assert.deepEqual(need('first-password'), ['TRouteAI still uses its first password. Set your own first.', 'password']);
  assert.deepEqual(need('no-password'), ['TRouteAI has no password. Set one first.', 'password']);
  assert.deepEqual(need('open-api'), ['TRouteAI answers its model address without a key, so it stays private.', null]);
  assert.deepEqual(need('not-running'), ['Start TRouteAI first.', 'start']);
  assert.match(need('dns-taken')[0], /already a DNS record for tai-pc\.example\.com in Cloudflare\. Delete it there first\./);
  assert.match(PUBLIC_SENTENCE, /^Anyone on the internet can then reach two things at this address/);
});

test('switching the public address on or off asks first, names what becomes reachable, and puts the switch back on a no', () => {
  const f = page.slice(page.indexOf('function publicFold'), page.indexOf('/** A row of the Manage fold'));
  assert.match(f, /Open TRouteAI to the internet\?/);
  assert.match(f, /Close TRouteAI to the internet\?/);
  assert.match(f, /\$\{PUBLIC_SENTENCE\} TRouteAI restarts once/);
  assert.equal((f.match(/input\.checked = !want/g) || []).length, 2, 'a cancel and a failure both put the switch back');
  assert.match(f, /api\(T\('\/public'\), \{ confirm: ctx\.computer, on: want \}\)/);
  assert.match(f, /Its DNS record stays in Cloudflare/);
});

test('a page that is not on this computer says where TRouteAI opens until the public address is on', () => {
  assert.match(publicOffWords({ computer: 'pc', port: 20017 }), /^TRouteAI opens from here once its public address is on \(Public address, below\)\. On pc itself it opens at http:\/\/127\.0\.0\.1:20017\/\.$/);
  const t = read('trouteai.js');
  // No tab is opened; the line comes with a press that goes to the Public address fold.
  assert.match(t, /if \(!onThatComputer && !state\.publicUrl\) return hint\(publicOffWords\(state\), state\.goPublic \? btn\('small secondary', \{ label: 'Go to Public address', onclick: state\.goPublic \}\) : null\);/);
});

test('Settings, Public link shows the name of TRouteAI as turned on and off on its page, with no Remove', () => {
  const pl = read('publiclink.js');
  assert.match(pl, /x\.gateway === 'trouteai' \? h\('div\.addon-svc'[^]*TRouteAI · turned on and off on its page[^]*#\/providers\/trouteai/);
});

test('the provider list of the Add sheet says how each signs in, never the gateway\'s own category word', () => {
  const src = read('trouteai.js');
  assert.doesNotMatch(src, /row-sub', p\.category/, 'a raw word such as no-auth is not for a person');
  assert.match(src, /'api-key': 'Sign in with a key'/);
});

test('a gateway that runs but does not answer is not asked for its accounts: one line and Manage instead', () => {
  const at = page.indexOf('gw && gw.running === false');
  assert.ok(at > 0, 'the guard is there');
  assert.ok(at < page.indexOf("api(T('/accounts'))"), 'before the accounts are asked');
  assert.match(page.slice(at, at + 400), /does not answer yet[^]*manageFold\(ctx, gw\)\);\s*return fill/);
});

test('what needs a newer TRouteAI says so plainly, with Update beside it, and the page names the same version as the server', () => {
  assert.equal(GATEWAY_NEEDS, SERVER_NEEDS, 'the page and the server name one version');
  assert.equal(GATEWAY_NEEDS, GATEWAY_PIN, 'the version Install gets has what the page needs');
  const [sentence, kind] = publicNeed({ need: 'gateway-old' });
  assert.equal(kind, 'update');
  assert.match(sentence, /needs TRouteAI 1\.0\.13/);
  assert.match(page, /kind === 'update' \? btn\('secondary', \{ icon: 'download', label: 'Update'/, 'the refusal has its Update press');
  assert.match(page, /\} else if \(g\.newer\) \{[^]*A newer TRouteAI is there\.[^]*label: 'Update'/, 'an own copy older than the pin: one line and the existing Update, nothing run');
  const sheet = read('trouteai.js');
  assert.match(sheet, /catalog\.needs && state\.update[^]*label: 'Update'/, 'the Add sheet offers Update when the list needs a newer one');
  assert.match(sheet, /r\.needs && state\.update \? btn\('small secondary', \{ label: 'Update'/, 'Open signed in offers Update beside its line');
});
