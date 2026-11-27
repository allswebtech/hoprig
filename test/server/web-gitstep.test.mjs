// Get started's "Git and GitHub set up" is about set-up only: the name and e-mail, the GitHub sign-in, the AI brain on
// a git server with its branch followed. Files of the brain not saved yet, commits to upload or to get are daily work
// (a session writes a memory, Hoprig adds a skill): they never open the step again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// A small stand-in for the browser DOM: what the page modules touch when they load.
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
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  // What a sheet (a dialog) needs of an element: opened and closed as the browser does, with its close event.
  get classList() {
    return { add() {}, remove() {}, toggle() {} };
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    if (this.listeners.close) this.listeners.close();
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  remove() {}
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { gitDone } = await import('../../web/gitsetup.js');
const { withGitStep } = await import('../../web/getstarted.js');
const setUp = { git: true, identity: { set: true, name: 'Alex', email: 'alex@example.invalid' }, gh: { installed: true, signedIn: true, account: 'alex-demo' }, brain: { exists: true, git: true, remote: 'https://git.example.test/team/ai_brain.git', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0 } };
const onb = { steps: [{ id: 'claude', done: true }], done: 1, total: 1 };
const brain = (b) => ({ ...setUp, brain: { ...setUp.brain, ...b } });

const { brainDaily, gitRows, rowAction, openGitSetup } = await import('../../web/gitsetup.js');

test('changed files, commits to upload and commits to get leave the set-up step done', () => {
  for (const b of [{ changes: 6 }, { ahead: 2 }, { behind: 3 }, { ahead: 1, behind: 1, changes: 4 }]) {
    assert.equal(gitDone(brain(b)), true, JSON.stringify(b));
    const step = withGitStep(onb, brain(b)).steps.find((s) => s.id === 'git');
    assert.equal(step.done, true, JSON.stringify(b));
    assert.equal(step.action, null, 'no button on a done step');
    assert.doesNotMatch(step.detail, /changed|upload|to get|in step/);
  }
  assert.equal(withGitStep(onb, brain({ changes: 6 })).done, onb.done, 'an optional step: the count of required steps does not move');
});

test('the step is open only for what set-up lacks, and names only that', () => {
  const cases = [
    [{ ...setUp, identity: { set: false, name: '', email: '' } }, /name and e-mail/],
    [{ ...setUp, gh: { installed: true, signedIn: false, account: null } }, /signed in to GitHub: not signed in/],
    [brain({ remote: null, upstream: null }), /not on a git server/],
    [brain({ upstream: null }), /not linked to its copy on your git server yet/],
  ];
  for (const [g, why] of cases) {
    assert.equal(gitDone(g), false, JSON.stringify(g));
    const step = withGitStep(onb, { ...g, brain: { ...g.brain, changes: 6 } }).steps.find((s) => s.id === 'git');
    assert.equal(step.done, false);
    assert.match(step.detail, why);
    assert.doesNotMatch(step.detail, /not saved|uploaded/, 'the files not saved are not a set-up gap');
  }
});

test('the brain row says its daily state in plain words, one kind of button each', () => {
  assert.deepEqual(brainDaily({ changes: 4 }), { kind: 'save', text: '4 files are not saved to your git server yet' });
  assert.deepEqual(brainDaily({ changes: 1 }), { kind: 'save', text: '1 file is not saved to your git server yet' });
  assert.deepEqual(brainDaily({ ahead: 2 }), { kind: 'save', text: '2 saved changes are not uploaded to your git server yet' });
  assert.equal(brainDaily({ behind: 1 }).kind, 'get');
  assert.equal(brainDaily({ ahead: 1, behind: 1, changes: 3 }).kind, 'both', 'both sides moved: said, nothing saved over the other');
  assert.match(brainDaily({ ahead: 1, behind: 1 }).text, /Nothing is saved over the other: Sync on the Workspace page says what to do/);
  assert.deepEqual(brainDaily({}), { kind: 'fine', text: 'Everything is saved on your git server' });
  const row = gitRows(brain({ changes: 4 }))[2];
  assert.deepEqual([row.ok, row.daily, row.text], [false, 'save', '4 files are not saved to your git server yet']);
});

test('every row that is not fine has a button or a sentence of what to do', () => {
  const states = [
    { ...setUp, git: false, identity: { set: false } },
    { ...setUp, gh: { installed: false, signedIn: false, account: null } },
    { ...setUp, gh: { installed: true, signedIn: false, account: null }, brain: { exists: true, git: true, remote: null } },
    brain({ exists: false, git: false, remote: null, upstream: null }),
    brain({ git: false, remote: null, upstream: null }),
    brain({ upstream: null }),
    brain({ changes: 3 }), brain({ ahead: 1 }), brain({ behind: 2 }), brain({ ahead: 1, behind: 2 }),
  ];
  // The rows the panel gives a button (web/gitsetup.js gitPanel actionOf): the rest must say what to do in words.
  const hasButton = (r, g) => !!rowAction(r, g);
  for (const g of states) {
    for (const r of gitRows(g).filter((x) => !x.ok)) {
      assert.ok(hasButton(r, g) || /: .+/.test(r.text), `${r.id} "${r.text}" has neither a button nor what to do`);
    }
  }
});

test('the words a person reads: no "upstream", "in step" or a bare "commit"', () => {
  const states = [setUp, brain({ upstream: null }), brain({ changes: 3 }), brain({ ahead: 1 }), brain({ behind: 2 }), brain({ ahead: 1, behind: 2 }), { ...setUp, identity: { set: false } }];
  for (const g of states) {
    for (const r of gitRows(g)) assert.doesNotMatch(`${r.title} ${r.text}`, /upstream|in step|\bcommits?\b/i, `${r.title} / ${r.text}`);
    const step = withGitStep(onb, g).steps.find((x) => x.id === 'git');
    assert.doesNotMatch(`${step.title} ${step.detail}`, /upstream|in step|\bcommits?\b/i);
  }
});

test('the rows of Git and GitHub wrap on a phone: the sentence of what to do is never cut off', () => {
  const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.git-row \.row-title, \.git-row \.row-sub \{ white-space: normal; overflow-wrap: anywhere; \}/);
});

test('a brain that only gets newer changes: the sheet is never about saving or uploading', async () => {
  const { saveWords } = await import('../../web/gitsetup.js');
  const w = saveWords({ count: 0, files: [], more: 0, ahead: 0, behind: 2, repo: 'team/ai_brain on git.example.test', upstream: 'origin/main' });
  const said = [w.title, w.subtitle, ...w.lines, w.hint || '', w.button, w.busy, w.done].join(' | ');
  assert.doesNotMatch(said, /sav(e|ed|ing)|upload/i, said);
  assert.equal(w.button, 'Get them');
  assert.match(w.title, /^Get the newer AI brain/);
  assert.match(w.done, /has the newer changes/);
  // Files to save: the save sheet, its button and its end line say saving and uploading.
  const s = saveWords({ count: 3, files: ['a.md', 'b.md', 'c.md'], more: 0, ahead: 0, behind: 1, repo: null, upstream: 'origin/main' });
  assert.deepEqual([s.button, s.list], ['Save and upload', true]);
  assert.match(s.done, /saved on your git server/);
});

test('the git step on Home names no place by where it sits on the Setup tab ("above")', () => {
  const g = { ...setUp, gh: { installed: true, signedIn: false, account: null }, brain: { exists: true, git: true, remote: null, upstream: null } };
  const step = withGitStep(onb, g).steps.find((s) => s.id === 'git');
  assert.match(step.detail, /sign in to GitHub first/);
  assert.doesNotMatch(step.detail, /\b(above|below)\b/, step.detail);
});

test('a brain on a git server whose branch here is not linked: the row has a button, Set up opens the same sheet', async () => {
  const g = brain({ upstream: null, changes: 3 });
  const row = gitRows(g)[2];
  assert.equal(row.ok, false);
  assert.doesNotMatch(row.text, /branch|Sync says how/, row.text);
  assert.deepEqual(rowAction(row, g), { kind: 'save', label: 'Link it' });
  // Get started's button: the save sheet (it asks the brain's changes first), never the "set up" toast.
  const asked = [];
  const fetchWas = globalThis.fetch;
  globalThis.fetch = async (u) => (asked.push(String(u)), Promise.reject(new Error('offline in the test')));
  globalThis.document.body ||= document.createElement('body');
  try {
    assert.equal(await openGitSetup(g), false);
  } finally {
    globalThis.fetch = fetchWas;
  }
  assert.deepEqual(asked, ['/api/workspace/git/brain']);
  const toasts = (n) => (n.text !== undefined ? [n.text] : (n.children || []).flatMap(toasts));
  assert.doesNotMatch(toasts(document.body).join('|'), /Git and GitHub are set up/);
  const { saveWords } = await import('../../web/gitsetup.js');
  const w = saveWords({ count: 3, files: ['a.md', 'b.md', 'c.md'], more: 0, ahead: 0, behind: 0, repo: 'team/ai_brain on git.example.test', upstream: null });
  assert.deepEqual([w.button, w.list], ['Link it', true]);
  assert.doesNotMatch([w.title, ...w.lines, w.done].join(' '), /branch|upstream|push/i);
});

test('a brain not in git yet, with a name and e-mail set and GitHub signed in: Keep on GitHub, never "set up"', async () => {
  const g = brain({ git: false, remote: null, upstream: null, branch: undefined });
  const row = gitRows(g)[2];
  assert.equal(row.ok, false);
  assert.deepEqual(rowAction(row, g), { kind: 'keep', label: 'Keep on GitHub' });
  assert.doesNotMatch(row.text, /once your name and e-mail are set/, 'they are set: that is not what is left');
  // Get started's button opens the sheet that puts it in git and on GitHub (startNew does both).
  globalThis.document.body ||= document.createElement('body');
  const texts = (n) => (n.text !== undefined ? [n.text] : (n.children || []).flatMap(texts));
  const pressed = openGitSetup(g);
  const sheet = document.body.children.find((n) => n.tag === 'dialog' && n.open);
  assert.ok(sheet, 'a sheet is open');
  assert.match(texts(sheet).join('|'), /Keep the AI brain on GitHub/);
  sheet.close();
  assert.equal(await pressed, false);
  assert.doesNotMatch(texts(document.body).join('|'), /Git and GitHub are set up/);
  // Without a name and e-mail the brain cannot be committed: the name comes first, as the row says.
  const noName = { ...g, identity: { set: false, name: '', email: '' } };
  assert.equal(rowAction(gitRows(noName)[2], noName), null);
  assert.match(gitRows(noName)[2].text, /once your name and e-mail are set/);
  // Set-up has run already when he reads this: the row names what puts the brain in git, never set-up.
  assert.equal(gitRows(noName)[2].text, 'The AI brain is not in git yet: once your name and e-mail are set, Keep on GitHub puts it there (in a new private GitHub repository)');
});

test('Sync says a repository without a linked copy is not linked, not that it is not on GitHub', () => {
  const src = fs.readFileSync(new URL('../../web/projects.js', import.meta.url), 'utf8');
  const line = (/'not-online': \(\) => '([^']*)'/.exec(src) || [])[1];
  assert.ok(line, 'the not-online line is found');
  assert.doesNotMatch(line, /GitHub|online copy/, line);
});

test('every place a git row names is one he can open: a button, or the page with the button of that name', async () => {
  // Words that named a place that does not exist, or a result that does not say it.
  for (const f of ['web/gitsetup.js', 'src/workspace/brainsave.mjs']) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /Workspace → Create them|Sync shows both sides|Sync shows what is in the way/, f);
  }
  // No AI brain yet: the row's button is the sheet of that name (as on Settings → Workspace).
  const none = brain({ exists: false, git: false, remote: null, upstream: null });
  const row = gitRows(none)[2];
  assert.match(row.text, /Create what is missing/);
  assert.deepEqual(rowAction(row, none), { kind: 'create', label: 'Create what is missing' });
  // Changed on both sides: the sheet has the way to the Workspace page beside its sentence.
  const { saveWords } = await import('../../web/gitsetup.js');
  const both = saveWords({ count: 0, files: [], more: 0, ahead: 1, behind: 2, repo: null, upstream: 'origin/main' });
  assert.equal(both.workspace, true);
  assert.match(both.lines[0], /Sync on the Workspace page says what to do/);
  // git or gh not installed: Get started's button goes to the Setup tab, where Set up this computer is.
  globalThis.location = { hash: '', pathname: '/', protocol: 'http:', host: 'x' };
  for (const g of [{ ...setUp, git: false, identity: { set: false } }, { ...setUp, gh: { installed: false, signedIn: false, account: null } }]) {
    location.hash = '';
    assert.equal(await openGitSetup(g), false);
    assert.equal(location.hash, '#/computer/setup', JSON.stringify(g.gh));
  }
});

test('the save sheet: every file can be seen before the press; a key-shaped file leaves nothing to press', async () => {
  const { saveWords } = await import('../../web/gitsetup.js');
  const all = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md'];
  const src = fs.readFileSync(new URL('../../web/gitsetup.js', import.meta.url), 'utf8');
  assert.match(src, /h\('details\.adv', h\('summary', `and \$\{c\.more\} more: show all`\)/, 'the rest of the files is one press away');
  assert.match(src, /api\('\/api\/workspace\/git\/brain', \{ save: true, seen: c\.seen \}\)/, 'the press sends the list the sheet showed');
  const ok = saveWords({ count: 7, files: all.slice(0, 5), more: 2, all, secret: [], ahead: 0, behind: 0, repo: null, upstream: 'origin/main' });
  assert.equal(ok.button, 'Save and upload');
  const s = saveWords({ count: 7, files: all.slice(0, 5), more: 2, all: [...all, '.env'], secret: ['.env'], ahead: 0, behind: 0, repo: null, upstream: 'origin/main' });
  assert.equal(s.button, null, 'nothing to press');
  assert.deepEqual(s.secret, ['.env']);
  assert.match(s.lines.join(' '), /looks like a key or a password/);
  assert.match(s.lines[1], /^Ask your coding tool in a session to move it out of the AI brain\./, 'an older server\'s answer (no advice): the same way through');
  // The server's advice for a file git keeps already is the sheet's line: no .gitignore for it.
  const advice = 'Take the key or password out of it, or ask your coding tool in a session to move it out of the AI brain (a .gitignore alone does nothing for a file that was saved before).';
  const kept = saveWords({ count: 1, files: ['learnings.md'], more: 0, all: ['learnings.md'], secret: ['learnings.md'], secretAdvice: advice, ahead: 0, behind: 0, repo: null, upstream: 'origin/main' });
  assert.equal(kept.lines[1], `${advice} Then open this again.`);
});

test('the save sheet: a file deleted here is said to be taken off the server, never listed as one that goes there', async () => {
  const { saveWords } = await import('../../web/gitsetup.js');
  const repo = 'team/ai_brain on git.example.test';
  const w = saveWords({ count: 2, files: ['learnings.md'], more: 0, all: ['learnings.md'], removed: ['.env'], secret: [], ahead: 0, behind: 0, repo, upstream: 'origin/main' });
  assert.equal(w.lines[0], `1 file goes to ${repo}:`);
  assert.equal(w.list, true);
  assert.deepEqual(w.removed.files, ['.env']);
  assert.match(w.removed.text, new RegExp(`^1 file was deleted here, so the save takes it off ${repo} too, and off your other computers`));
  assert.equal(w.button, 'Save and upload');
  // Only a removal: no "files go" line, no list of files that go up.
  const only = saveWords({ count: 1, files: [], more: 0, all: [], removed: ['old.md'], secret: [], ahead: 0, behind: 0, repo, upstream: 'origin/main' });
  assert.deepEqual([only.lines, only.list, only.removed.files, only.button], [[], false, ['old.md'], 'Save and upload']);
  // Not linked yet: the same.
  const link = saveWords({ count: 2, files: ['a.md'], more: 0, all: ['a.md'], removed: ['b.md'], secret: [], ahead: 0, behind: 0, repo, upstream: null });
  assert.equal(link.lines[1], `1 file goes to ${repo}:`);
  assert.deepEqual(link.removed.files, ['b.md']);
});

test('the save sheet: a brain the server keeps on another branch is not offered Link it, and says what to ask', async () => {
  const { saveWords } = await import('../../web/gitsetup.js');
  const elsewhere = 'the AI brain here is on "master", and team/ai_brain on git.example.test keeps it on "main". Ask your coding tool in a session to move the AI brain here onto the server\'s branch, then open this again.';
  const w = saveWords({ count: 1, files: ['a.md'], more: 0, all: ['a.md'], removed: [], secret: [], ahead: 0, behind: 0, repo: 'team/ai_brain on git.example.test', upstream: null, elsewhere });
  assert.equal(w.button, null);
  assert.equal(w.lines[0], `It cannot be linked by a press: ${elsewhere}`);
  assert.doesNotMatch(w.lines.join(' '), /This links them/);
});
