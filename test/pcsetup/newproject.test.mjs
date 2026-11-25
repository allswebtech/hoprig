// `hoprig project new` with a brief, a kind and --start (src/pcsetup/newproject.mjs): the brief kept byte for byte as
// docs/brief.md, the bundled new-project skill in the project's .claude/skills with its record, the kind as the first
// decision, all in the first commit; refusals before anything is written; a project that is there never changed; the
// kind asked only where a terminal is; --start through the running dashboard (a stand-in) and only with a brief.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { tempHome, writeTree } from '../workspace/helpers.mjs';

const t = tempHome('newproj');
process.env.HOPRIG_WORKSPACE_DIR = t.ws;
test.after(() => t.cleanup());

const { projectNew, projectMain } = await import('../../src/pcsetup/project.mjs');
const np = await import('../../src/pcsetup/newproject.mjs');
const { writeCommandToken } = await import('../../src/pcsetup/newprojectstart.mjs');
const { listInstalled, scopeOf, hashFolder } = await import('../../src/skillhub/store.mjs');
const { bundledDir, catalogEntry } = await import('../../src/skillhub/catalog.mjs');
const { quietUi } = await import('./dryrun-fixture.mjs');

const projects = path.join(t.ws, 'projects');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const briefFile = (name, content) => {
  const f = path.join(t.root, name);
  fs.writeFileSync(f, content);
  return f;
};
const run = async (args, o = {}) => {
  const ui = await quietUi(o.ui || {});
  const code = await projectNew(args, { ui, ...o.opts });
  return { code, text: ui.text(), ui };
};
/** Every path below `dir` with its kind and content hash: a project that must not change is compared by this. */
function tree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, r);
      if (d.isDirectory()) {
        out[r] = 'dir';
        walk(r);
      } else out[r] = d.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : 'other';
    }
  };
  walk('');
  return out;
}

// The owner's words as he wrote them: Windows line ends, no final newline, another script, an emoji with a joiner.
const BRIEF = 'A tool that counts words.\r\nUsers: writers 👩‍💻 and editors.\r\nनमस्ते — it must handle Hindi.  ';

test('a brief is kept byte for byte, the skill and its record come in, the kind\'s hint and the scope are the first decision, all in the first commit', async () => {
  const r = await run(['shop', '--brief', briefFile('brief.txt', BRIEF), '--kind', 'cli', '--scope', 'setup', '--no-github']);
  assert.equal(r.code, 0, r.text);
  const root = path.join(projects, 'shop');
  assert.equal(fs.readFileSync(path.join(root, 'docs/brief.md'), 'utf8'), BRIEF, 'unchanged: line ends, spaces, the last line');
  // The skill is the bundled one, file for file.
  assert.deepEqual(hashFolder(path.join(root, '.claude/skills/new-project')), hashFolder(bundledDir(catalogEntry('new-project'))));
  const rec = JSON.parse(fs.readFileSync(path.join(root, '.claude/skills/.hoprig-skills.json'), 'utf8')).skills['new-project'];
  assert.equal(rec.source.type, 'bundled');
  assert.deepEqual(rec.files, hashFolder(path.join(root, '.claude/skills/new-project')));
  const listed = listInstalled(scopeOf({ project: root })).find((s) => s.name === 'new-project');
  assert.ok(listed && listed.managed && listed.source.type === 'bundled', 'the skills list knows it as bundled');
  assert.deepEqual(listed.edited, [], 'and unedited');
  const decisions = fs.readFileSync(path.join(root, 'decisions.md'), 'utf8');
  assert.match(decisions, /^# Decisions[\s\S]*## \d{4}-\d\d-\d\d: how the project starts\n\n- The owner's hint for the kind: a command-line tool \(`cli`\)\. The new-project skill's fit decides/);
  assert.match(decisions, /\n- The scope: set-up only \(`setup`\): the structure, the documents and a foundation/);
  assert.equal(git(root, 'status', '--porcelain'), '', 'everything is in the first commit');
  assert.match(git(root, 'ls-files'), /\.claude\/skills\/new-project\/SKILL\.md/);
  assert.match(r.text, /hoprig project start shop --kind cli --scope setup/);
});

test('without a brief the project gets the skill and its record all the same, and no docs/brief.md and no decision', async () => {
  const r = await run(['plain', '--no-github']);
  assert.equal(r.code, 0, r.text);
  const root = path.join(projects, 'plain');
  assert.deepEqual(hashFolder(path.join(root, '.claude/skills/new-project')), hashFolder(bundledDir(catalogEntry('new-project'))), 'the skill is on by default');
  const listed = listInstalled(scopeOf({ project: root })).find((s) => s.name === 'new-project');
  assert.ok(listed && listed.managed && listed.source.type === 'bundled', 'with its record: the skills list knows it as bundled');
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.endsWith(np.NO_BRIEF_YET), 'AGENTS.md says what to do while there is no brief');
  assert.doesNotMatch(agents, /^## Every session/m, 'and has no "Every session" part: that comes with a brief');
  assert.match(np.NO_BRIEF_YET, /docs\/brief\.md/);
  assert.ok(!fs.existsSync(path.join(root, 'docs/brief.md')));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'decisions.md'), 'utf8'), /how the project starts/);
  assert.equal(git(root, 'status', '--porcelain'), '', 'everything is in the first commit');
  assert.match(r.text, /hoprig project add plain <stack>/);
});

test('--no-skill leaves the skill out (a project as before), and goes only without a brief', async () => {
  const r = await run(['bare', '--no-skill', '--no-github']);
  assert.equal(r.code, 0, r.text);
  const root = path.join(projects, 'bare');
  assert.ok(!fs.existsSync(path.join(root, '.claude/skills')), 'no skill and no record');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /Every session|No brief yet|new-project/);
  const both = await run(['bare2', '--no-skill', '--brief', briefFile('nb.txt', 'A shop.'), '--no-github']);
  assert.equal(both.code, 1, both.text);
  assert.match(both.text, /--no-skill goes without a brief/);
  assert.ok(!fs.existsSync(path.join(projects, 'bare2')), 'refused before anything is written');
  assert.match((await import('../../src/pcsetup/project.mjs')).NEW_USAGE, /\[--no-skill\]/);
});

test('refusals come before anything is written: hidden characters, a control character, not UTF-8, too big, a bad kind, --start without a brief', async () => {
  const cases = [
    [['--brief', briefFile('zw.txt', 'Build a shop​ for shoes.')], /cannot be seen \(the first is U\+200B\)/],
    [['--brief', briefFile('tag.txt', 'Build a shop\u{E0041}\u{E0042}.')], /cannot be seen/],
    [['--brief', briefFile('bidi.txt', 'Build a ‮shop.')], /cannot be seen/],
    [['--brief', briefFile('ctl.txt', 'Build a shop\u0007.')], /cannot be seen \(the first is U\+0007\)/],
    [['--brief', briefFile('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))], /not UTF-8/],
    [['--brief', briefFile('big.txt', 'x'.repeat(np.BRIEF_MAX_BYTES + 1))], /at most 24 KiB/],
    [['--brief', briefFile('empty.txt', ' \n ')], /empty/],
    [['--brief', path.join(t.root, 'missing.txt')], /not there/],
    [['--kind', 'game'], /the kind is one of/],
    [['--scope', 'all'], /the scope is one of: product, setup/],
    [['--start'], /--start needs a brief/],
    [['--kind', 'cli'], /--kind goes with a brief/],
    [['--scope', 'setup'], /--scope goes with a brief/],
  ];
  for (const [extra, why] of cases) {
    const r = await run(['refused', ...extra, '--no-github']);
    assert.equal(r.code, 1, `${extra.join(' ')}: ${r.text}`);
    assert.match(r.text, why);
    assert.ok(!fs.existsSync(path.join(projects, 'refused')), `${extra.join(' ')} left a folder behind`);
  }
});

test('a brief\'s own characters that are text stay allowed (an emoji joiner, a script that joins letters)', () => {
  for (const s of ['A café ☕️ app', 'Team 👩🏽‍💻 tools', 'क्‍ष and می‌خواهم']) assert.equal(np.checkProjectBrief(s), s);
  const e = (() => {
    try {
      np.checkProjectBrief('A​B');
    } catch (x) {
      return x;
    }
  })();
  assert.equal(e.details.code, 'brief-hidden');
  assert.equal(e.details.clean, 'AB', 'the brief without them comes along, for "Take them out"');
});

test('a project that is there is never changed, with or without a brief', async () => {
  const root = path.join(projects, 'shop');
  const before = tree(root);
  for (const args of [['shop', '--brief', briefFile('again.txt', 'Another brief.'), '--kind', 'web-app'], ['shop', '--start', '--brief', briefFile('again2.txt', 'x')]]) {
    const r = await run([...args, '--no-github']);
    assert.equal(r.code, 1);
    assert.match(r.text, /already exists/);
  }
  assert.deepEqual(tree(root), before);
});

test('the kind and the scope are asked where a terminal is, for a brief (and not when given, with --yes, without a terminal or a brief)', async () => {
  const replies = ['7', '2']; // the kind's question first (7: a command-line tool), then the scope's (2: set-up only)
  const answer = () => replies.shift();
  const asked = await run(['askme', '--brief', briefFile('a.txt', 'A word counter.'), '--no-github'], { ui: { interactive: true, answers: answer } });
  assert.equal(asked.code, 0, asked.text);
  assert.match(asked.text, /What kind of project is it\?[\s\S]*A product for many businesses, or a marketplace: each business or seller has its own data and users/);
  assert.match(asked.text, /What should the AI do\?[\s\S]*The set-up only/);
  const d = fs.readFileSync(path.join(projects, 'askme', 'decisions.md'), 'utf8');
  assert.match(d, /`cli`/);
  assert.match(d, /`setup`/);
  // Pressing Enter takes the defaults: no kind (the AI works it out) and the whole product.
  const notSure = await run(['notsure', '--brief', briefFile('n.txt', 'A word counter.'), '--no-github'], { ui: { interactive: true, answers: () => '' } });
  assert.equal(notSure.code, 0, notSure.text);
  const nd = fs.readFileSync(path.join(projects, 'notsure', 'decisions.md'), 'utf8');
  assert.doesNotMatch(nd, /The owner's hint for the kind/, 'the default kind is "not sure"');
  assert.match(nd, /\n- No hint for the kind: the new-project skill's fit works it out from the brief/, 'and decisions.md says so');
  assert.match(nd, /The scope: whole product \(`product`\)/, 'the default scope is the whole product');
  for (const [name, ui, extra] of [['quiet1', {}, ['--brief', briefFile('q1.txt', 'x')]], ['quiet2', { interactive: true, answers: () => '1' }, ['--brief', briefFile('q2.txt', 'x'), '--kind', 'api', '--scope', 'product']], ['quiet3', { interactive: true, answers: () => '1' }, []]]) {
    const r = await run([name, ...extra, '--no-github'], { ui });
    assert.equal(r.code, 0, r.text);
    assert.doesNotMatch(r.text, /What kind|What should the AI do/, name);
  }
});

test('--brief - reads what is typed or piped in, unchanged', async () => {
  const text = 'Typed brief\nwith two lines\n';
  const r = await run(['typed', '--brief', '-', '--no-github'], { opts: { stdin: Readable.from([Buffer.from(text)]) } });
  assert.equal(r.code, 0, r.text);
  assert.equal(fs.readFileSync(path.join(projects, 'typed', 'docs/brief.md'), 'utf8'), text);
});

test('a template of the owner\'s own: its own new-project skill is kept (no record), its docs/brief.md gives way to the brief given, its part "Every session" is not added twice', async () => {
  const tpl = writeTree(path.join(t.root, 'tpl'), { 'AGENTS.md': '# mine\n', 'docs/brief.md': 'template brief\n', '.claude/skills/new-project/SKILL.md': '---\nname: new-project\ndescription: my own\n---\nmine\n' });
  const r = await run(['own', '--template', tpl, '--brief', briefFile('own.txt', 'The real brief.\n'), '--no-github']);
  assert.equal(r.code, 0, r.text);
  const root = path.join(projects, 'own');
  assert.equal(fs.readFileSync(path.join(root, 'docs/brief.md'), 'utf8'), 'The real brief.\n');
  assert.match(fs.readFileSync(path.join(root, '.claude/skills/new-project/SKILL.md'), 'utf8'), /my own/);
  assert.ok(!fs.existsSync(path.join(root, '.claude/skills/.hoprig-skills.json')));
  // A template made from a project set up from a brief: its AGENTS.md has the part "Every session", which is not added twice.
  const tpl2 = writeTree(path.join(t.root, 'tplagents'), { 'AGENTS.md': `# Rules\n\n${np.EVERY_SESSION}\n## Commands\n\nnpm test\n` });
  const r2 = await run(['ownagents', '--template', tpl2, '--brief', briefFile('own2.txt', 'Another brief.\n'), '--kind', 'web-app', '--no-github']);
  assert.equal(r2.code, 0, r2.text);
  const agents = fs.readFileSync(path.join(projects, 'ownagents', 'AGENTS.md'), 'utf8');
  assert.equal(agents.match(/^## Every session$/gm).length, 1, agents);
  assert.equal(agents, `# Rules\n\n${np.EVERY_SESSION}\n## Commands\n\nnpm test\n`, 'the template\'s AGENTS.md as it was');
});

test('--start goes through the running dashboard with its command token; without one the project is made and the command to start later is said', async () => {
  const none = await run(['later', '--brief', briefFile('l.txt', 'A later start.'), '--kind', 'library', '--scope', 'setup', '--start', '--no-github']);
  assert.equal(none.code, 1);
  assert.ok(fs.existsSync(path.join(projects, 'later', '.git')), 'the project is made all the same');
  assert.match(none.text, /dashboard is not running.*hoprig project start later --kind library --scope setup/s);

  const token = writeCommandToken();
  const sent = [];
  const fetchImpl = async (url, o) => {
    sent.push({ url, headers: o.headers, body: JSON.parse(o.body) });
    return { ok: true, json: async () => ({ chat: 'c1', project: 'go', tool: 'claude', provider: 'main', model: null, effort: null }) };
  };
  const { startCommand } = await import('../../src/pcsetup/newprojectstart.mjs');
  const ui = await quietUi();
  const code = await startCommand({ name: 'later', kind: 'library', scope: 'setup', provider: 'main', model: undefined }, { ui, dashboard: { host: '0.0.0.0', port: 7871 }, fetchImpl });
  assert.equal(code, 0, ui.text());
  assert.equal(sent[0].url, 'http://127.0.0.1:7871/api/pcsetup/project/command/start');
  assert.equal(sent[0].headers['x-hoprig-project-command'], token);
  assert.deepEqual(sent[0].body, { name: 'later', kind: 'library', scope: 'setup', provider: 'main' });
  assert.match(ui.text(), /#\/chat\/c1/);

  const refusedUi = await quietUi();
  const no = await startCommand({ name: 'later' }, { ui: refusedUi, dashboard: { host: '127.0.0.1', port: 7871 }, fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'later has no brief in docs/brief.md' }) }) });
  assert.equal(no, 1);
  assert.match(refusedUi.text(), /no session started: later has no brief/);

  // One is open already: its address, and how to open another all the same.
  const openUi = await quietUi();
  const open = await startCommand({ name: 'later', scope: 'setup' }, { ui: openUi, dashboard: { host: '127.0.0.1', port: 7871 }, fetchImpl: async () => ({ ok: false, json: async () => ({ code: 'started', chat: 'c7', error: 'a session that sets up later is already open' }) }) });
  assert.equal(open, 1);
  assert.match(openUi.text(), /already open: http:\/\/127\.0\.0\.1:7871\/#\/chat\/c7/);
  assert.match(openUi.text(), /hoprig project start later --scope setup --again/);
});

test('project start: usage, a bad kind and a bad scope are refused before the dashboard is asked', async () => {
  for (const [args, why] of [[['start'], /usage: hoprig project start/], [['start', 'x', '--kind', 'game'], /the kind is one of/], [['start', 'x', '--scope', 'all'], /the scope is one of/]]) {
    const ui = await quietUi();
    assert.equal(await projectMain(args, { ui, write: () => {} }), 1);
    assert.match(ui.text(), why);
  }
});

test('a long brief is checked in one pass: 24 KiB with a hidden character at its end is refused at once', () => {
  const long = `${'a'.repeat(np.BRIEF_MAX_BYTES - 4)}\u200b`;
  const t0 = performance.now();
  assert.throws(() => np.checkProjectBrief(long), (e) => e.details.code === 'brief-hidden' && e.details.clean === long.slice(0, -1));
  const ms = performance.now() - t0;
  // Spread once per character it took about 4 s (and the dashboard answered nothing meanwhile); one pass takes a few ms.
  assert.ok(ms < 400, `${Math.round(ms)} ms`);
});

test('a paste from a document: its line separators and page breaks are refused with the brief made of plain lines', () => {
  const refusal = (s) => {
    try {
      np.checkProjectBrief(s);
    } catch (e) {
      return e;
    }
    return null;
  };
  for (const [given, clean, first] of [
    ['A shop for handmade shoes.\u2028Customers order and pay.', 'A shop for handmade shoes.\nCustomers order and pay.', 'U+2028'],
    ['Page one.\u000cPage two.\u2029End.', 'Page one.\nPage two.\nEnd.', 'U+000C'],
    ['Tab\u000bbed and a bell\u0007 and a zero\u200bwidth.', 'Tab\nbed and a bell and a zerowidth.', 'U+000B'],
    // The first is the first in the text, whichever rule refuses it.
    ['x\u200by\u2028z', 'xy\nz', 'U+200B'],
    ['An emoji 👩\u200d💻 stays, a mark\u200e goes.\u000c', 'An emoji 👩\u200d💻 stays, a mark goes.\n', 'U+200E'],
  ]) {
    const e = refusal(given);
    assert.ok(e, JSON.stringify(given));
    assert.equal(e.details.code, 'brief-hidden', 'so the page offers "Take them out"');
    assert.equal(e.details.clean, clean);
    assert.match(e.message, new RegExp(`characters in it that cannot be seen \\(the first is ${first.replace('+', '\\+')}\\): take them out`));
    assert.equal(np.checkProjectBrief(e.details.clean), e.details.clean, 'what it offers is a brief that passes');
  }
});

test('a piped brief that is too big is refused as too big, also when the read stops inside a character', async () => {
  const big = Buffer.from('\u0928'.repeat(40000)); // 3 bytes each: the cap falls inside one
  const chunks = [];
  for (let i = 0; i < big.length; i += 65536) chunks.push(big.subarray(i, i + 65536));
  const r = await run(['pbig', '--brief', '-', '--no-github'], { opts: { stdin: Readable.from(chunks) } });
  assert.equal(r.code, 1);
  assert.match(r.text, /at most 24 KiB/);
  assert.doesNotMatch(r.text, /UTF-8/);
  assert.ok(!fs.existsSync(path.join(projects, 'pbig')));
});

test('--brief - at a terminal: the kind and the scope are asked first, then the brief is typed (the terminal is used up after it)', async () => {
  let readOut = false;
  const stdin = Readable.from((async function* typing() {
    readOut = true;
    yield Buffer.from('My typed brief line.\n');
  })());
  stdin.isTTY = true;
  // As the real question does on a terminal the brief has used up: no answer (Ctrl-D), and nothing waits for one.
  const replies = ['7', '2'];
  const r = await run(['typedtty', '--brief', '-', '--no-github'], { ui: { interactive: true, answers: () => (readOut ? null : replies.shift()) }, opts: { stdin } });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /What kind of project is it\?[\s\S]*What should the AI do\?[\s\S]*Type the brief \(at most 24 KiB\), then press Ctrl-D on a line of its own/, 'the questions, then what to type and how to end it');
  const root = path.join(projects, 'typedtty');
  assert.equal(fs.readFileSync(path.join(root, 'docs/brief.md'), 'utf8'), 'My typed brief line.\n');
  const d = fs.readFileSync(path.join(root, 'decisions.md'), 'utf8');
  assert.match(d, /`cli`/, 'the kind answered before the brief');
  assert.match(d, /`setup`/, 'the scope answered before the brief');
});

test('--brief with no value, last or before another option, is refused: never a project without its brief', async () => {
  for (const args of [['nob1', '--no-github', '--brief'], ['nob2', '--brief', '--no-github']]) {
    const r = await run(args);
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.text}`);
    assert.match(r.text, /--brief needs a file \(or - to type it\)/);
    assert.ok(!fs.existsSync(path.join(projects, args[0])), `${args.join(' ')} made a folder`);
  }
});

test('the kind inside a sentence is each kind\'s own phrase, in the first message and in decisions.md', () => {
  const want = {
    website: 'a website', 'web-app': 'a web app with accounts', 'multi-tenant': 'a product for many businesses, or a marketplace', internal: 'an internal tool',
    api: 'an API or backend only', 'mobile-first': 'a phone app first', cli: 'a command-line tool', library: 'a library', extension: 'a browser extension', desktop: 'a desktop app',
  };
  assert.deepEqual(np.KINDS.map((k) => k.id), Object.keys(want));
  for (const [id, phrase] of Object.entries(want)) {
    assert.ok(np.firstMessage({ brief: 'x', kind: id }).includes(`My hint for the kind: ${phrase} (\`${id}\`)`), id);
    assert.ok(np.startDecision({ kind: id }, '2026-01-01').includes(`- The owner's hint for the kind: ${phrase} (\`${id}\`)`), id);
  }
});

test('a template with its own skills record but not this skill: the record keeps its skills and gains this one', async () => {
  const otherRec = { version: 1, skills: { notes: { source: { type: 'bundled', catalogId: 'hoprig', path: 'templates/skills/hoprig', version: '0.0.1' }, license: 'MIT', files: {}, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } };
  const tpl = writeTree(path.join(t.root, 'tplrec'), { 'AGENTS.md': '# mine\n', '.claude/skills/notes/SKILL.md': '---\nname: notes\ndescription: notes\n---\n', '.claude/skills/.hoprig-skills.json': `${JSON.stringify(otherRec, null, 2)}\n` });
  const r = await run(['fromtpl', '--template', tpl, '--brief', briefFile('ft.txt', 'A brief.\n'), '--no-github']);
  assert.equal(r.code, 0, r.text);
  const root = path.join(projects, 'fromtpl');
  const rec = JSON.parse(fs.readFileSync(path.join(root, '.claude/skills/.hoprig-skills.json'), 'utf8'));
  assert.deepEqual(rec.skills.notes, otherRec.skills.notes, 'the template\'s own entry is kept as it was');
  assert.equal(rec.skills['new-project'].source.type, 'bundled');
  assert.deepEqual(rec.skills['new-project'].files, hashFolder(path.join(root, '.claude/skills/new-project')));
  const listed = listInstalled(scopeOf({ project: root })).find((s) => s.name === 'new-project');
  assert.ok(listed && listed.managed && listed.source.type === 'bundled', 'the skills list knows it as bundled, not as of unknown source');
});

test('help: project new --help and project start --help print their usage and do nothing; project names start; a start says names', async () => {
  for (const args of [['new', '--help'], ['new', 'helped', '--brief', 'x', '-h'], ['start', '--help']]) {
    const ui = await quietUi();
    assert.equal(await projectMain(args, { ui, write: () => {} }), 0, ui.text());
    assert.match(ui.text(), new RegExp(`usage: hoprig project ${args[0]} <name>`));
    assert.doesNotMatch(ui.text(), /unknown option/);
  }
  assert.ok(!fs.existsSync(path.join(projects, 'helped')), '--help makes nothing');
  const ui = await quietUi();
  assert.equal(await projectMain(['what'], { ui, write: () => {} }), 2);
  assert.match(ui.text(), /start <name> {3}the AI session that sets up a project made with a brief/);
  const { startCommand } = await import('../../src/pcsetup/newprojectstart.mjs');
  writeCommandToken();
  const said = await quietUi();
  const answer = { chat: 'c9', project: 'x', tool: 'claude', toolName: 'Claude Code', provider: 'main', providerLabel: 'My account', model: null };
  assert.equal(await startCommand({ name: 'x' }, { ui: said, dashboard: { host: '127.0.0.1', port: 7871 }, fetchImpl: async () => ({ ok: true, json: async () => answer }) }), 0);
  assert.match(said.text(), /a session started in the App \(Claude Code, My account\)/);
});

test('project start without flags keeps the kind and the scope the project was made with', async () => {
  const made = await run(['keeps', '--brief', briefFile('k.txt', 'A shop.\n'), '--kind', 'api', '--scope', 'setup', '--no-github']);
  assert.equal(made.code, 0, made.text);
  const { projectStarter, madeWith } = await import('../../src/pcsetup/newprojectstart.mjs');
  (await import('../../src/profiles.mjs')).writeProfile('main', { label: 'Main' });
  const root = path.join(projects, 'keeps');
  assert.deepEqual(madeWith(root), { kind: 'api', scope: 'setup' });
  const starter = projectStarter({ config: () => ({}), chat: { open: async () => ({ id: 'c', sent: true }) }, defaultProvider: async () => 'main', findProject: async () => ({ root, ref: 'keeps' }), defaults: () => null });
  const plain = await starter.start({ name: 'keeps', dryRun: true });
  assert.equal(plain.would.scope, 'setup');
  assert.match(plain.would.text, /\nScope: set-up only\./);
  assert.match(plain.would.text, /My hint for the kind: an API or backend only \(`api`\)/);
  const asked = await starter.start({ name: 'keeps', scope: 'product', kind: 'cli', dryRun: true });
  assert.match(asked.would.text, /\nScope: the whole product\./, 'what the start names wins');
  assert.match(asked.would.text, /My hint for the kind: a command-line tool/);
});

test('a project new that stops before its first commit says what it leaves, the next run says it was left half made, and start refuses it', { skip: process.platform === 'win32' ? 'a git stand-in on PATH is a shell script' : false }, async () => {
  // git as itself, except that a commit fails.
  const bin = writeTree(path.join(t.root, 'failbin'), { git: `#!/bin/sh\nfor a in "$@"; do [ "$a" = commit ] && { echo "stand-in: the commit fails" >&2; exit 1; }; done\nexec ${JSON.stringify(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim())} "$@"\n` });
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  let first;
  try {
    first = await run(['half', '--brief', briefFile('h.txt', 'A brief.\n'), '--kind', 'cli', '--no-github']);
  } finally {
    process.env.PATH = before;
  }
  const root = path.join(projects, 'half');
  assert.equal(first.code, 1);
  assert.match(first.text, /git could not make the first commit: stand-in: the commit fails\. The folder .*half is left half made: its files are there, without a first commit\. Look at it, remove it, then run this again/s);
  const again = await run(['half', '--brief', briefFile('h2.txt', 'A brief.\n'), '--no-github']);
  assert.equal(again.code, 1);
  assert.match(again.text, /already exists: an earlier run left it half made \(its files, but no first commit\)/);
  const { projectStarter } = await import('../../src/pcsetup/newprojectstart.mjs');
  const starter = projectStarter({ config: () => ({}), chat: { open: async () => assert.fail('nothing opens') }, defaultProvider: async () => 'main', findProject: async () => ({ root, ref: 'half' }), defaults: () => null });
  await assert.rejects(starter.start({ name: 'half', dryRun: false }), (e) => e.details.code === 'no-commit');
  // A folder that is simply there (a finished project) keeps the short refusal.
  assert.doesNotMatch((await run(['shop', '--no-github'])).text, /half made/);
});

test('a template whose decisions.md holds another project\'s start: a project made from it with no choice is started with none', async () => {
  const theirs = '# Decisions\n\n## 2026-01-01: how the project starts\n\n- The owner\'s hint for the kind: a command-line tool (`cli`). The fit decides.\n- The scope: set-up only (`setup`): the structure only.\n\n## 2026-01-02: the database\n\nNone.\n';
  const tpl = writeTree(path.join(t.root, 'tpldec'), { 'AGENTS.md': '# mine\n', 'decisions.md': theirs });
  const r = await run(['inherits', '--template', tpl, '--brief', briefFile('inh.txt', 'A shop.\n'), '--no-github']);
  assert.equal(r.code, 0, r.text);
  const root = path.join(projects, 'inherits');
  const d = fs.readFileSync(path.join(root, 'decisions.md'), 'utf8');
  assert.ok(d.startsWith(theirs), 'the template\'s own entries stay as they were');
  assert.match(d.slice(theirs.length), /^\n## \d{4}-\d\d-\d\d: how the project starts\n\n- No hint for the kind: the new-project skill's fit works it out from the brief .*\n- The scope: as the brief says; the whole product when it says nothing\.\n$/, 'its own entry, newest, says nothing was chosen');
  const { projectStarter, madeWith } = await import('../../src/pcsetup/newprojectstart.mjs');
  (await import('../../src/profiles.mjs')).writeProfile('main', { label: 'Main' });
  assert.deepEqual(madeWith(root), {}, 'the template\'s kind and scope are not this project\'s');
  const starter = projectStarter({ config: () => ({}), chat: { open: async () => ({ id: 'c', sent: true }) }, defaultProvider: async () => 'main', findProject: async () => ({ root, ref: 'inherits' }), defaults: () => null });
  const plain = await starter.start({ name: 'inherits', dryRun: true });
  assert.equal(plain.would.scope, null);
  assert.equal(plain.would.kind, null);
  assert.match(plain.would.text, /\nScope: as my brief says; the whole product when it says nothing\./);
  assert.match(plain.would.text, /\nI chose no kind/);
  assert.match(r.text, /Next: .*hoprig project start inherits(?! --)/);
  // Its own choice, written after the template's entry, is the one read.
  fs.appendFileSync(path.join(root, 'decisions.md'), np.startDecision({ kind: 'api', scope: 'product' }, '2026-02-01'));
  assert.deepEqual(madeWith(root), { kind: 'api', scope: 'product' });
});

test('docs/PC-SETUP.md names everything a brief adds: the brief, the skill, the part "Every session" and the start entry', () => {
  const doc = fs.readFileSync(new URL('../../docs/PC-SETUP.md', import.meta.url), 'utf8');
  const part = doc.slice(doc.indexOf('### A new project from a brief'), doc.indexOf('What the AI does then'));
  assert.match(part, /kept byte for byte as `docs\/brief\.md`/);
  assert.match(part, /\*\*The `new-project` skill\*\* comes with every new project, with a brief or without one/);
  assert.match(part, /\*\*`--no-skill`\*\* leaves the\s+skill out \(only without a brief\)/);
  assert.match(part, /the box \*\*Add the New Project skill\*\*, ticked at first/);
  assert.match(part, /`AGENTS\.md` gets a part "No brief yet"/);
  assert.match(part, /\*\*`AGENTS\.md`\*\* gets a part "Every session"/);
  assert.match(part, /`decisions\.md`, as its entry "how the project\s+starts"/);
});

test('--kind, --scope or another choice with no value, last or before another option, is refused: never dropped without a word', async () => {
  const brief = briefFile('ek.txt', 'A brief.\n');
  for (const [args, why] of [
    [['ek1', '--no-github', '--kind'], /--kind needs one of: website, web-app, .*desktop/],
    [['ek2', '--brief', brief, '--no-github', '--scope'], /--scope is product or setup/],
    [['ek3', '--brief', brief, '--kind', '--start', '--no-github'], /--kind needs one of/],
    [['ek4', '--brief', brief, '--scope=', '--no-github'], /--scope is product or setup/],
    [['ek5', '--brief', brief, '--start', '--no-github', '--provider'], /--provider needs a value/],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.text}`);
    assert.match(r.text, why, args.join(' '));
    assert.ok(!fs.existsSync(path.join(projects, args[0])), `${args.join(' ')} made a folder`);
  }
  for (const [args, why] of [[['start', 'x', '--kind'], /--kind needs one of/], [['start', 'x', '--scope'], /--scope is product or setup/], [['start', 'x', '--model', '--again'], /--model needs a value/]]) {
    const ui = await quietUi();
    assert.equal(await projectMain(args, { ui, write: () => {} }), 1, args.join(' '));
    assert.match(ui.text(), why, args.join(' '));
    assert.doesNotMatch(ui.text(), /dashboard/, 'refused before the dashboard is asked');
  }
});
