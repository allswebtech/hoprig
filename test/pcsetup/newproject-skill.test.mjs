// The bundled new-project skill (templates/skills/new-project), held against the agentskills.io specification (as of
// November 2026: name 1-64 of a-z, 0-9 and single hyphens, the same as its folder; description 1-1024; compatibility
// at most 500; SKILL.md under 500 lines; references by relative path, one level deep) and against what Hoprig itself
// makes, so it can never describe a structure the tool does not make: its list of what `hoprig project new` makes is
// what a real run makes, its kinds and references are the code's, its code repositories are what `project add` makes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome } from '../workspace/helpers.mjs';

const t = tempHome('npskill');
process.env.HOPRIG_WORKSPACE_DIR = t.ws;
test.after(() => t.cleanup());

const { bundledDir, catalogEntry } = await import('../../src/skillhub/catalog.mjs');
const { parseFrontMatter } = await import('../../src/skillhub/frontmatter.mjs');
const { scanSkill } = await import('../../src/skillhub/scan.mjs');
const { sha256 } = await import('../../src/skillhub/store.mjs');
const { KINDS, REFERENCES, ALWAYS_READ, APPLIES, SCOPES, BRIEF_FILE, EVERY_SESSION } = await import('../../src/pcsetup/newproject.mjs');
const { projectNew, projectAdd } = await import('../../src/pcsetup/project.mjs');
const { quietUi } = await import('./dryrun-fixture.mjs');

const dir = bundledDir(catalogEntry('new-project'));
const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
const fm = parseFrontMatter(skillMd);
const allFiles = (base, rel = '') => fs.readdirSync(path.join(base, rel), { withFileTypes: true }).flatMap((d) => {
  const r = rel ? `${rel}/${d.name}` : d.name;
  return d.isDirectory() ? allFiles(base, r) : [r];
});

test('the front matter and the body follow the specification', () => {
  assert.ok(fm.ok);
  const { name, description, compatibility } = fm.data;
  assert.equal(name, path.basename(dir), 'the name is the folder\'s');
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(name.length <= 64);
  assert.ok(description.length >= 1 && description.length <= 1024, `description: ${description.length}`);
  assert.match(description, /Use when/, 'it says when to use it');
  // Skills and the project page show the description, cut after its first words: they read plain, no inner words.
  const first = description.split(/(?<=\.) /)[0];
  assert.equal(first, 'Sets up a new project from its owner\'s brief - asks once, writes the plan, then builds it.');
  assert.doesNotMatch(description.slice(0, 120), /tier|applies table/);
  assert.ok(!compatibility || compatibility.length <= 500);
  for (const k of Object.keys(fm.data)) assert.ok(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(k), `unknown field ${k}`);
  assert.ok(skillMd.split('\n').length < 500, 'SKILL.md stays under 500 lines');
  assert.ok(skillMd.length / 4 < 5000, `and under the recommended 5000 tokens (about ${Math.round(skillMd.length / 4)})`);
});

test('every reference is a file SKILL.md links by a relative path, one level deep, and every link leads to one', () => {
  const links = [...skillMd.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  for (const l of links) {
    assert.ok(!path.isAbsolute(l) && !l.includes('..') && !/^[a-z]+:/.test(l), `a relative link: ${l}`);
    assert.ok(fs.existsSync(path.join(dir, l)), `${l} is there`);
  }
  const refs = fs.readdirSync(path.join(dir, 'references')).sort();
  assert.deepEqual(refs, REFERENCES.map((r) => `${r}.md`).sort(), 'the references are the code\'s list');
  assert.deepEqual([...new Set(links.filter((l) => l.startsWith('references/')))].sort(), refs.map((r) => `references/${r}`), 'each linked from SKILL.md');
  for (const r of refs) assert.doesNotMatch(fs.readFileSync(path.join(dir, 'references', r), 'utf8'), /\]\((?!https?:)[^)]+\)/, `${r} links no further file`);
  assert.deepEqual(allFiles(dir).sort(), ['SKILL.md', ...refs.map((r) => `references/${r}`)].sort(), 'nothing else in the skill');
});

const refText = (r) => fs.readFileSync(path.join(dir, 'references', `${r}.md`), 'utf8');

test('the kinds table is the code\'s: the same kinds, in the same order, each with whether the default stack builds it', () => {
  const rows = [...skillMd.matchAll(/^ {3}\| `([a-z-]+)` \| [^|]+ \| (default|propose) \|$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, KINDS.map((k) => [k.id, k.stack]));
  assert.match(skillMd, /The hint is\s+his reading, not the fit: when the\s+brief says otherwise, the fit decides and your one message says so\./, 'a kind given to the tool is a hint');
});

test('the fit is dynamic: one applies line per reference, and every reference opens with the same two lines that decide it', () => {
  // SKILL.md's applies table: one row per reference but structure (always read), linked, with both columns filled.
  const rows = [...skillMd.matchAll(/^ {3}\| \[([a-z]+)\]\(references\/\1\.md\) \| ([^|]+) \| ([^|]+) \|$/gm)].map((m) => m[1]);
  assert.deepEqual(rows, APPLIES, 'one applies line per reference, in the code\'s order');
  assert.deepEqual(REFERENCES, [...ALWAYS_READ, ...APPLIES]);
  assert.match(skillMd, /then \[working\]\(references\/working\.md\), \[fit\]\(references\/fit\.md\), \[finish\]\(references\/finish\.md\)\s+and \[structure\]\(references\/structure\.md\) \(always\), then only the references the applies table marks `full` or `light`/);
  assert.match(skillMd, /Never open a reference whose line says `not needed`/);
  for (const r of REFERENCES) {
    const lines = refText(r).split('\n');
    assert.match(lines[0], /^# /, `${r}: a title`);
    assert.match(lines[2], /^- Applies when/, `${r}: its first line says when it applies`);
    const light = lines.findIndex((l) => l.startsWith('- Light form:'));
    assert.ok(light > 2 && light < 8, `${r}: its next line is its light form`);
  }
  // Only these lines may lighten work, and what protects people or data never is.
  assert.match(skillMd, /Take the value only from these lines: each says what the first two lines of its reference say, so decide\s+from this table alone and never open a reference to decide whether it applies/);
  assert.match(skillMd, /only a "Light form" line may do\s+that/);
  assert.match(refText('working'), /A rule that protects people or data is\s+never made lighter by the kind or the size of a project: security, money, privacy, backups and "done means proven"/);
  assert.match(skillMd, /a rule that protects people or data \(security, money, privacy, backups,\s+"done means proven"\) is never made lighter by the kind or the size of a project/);
  for (const r of ['security', 'testing', 'docs', ...ALWAYS_READ]) assert.match(refText(r), /^- Applies when: always/m, `${r} always applies`);
  // The point of the fit for a tool: a command-line tool or a library has nothing for the ui, search or mobile parts.
  const row = (r) => new RegExp(`^ {3}\\| \\[${r}\\]\\(references/${r}\\.md\\) \\| ([^|]+) \\|`, 'm').exec(skillMd)[1];
  assert.match(row('ui'), /`not needed` for an API or backend only and a command-line tool or library/);
  assert.match(row('search'), /never `not needed` while the project has pages or an API; `not needed` only without either \(a command-line tool, a library\)/);
  assert.match(row('mobile'), /"Mobile apps" is not none: `full`, else `not needed`/);
});

test('both size tiers are the skill\'s, with their numbers, and the checklist counts every rule of what applies', () => {
  for (const [tier, rows, rps] of [['0', 'no database', 'no app server'], ['S', 'under 1 million', 'under 20'], ['M', '1 million to under 100 million', '20 to under 200'], ['L', '100 million to under 1 billion', '200 to under 2,000'], ['XL', '1 billion or more', '2,000 or more']]) {
    assert.match(skillMd, new RegExp(`^ {3}\\| ${tier} \\| ${rows}[^|]* \\| ${rps}[^|]* \\|$`, 'm'), `tier ${tier}`);
  }
  // A checklist row is "<reference>.<n>": so every reference numbers its rules 1, 2, 3 … without a gap.
  for (const r of REFERENCES) {
    const nums = [...refText(r).matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    assert.ok(nums.length > 0, `${r} numbers its rules`);
    assert.deepEqual(nums, nums.map((_, i) => i + 1), `${r}: rules 1 to ${nums.length} without a gap`);
  }
  assert.match(skillMd, /`ui\.7` is the seventh rule of the ui\s+reference/);
  // One row per rule, never folded: the owner's prompt gives no row that stands for several rules, but the one of a
  // `not needed` reference; the steps of the work order and the points of the final review and report are rows too.
  assert.doesNotMatch(skillMd, /stands\s+for|may be one such\s+row|how many rules/);
  assert.match(skillMd, /\(each step of the work order is a row\)/);
  assert.match(skillMd, /\[finish\]\(references\/finish\.md\) \(each point of the\s+final review and each point of the final report is a row\)/);
  assert.match(skillMd, /never a numbering of your own/);
  assert.match(skillMd, /each rule its light form drops keeps its own row too, marked\s+`dropped: light form`/);
  assert.match(skillMd, /A `not needed` reference has one row with its reason; no other row covers more than one\s+rule\./);
});

test('the scope: the whole product by default, or the set-up only, and the code offers the same two', () => {
  assert.deepEqual(SCOPES.map((x) => x.id), ['product', 'setup']);
  assert.match(refText('fit'), /\| Scope \| whole product \(default\), or set-up only \|/);
  const setupOnly = /\*\*Set-up only\*\* \(the scope says so\):([\s\S]*?)\n\n/.exec(skillMd)[1];
  assert.match(setupOnly, /^ do steps 1 to 3, [\s\S]*then the final report, and stop\. Build no\s+feature of the brief/);
  // What the short set-up file's set-up holds: the deployment, environment and assets documents (each app's own too),
  // and, in the foundation of step 3, the mail and storage modules and the base of search.
  for (const d of ['ENVIRONMENT.md', 'DEPLOYMENT.md', 'ASSETS.md', 'CONFIG.md', 'STORE_SUBMISSION.md']) assert.ok(setupOnly.includes(`\`${d}\``), `set-up only writes ${d}`);
  assert.match(setupOnly, /the documents of \[docs\]\(references\/docs\.md\) for what the foundation has/);
  assert.match(skillMd, /^3\. Only after the documents' commit \(the gate of step 4\): the foundation of each code repository:[\s\S]*?the mail and storage modules with their\s+settings where the details name them[\s\S]*?the base of\s+search/m);
  assert.match(skillMd, /This holds\s+when the scope is set-up only too: the rows of what a later session builds are written now and stay open with "next\s+session"/);
  assert.match(skillMd, /Do this for every project, also when the scope is set-up only, before the one message\./);
});

test('the one message has its six points in order, and a later change of the project is fitted again first', () => {
  const at = skillMd.indexOf('### 3. Ask once');
  const part = skillMd.slice(at, skillMd.indexOf('### 4.', at));
  const starts = ['1. The filled details table.', '2. Your short understanding', '3. The fit:', '4. Features the use case needs', '5. Only the questions', '6. Missing tools and sign-ins'];
  const where = starts.map((s) => part.indexOf(s));
  assert.ok(where.every((i) => i > 0), 'all six points');
  assert.deepEqual([...where].sort((a, b) => a - b), where, 'in this order');
  assert.match(part, /Then wait for his reply\. It is the only planned stop\./);
  assert.match(skillMd, /When a later instruction changes the project [\s\S]*fit again before you build/);
});

test('its list of what `hoprig project new` makes is what a real run makes, and its code repositories are what `project add` makes', async () => {
  const brief = path.join(t.root, 'brief.md');
  fs.writeFileSync(brief, 'A small tool.\n');
  const ui = await quietUi();
  assert.equal(await projectNew(['probe', '--brief', brief, '--kind', 'cli', '--no-github'], { ui }), 0, ui.text());
  const root = path.join(t.ws, 'projects', 'probe');
  const structure = fs.readFileSync(path.join(dir, 'references/structure.md'), 'utf8');
  const block = /<!-- made-by-hoprig:start -->\n```text\n([\s\S]*?)```\n<!-- made-by-hoprig:end -->/.exec(structure);
  assert.ok(block, 'the list is marked');
  const listed = block[1].trim().split('\n').map((l) => l.split(/\s+/)[0]);
  const made = allFiles(root).filter((f) => !f.startsWith('.git/'));
  for (const p of listed) assert.ok(fs.existsSync(path.join(root, p)) && (p.endsWith('/') ? fs.statSync(path.join(root, p)).isDirectory() : fs.statSync(path.join(root, p)).isFile()), `the skill names ${p}: Hoprig makes it`);
  for (const f of made) assert.ok(listed.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)) || f === '.claude/skills/.hoprig-skills.json', `Hoprig makes ${f}: the skill names it`);
  // The five documents of step 4: the two Hoprig makes are there, and the skill says to write all five before code.
  for (const d of [BRIEF_FILE, 'decisions.md']) assert.ok(fs.existsSync(path.join(root, d)));
  for (const d of ['docs/brief.md', 'docs/flows.md', 'docs/test-matrix.md', 'docs/checklist.md', 'decisions.md']) assert.match(skillMd, new RegExp(`- \`${d.replace('.', '\\.')}\``), d);
  // Code repositories: code/<folder>-<part>, by `hoprig project add <folder> <part>`, as the skill says.
  assert.equal(await projectAdd(['probe', 'web'], { ui }), 0, ui.text());
  assert.ok(fs.existsSync(path.join(root, 'code', 'probe-web', '.git')));
  for (const text of [refText('fit'), structure]) assert.match(text, /code\/<folder>-<part>[\s\S]*hoprig project add <folder> <part>/);
  assert.match(refText('fit'), /\| Project folder \| the project's folder name, as `hoprig project new` made it \|/);
  // Later sessions keep the skill as the rule book: the parent's AGENTS.md names the memory, the brief, the applies
  // table and the skill (every coding tool reads AGENTS.md; a skill only when its description fits), and the skill
  // says so where it builds the parent and where it says when to use it.
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.endsWith(EVERY_SESSION), 'AGENTS.md ends with its part "Every session"');
  for (const f of ['ai_brain/learnings.md', 'ai_brain/active_context.md', 'docs/brief.md', 'decisions.md', 'docs/checklist.md', '.claude/skills/new-project']) assert.ok(EVERY_SESSION.includes(`\`${f}\``), `"Every session" names ${f}`);
  assert.match(skillMd, /`AGENTS\.md` with the real commands and its part "Every session"/);
  assert.match(structure, /^6\. After the set-up, this skill stays the rule book\. The parent's `AGENTS\.md` says so in its part "Every session"/m);
  assert.match(fm.data.description, /in every later session of a project set up with it/);
  // The parent's .gitignore keeps what the owner's prompt keeps out (a Mac's .DS_Store too), and the skill says so.
  const ignored = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
  for (const p of ['/code/*', '/test-data/', '.env', '.env.*', '.DS_Store']) assert.ok(ignored.includes(p), `.gitignore: ${p}`);
  assert.match(structure, /^\.gitignore +code\/\*, test data, \.env files and \.DS_Store stay out of the parent$/m);
  // A folder with more than Hoprig made: nothing of it is touched, and it is listed in the one message.
  assert.match(skillMd, /if anything else is there, touch nothing of it and list it at the end of\s+that message/);
});

test('nothing in it would stop a review, and nothing in it is anyone\'s own', () => {
  const scan = scanSkill(dir, { hash: sha256 });
  assert.deepEqual(scan.findings.filter((f) => f.severity === 'block'), []);
  for (const f of allFiles(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(text, /\/(home|Users)\/[a-z]/i, `${f}: no machine path`);
    assert.doesNotMatch(text, /[\w.-]+@[\w-]+\.[a-z]{2,}/i, `${f}: no e-mail address`);
    assert.doesNotMatch(text, /\{\{project\}\}|\{\{Project\}\}/, `${f}: no template placeholder (the template would fill it)`);
    assert.doesNotMatch(text, /[\u2028\u2029\u200b-\u200f\u202a-\u202e]/, `${f}: no invisible character`);
  }
});

test('the default stack is named, so any other choice is a stack change that waits for the owner\'s ok', () => {
  const stack = /## The stack\n\n7\. ([\s\S]*?)Another choice is right only/.exec(refText('fit'))[1].replace(/\s+/g, ' ');
  assert.match(skillMd, /\*\*The stack\*\* is the default of \[fit\]\(references\/fit\.md\)[\s\S]*?Any other choice is a stack change: it goes into point 3 of the one\s+message with its reason and waits for his ok\./);
  for (const tech of ['Next.js (App Router)', 'TypeScript strict', 'Tailwind CSS with shadcn/ui', 'PostgreSQL', 'plain SQL (no ORM)', 'Zod', 'Vitest', 'Playwright', 'Lighthouse CI', 'gitleaks', 'k6', 'Flutter through FVM with Riverpod']) assert.ok(stack.includes(tech), `the default names ${tech}`);
  assert.doesNotMatch(stack, /for example/, 'a default, not an example');
  assert.match(stack, /unless the owner's defaults file names another \(then his holds\)/);
  assert.match(stack, /Any other choice than the default \(also a pick where the brief names no technology\) is a stack change: it goes into point 3 of the one message with its reason and waits for his ok/);
  const mobile = refText('mobile');
  assert.match(mobile, /The framework is the default stack's \(SKILL\.md, the stack\): Flutter through FVM/);
  assert.match(mobile, /Any other framework is a stack change that\s+goes into the one message with its reason and waits for his ok/);
});

test('the documents come before any code, as a gate the AI can check: committed in the parent before anything in code/', () => {
  assert.match(skillMd, /The gate: nothing is created under `code\/` \(no repository, no scaffold, no file\) until `docs\/flows\.md`,\s+`docs\/test-matrix\.md`, `docs\/checklist\.md` and `decisions\.md` are written in full and committed in the parent\. The\s+first commit in `code\/` comes after that commit\./);
  assert.match(skillMd, /^3\. Only after the documents' commit \(the gate of step 4\):/m, 'the work order\'s foundation step waits for it');
});

test('a brief that contradicts itself is named and asked about, never resolved silently', () => {
  const ask = skillMd.slice(skillMd.indexOf('5. Only the questions'), skillMd.indexOf('6. Missing tools'));
  assert.match(ask, /Two lines of the brief that\s+cannot both hold: quote both, and ask which holds, with your recommended answer\. Never pick one silently\./);
});

test('no brief yet: the skill says what to do, by the same part name Hoprig writes into AGENTS.md', async () => {
  const { NO_BRIEF_YET } = await import('../../src/pcsetup/newproject.mjs');
  assert.match(NO_BRIEF_YET, /^## No brief yet\n/);
  const step = skillMd.slice(skillMd.indexOf('- No brief yet:'), skillMd.indexOf('## Read first'));
  assert.ok(step.length > 20, 'the skill has a step "No brief yet"');
  assert.match(step, /Hoprig adds this skill to every new project/);
  assert.match(step, /write it unchanged\s+into `docs\/brief\.md`/);
  assert.match(step, /Replace the part "No brief yet" of `AGENTS\.md` with "Every session"/);
  assert.doesNotMatch(skillMd, /No brief at all: ask the owner for it and do nothing else/, 'the old line is gone');
});

test('a hint for the kind is quoted only when the first message gives one', () => {
  assert.match(skillMd, /3\. The fit: the kind \(and, only when the first message names a hint and the fit differs from it, that it differs\s+and why; a first message with no kind gives no hint to quote\)/);
  assert.doesNotMatch(skillMd, /when it differs from his hint/);
});
