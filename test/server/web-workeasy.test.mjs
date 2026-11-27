// Work for a person who is not a programmer (web/workitems.js, web/work.js, web/workdo.js, web/workplans.js,
// web/automation.js, web/page-work.css): the plain defaults and words, with a small stand-in for the browser DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

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
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn({ target: this });
  }
  // A sheet's dialog: it opens, and a close is reported as a browser does.
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.fire('close');
  }
  querySelector() {
    return null;
  }
  remove() {}
  append(...n) {
    for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x)));
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
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
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

const { newTaskProject, whoHint } = await import('../../web/workitems.js');
const { saveBand } = await import('../../web/work.js');
const { optionsLine } = await import('../../web/workdo.js');
const { unitTitle } = await import('../../web/workpulse.js');
const { planMissing } = await import('../../web/workpropose.js');
const { activityLine, scheduleSentence } = await import('../../web/automation.js');

test('a new task: the project known from the filter or the only project; Who does it stays Me, with one line once a project is chosen', () => {
  assert.equal(newTaskProject({ projects: ['shop', 'alpha'], project: 'alpha' }), 'alpha');
  assert.equal(newTaskProject({ projects: ['shop'], project: '' }), 'shop');
  assert.equal(newTaskProject({ projects: ['shop', 'alpha'], project: '' }), '');
  assert.equal(whoHint({ project: 'shop', by: 'me' }), 'To have the AI do it, choose The AI.');
  assert.equal(whoHint({ project: '', by: 'me' }), '');
  assert.equal(whoHint({ project: 'shop', by: 'ai' }), '');
  const items = read('workitems.js');
  assert.match(items, /by: it \? it\.by : 'me'/, 'the default stays Me: nothing runs by itself');
});


test('the band over Work: the list is saved on this computer, a copy goes to the AI brain; no band without a git server; no git words', () => {
  const plan = (x = {}) => ({ files: ['work/tasks.json'], changes: [{ what: 'added', title: 'Renew' }], runs: 0, plans: 0, unsent: { saves: 0, others: [] }, repo: { name: 'ai_brain', branch: 'main', upstream: 'origin/main' }, ...x });
  const b = saveBand(plan(), { kind: 'brain', label: 'ai_brain/work' });
  assert.equal(b.text, 'Your list is saved on this computer.');
  assert.equal(b.label, 'Keep a copy in your AI brain');
  assert.equal(saveBand(plan(), { kind: 'project', project: 'shop', label: 'shop/work' }).label, 'Keep a copy in shop');
  assert.equal(saveBand(plan({ repo: { name: 'ai_brain', branch: 'main', upstream: null } }), { kind: 'brain' }), null, 'no server: no band');
  assert.equal(saveBand(plan({ repo: null }), { kind: 'brain' }), null);
  const quiet = saveBand(plan({ files: [], unsent: { saves: 2, others: [] } }), { kind: 'brain' });
  assert.ok(quiet.quiet);
  for (const w of [b.text, b.label, quiet.text, quiet.label]) assert.doesNotMatch(w, /\b(git|commit|commits|push|upstream)\b/i, w);
  const src = read('work.js');
  assert.doesNotMatch(src, /not saved in git yet/, 'the old band words are gone');
});

test('the Do it sheet: Folder, Coding tool, Provider, Model and Effort folded under Options, with one line of what is chosen', () => {
  const p = { project: 'shop', folder: '.', tool: 'claude', provider: 'auto', tools: [{ id: 'claude', name: 'Claude Code' }, { id: 'opencode', name: 'OpenCode' }],
    providers: [{ name: 'auto', label: 'Auto mode' }, { name: 'key', label: 'An API key' }], folders: [{ value: '.', label: 'shop' }, { value: 'web', label: 'shop/web' }] };
  assert.equal(optionsLine(p), 'Claude Code on Auto mode');
  assert.equal(optionsLine(p, { provider: 'key', tool: 'opencode' }), 'OpenCode on An API key');
  assert.equal(optionsLine(p, { folder: 'web' }), 'Claude Code on Auto mode, in shop/web');
  assert.equal(optionsLine({ ...p, provider: null }), 'Claude Code: choose a provider');
  const src = read('workdo.js');
  const at = src.indexOf("options(p, v, project, folder,");
  assert.ok(at > 0, 'the sheet folds its options');
  const folded = src.slice(at, src.indexOf('elsewhere,', at));
  for (const label of ["select('Folder'", "select('Coding tool'", "select('Provider'", 'modelPicker(', "select('Effort'"]) assert.ok(folded.includes(label), `${label} is under Options`);
  assert.match(src, /nothing is pushed or merged by this/, 'the last line stays');
});

test('Progress: a chat\'s row is titled by the chat\'s title, a terminal session keeps its folder, so two rows never read alike', () => {
  const sessions = [{ kind: 'chat', sessionId: 'c0ffee00-1111-4222-8333-444455556666', display: 'Fix the cart total with a discount' }, { kind: 'terminal', name: 'shop-frontend', sessionId: 'aaaa' }];
  const chat = { id: 'session:c0ffee00-1111-4222-8333-444455556666', type: 'session', title: 'A session in shop-frontend', project: 'shop-frontend' };
  const term = { id: 'session:aaaa', type: 'session', title: 'A session in shop-frontend', project: 'shop-frontend' };
  assert.equal(unitTitle(chat, sessions), 'Fix the cart total with a discount');
  assert.equal(unitTitle(term, sessions), 'A session in shop-frontend');
  assert.equal(unitTitle({ id: 'run:1', type: 'run', title: 'Renew' }, sessions), 'Renew');
  assert.match(fs.readFileSync(new URL('../../web/workpulse.js', import.meta.url), 'utf8'), /h\('span\.row-title', unitTitle\(u\)/, 'the row uses it');
});

test('Plan with AI: the line at the bottom names every missing thing, and Plan waits for both the project and the AI account', () => {
  assert.equal(planMissing(null, null), 'Choose the project the goal is about and a provider.');
  assert.equal(planMissing('shop', null), 'Choose a provider.');
  assert.equal(planMissing(null, 'auto'), 'Choose the project the goal is about.');
  assert.equal(planMissing('shop', 'auto'), '');
  const src = read('workpropose.js');
  assert.match(src, /disabled: !project \|\| !\(v\.provider \|\| c\.provider\)/, 'the button says why it is grey: both are named');
  assert.match(src, /h\('span\.wk-left\.wk-plan-missing', planMissing\(project, v\.provider \|\| c\.provider\)\)/);
});

test('a schedule\'s sentence says the AI works in a separate copy, not on a branch', () => {
  const t = scheduleSentence({ when: { kind: 'daily', time: '09:00' }, action: { type: 'alone', project: 'shop', minutes: 30, tell: 'report' } }, (n) => n, (n) => n);
  assert.match(t, /in shop in a separate copy, so your project is not changed until you accept, for at most 30 minutes/);
  assert.doesNotMatch(t, /branch/);
});

test('at 600 px and less the Work tabs are one row that scrolls sideways, never rows of a grid', () => {
  const css = read('page-work.css');
  const rules = css.split('@media').filter((b) => /\.wk-tabs\s*\{/.test(b));
  const phone = rules.find((b) => /^\s*\(max-width: 600px\)/.test(b));
  assert.ok(phone, 'a rule for 600 px and less');
  assert.match(phone, /\.wk-tabs \{[^}]*flex-wrap: nowrap[^}]*overflow-x: auto/);
  assert.doesNotMatch(css, /\.wk-tabs \{[^}]*display: grid/, 'no grid of tabs at any width');
});

test('a sentence on Work\'s and Schedules\' files that names another place opens it: a link beside the words', () => {
  const l = activityLine({ did: 'the map gained shop', outcome: "ok (not saved in the brain's history: the commitMap switch is off)", automation: 'map', time: '2026-11-20T10:00:00Z' });
  assert.equal(l.to && l.to.href, '#/settings/workspace', 'the activity line that names Settings → Workspace opens it');
  const auto = read('automation.js');
  assert.doesNotMatch(auto, /add one under Providers\.'/, 'no "add one under Providers" in words only');
  assert.equal((auto.match(/add one under ', h\('a', \{ href: link\('#\/providers'\) \}, 'Providers'\)|add one under `, h\('a', \{ href: link\('#\/providers'\) \}, 'Providers'\)/g) || []).length, 2);
  assert.match(auto, /h\('a', \{ href: link\('#\/settings\/updates'\) \}, 'Settings → Version and updates'\)/);
  const doit = read('workdo.js');
  const back = doit.slice(doit.indexOf('export async function sendBack'));
  assert.match(back.slice(0, 600), /h\('a', \{ href: link\('#\/skills\/learned'\) \}, 'Skills → Learned'\)/, 'Send back\'s learning line links Skills → Learned');
});

test('Progress is drawn again when the chats\' titles arrive after it, so a chat\'s row is never left as "A session in …"', () => {
  const src = read('workpulse.js');
  const body = src.slice(src.indexOf('export async function paintProgress'), src.indexOf('export function needsNoneWords'));
  assert.match(body, /store\.subscribe\(/, 'it listens to the store');
  assert.match(body, /if \(now === seen\) return;/, 'only when the chats\' titles changed');
  assert.match(body, /slot\.isConnected === false\) return off && off\(\)/, 'it stops once its slot left the page');
});
