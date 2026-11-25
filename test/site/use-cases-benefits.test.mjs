// The benefits the use cases name, held to what does them: the list "What you get" is the same on the use-cases page,
// in the README and in llms.txt, each line linking to a section that exists; the AI team's roles are the folders of
// roles/; what is not built stands under "Coming"; Learn skills is off at first and its numbers are the code's; and
// every press these sections name is a word of the dashboard's page (web/).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { frontMatter, makeSlugger, plainText } from '../../site/lib/markdown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const CASES = 'site/content/use-cases';
const TEAM = `${CASES}/ai-team.md`;
const MESSY = `${CASES}/messy-ai-project.md`;
const READY = `${CASES}/production-ready.md`;
const SITE = 'https://hoprig.com';

/** The part of a Markdown text under the `## ` heading that starts with `title`, up to the next `## `. */
const section = (md, title) => {
  const at = md.split(/^(?=## )/m).find((s) => s.startsWith(`## ${title}`));
  assert.ok(at, `a section "## ${title}…"`);
  return at;
};
/** The ids the site gives a page's headings (site/lib/markdown.mjs, the h1 included). */
const anchorsOf = (md) => {
  const slug = makeSlugger();
  return new Set([...frontMatter(md).body.matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => slug(plainText(m[1]))));
};
/** The lines of a "- [question](link): answer" list that follows `head` (a heading or a line of its own). */
const listAfter = (md, head) => {
  const at = md.indexOf(head);
  assert.ok(at >= 0, `"${head}" is there`);
  const m = /\n\n((?:- \[.*\n)+)/.exec(md.slice(at));
  assert.ok(m, `a list after "${head}"`);
  return m[1].trim().split('\n');
};

// His list of benefits, each with the page section that tells it.
const BENEFITS = [
  ['/use-cases/review-ai-changes/#what-hoprig-does', /write the code for me/],
  ['/use-cases/messy-ai-project/#what-hoprig-does', /in order from day one/],
  ['/use-cases/not-a-developer/#what-hoprig-does', /sets up my computer/],
  ['/use-cases/team-machines/#what-hoprig-does', /several computers/],
  ['/use-cases/code-from-your-phone/#what-hoprig-does', /from my phone/],
  ['/use-cases/production-ready/#what-hoprig-does', /ready for real use/],
  ['/use-cases/production-ready/#easy-safe-fast-and-ready-to-grow', /skills and tools/],
  ['/use-cases/messy-ai-project/#when-the-project-grows', /project grows/],
  ['/use-cases/messy-ai-project/#your-ai-brain-and-what-it-learns', /AI brain learn/],
  ['/use-cases/production-ready/#easy-safe-fast-and-ready-to-grow', /easy, safe and fast/],
  ['/use-cases/new-computer/#what-hoprig-does', /another computer/],
  ['/use-cases/new-computer/#what-hoprig-does', /come back from git/],
  ['/use-cases/two-computers-one-workspace/#what-hoprig-does', /stay in step/],
  ['/use-cases/ai-team/#what-exists-today', /AI team/],
  ['/use-cases/ai-team/#coming', /^Coming: .*whole business/],
];
const INDEX_LIST = () => listAfter(read(`${CASES}/index.md`), '## What you get');

test('"What you get" names every benefit, each linking to a use case and a heading of it', () => {
  const lines = INDEX_LIST();
  assert.equal(lines.length, BENEFITS.length, 'one line per benefit');
  for (const [i, [href, words]] of BENEFITS.entries()) {
    const m = /^- \[([^\]]+)\]\(([^)]+)\): (.+)$/.exec(lines[i]);
    assert.ok(m, `line ${i + 1} is "- [question](link): answer"`);
    assert.match(m[1], /\?$/, `${m[1]}: a question`);
    assert.match(m[1], words, `line ${i + 1}: ${m[1]}`);
    assert.equal(m[2], href, `${m[1]}: its link`);
    const [page, hash] = href.replace(/^\/use-cases\//, '').split('#');
    const file = `${CASES}/${page.replace(/\/$/, '')}.md`;
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    assert.ok(anchorsOf(read(file)).has(hash), `${file} has a heading for #${hash}`);
  }
  // The first sentence says the presses come first and the commands second.
  const lead = flat(frontMatter(read(`${CASES}/index.md`)).body);
  assert.doesNotMatch(lead, /step by step with the real commands/);
  assert.match(lead, /what you press in the dashboard first, then the command for a terminal/);
});

test('the README\'s "Who it is for" and llms.txt carry the same lines, with hoprig.com links', async () => {
  const want = INDEX_LIST().map((l) => l.replace(/\]\((\/[^)]*)\)/, `](${SITE}$1)`));
  const readme = read('README.md');
  const who = readme.slice(readme.indexOf('## Who it is for'), readme.indexOf('\n## ', readme.indexOf('## Who it is for') + 3));
  assert.deepEqual(listAfter(who, 'What you get'), want, 'the README');
  const { loadPages } = await import('../../site/lib/pages.mjs');
  const { llmsTxt } = await import('../../site/lib/seo.mjs');
  const llms = llmsTxt(await loadPages(ROOT), { version: '0.0.0' });
  assert.deepEqual(listAfter(llms, '## What you get'), want, 'llms.txt');
  assert.match(llms, /## What you get\n[\s\S]*## What it does not do\n/, 'before what it does not do');
});

test('the AI team page names exactly the roles of roles/, each with the name the Team tab shows', () => {
  const today = section(read(TEAM), 'What exists today');
  const named = [...today.matchAll(/^- \*\*([A-Z][a-z]+)\*\*:/gm)].map((m) => m[1]);
  const folders = fs.readdirSync(path.join(ROOT, 'roles')).filter((f) => fs.existsSync(path.join(ROOT, 'roles', f, 'ROLE.md'))).sort();
  assert.deepEqual(named.map((n) => n.toLowerCase()).sort(), folders);
  // The Team tab's own words for them (web/mission.js ROLE_WORDS), and Team is a tab of Work.
  const mission = read('web/mission.js');
  const words = /const ROLE_WORDS = (\{[^}]*\})/.exec(mission)[1];
  for (const n of named) assert.ok(words.includes(`'${n}'`), `${n} is the Team tab's name`);
  assert.match(read('web/work.js'), /\['team', 'Team', '[a-z]+'\]\];/, 'Team is a tab of Work');
  // Each role's line says what its ROLE.md purpose says: the reviewer changes nothing, ops runs nothing.
  assert.match(read('roles/reviewer/ROLE.md'), /^readonly: yes$/m);
  assert.match(today, /- \*\*Reviewer\*\*: [^\n]*changing nothing/);
  assert.match(read('roles/ops/ROLE.md'), /^purpose: Writes down what would have to be run/m);
  assert.match(today, /- \*\*Ops\*\*: writes down what would have to be run[^\n]*it runs nothing/);
});

test('the AI team page: what is off at first is off in the defaults, and what stays yours is what the code holds', async () => {
  const today = flat(section(read(TEAM), 'What exists today'));
  const { DEFAULTS, stepsOf } = await import('../../src/mission/settings.mjs');
  assert.equal(DEFAULTS.on, false);
  assert.equal(DEFAULTS.capUsd, 0);
  assert.deepEqual(DEFAULTS.providers, []);
  assert.deepEqual(DEFAULTS.projects, {});
  assert.ok(stepsOf(DEFAULTS).every((s) => !s.done), 'nothing of hers starts with the defaults');
  assert.match(today, /turn on \*\*Tia works by herself\*\*, turn on your project under \*\*Projects\*\*, set a \*\*Spend cap per day \(\$\)\*\* above 0, and tick a provider .* under \*\*Providers\*\*\. All of them are off or empty at first/);
  assert.match(read('src/mission/engine.mjs'), /Nothing here merges, pushes or moves a default branch\./);
  assert.match(today, /nothing of a mission merges into your main branch, uploads \(pushes\), deletes, releases or sends anything out/);
});

test('every sentence about a business, sales, social media posts or a whole business stands under "Coming"', () => {
  const RE = /\bsales\b|social media|\bposts?\b|whole business|business beyond/i;
  const { data, body } = frontMatter(read(TEAM));
  assert.notEqual(data.coming, true, 'the page is mostly live: only its section is coming');
  assert.match(section(body, 'Coming'), /^## Coming\n\nNot built yet, and no date is promised\./);
  for (const part of body.split(/^(?=## )/m)) {
    if (part.startsWith('## Coming')) continue;
    assert.doesNotMatch(part, RE, `ai-team.md: "${part.split('\n')[0]}"`);
  }
  // The answer AI tools read (llms.txt, schema.org): the future part after "Coming".
  const answer = String(data.answer);
  assert.ok(RE.test(answer) && answer.search(RE) > answer.indexOf('Coming, not built yet:') && answer.includes('Coming, not built yet:'), 'the answer');
  // The lists: a line about it says "Coming" first.
  const readme = read('README.md');
  const who = readme.slice(readme.indexOf('## Who it is for'), readme.indexOf('## Install'));
  for (const [name, text] of [['index.md', read(`${CASES}/index.md`)], ['README', who], ['messy', read(MESSY)], ['ready', read(READY)]]) {
    for (const line of text.split('\n').filter((l) => RE.test(l))) {
      assert.match(line, /^- \[Coming: |Roles beyond code are coming\.$/, `${name}: ${line.slice(0, 80)}`);
    }
  }
});

test('Learn skills is off at first, and the brain section\'s numbers are the code\'s', async () => {
  const learn = flat(section(read(MESSY), 'Your AI brain, and what it learns'));
  const set = await import('../../src/skillhub/learnset.mjs');
  assert.equal(set.readLearnSettings().on, false, 'off in a fresh state folder');
  assert.equal(set.DRAFTS_PER_WEEK, 3);
  assert.equal(set.PER_WEEK_MAX, 20);
  assert.equal(set.PER_WEEK_DEFAULT, 5);
  assert.match(learn, /\*\*Learn skills from my work\*\*, off until you turn it on/);
  assert.match(learn, /1 to 20 looks a week \(5 by default\)/);
  assert.match(learn, /at most three drafts a week/);
  assert.match(read('web/skilllearned.js'), /toggle\('Learn skills from my work', s\.on,/);
  assert.match(read('web/skilllearned.js'), /'Off until you turn it on\. Only a result you send back in Work, or one you accept and mark “Learn from this”, is looked at, never every session\.'/);
  assert.match(learn, /a result you sent back with your words, or one you accepted and marked with \*\*Learn from this\*\*\. Never every session\./);
});

test('the growth section names what keeps a project in order, and says what it does not do', () => {
  const grow = flat(section(read(MESSY), 'When the project grows'));
  const layout = read('src/workspace/layout.mjs');
  for (const id of ['ai_brain', 'projects', 'credentials', 'development', 'database', 'backups']) assert.match(layout, new RegExp(`\\{ id: '${id}'`), id);
  for (const t of ['What your coding tools are told everywhere', 'Memory', 'Learnings and current context', 'Daily logs']) {
    assert.ok(read('web/brain.js').includes(`title: '${t}'`), `the AI brain page has "${t}"`);
    assert.ok(grow.includes(`"${t}"`), `the page names "${t}"`);
  }
  assert.match(grow, /It does not design your code's structure for you/);
  assert.match(grow, /the AI's work still needs your review/);
});

test('the easy, safe, fast section is bound to the skills and kinds of the tree, and scale is said as not measured', () => {
  const ready = read(READY);
  const part = flat(section(ready, 'Easy, safe, fast, and ready to grow'));
  const catalog = JSON.parse(read('src/skillhub/catalog.json')).entries.map((e) => e.id);
  for (const id of ['security-audit', 'react-best-practices', 'next-bundle-optimizer', 'postgres-best-practices', 'new-project']) assert.ok(catalog.includes(id), id);
  assert.match(part, /a security audit/);
  assert.match(read('src/pcsetup/newproject.mjs'), /id: 'multi-tenant', phrase: 'a product for many businesses, or a marketplace'/);
  assert.match(part, /One of its kinds is a product for many businesses, or a marketplace/);
  assert.match(read('templates/skills/new-project/references/testing.md'), /another user's or tenant's data \(must fail\)/);
  assert.match(read('templates/skills/new-project/references/performance.md'), /A load test \(k6, or autocannon through npx\) on the production build/);
  const notDo = section(ready, 'What it does not do').trim().split('\n');
  assert.match(notDo[notDo.length - 1], /^- Hoprig does not measure load or scale for you/, 'the last line of what it does not do');
});

test('every press these sections name is a word of the dashboard, where the page says it is; a command comes after a press', () => {
  const web = fs.readdirSync(path.join(ROOT, 'web'), { recursive: true }).filter((f) => String(f).endsWith('.js'))
    .map((f) => read(path.join('web', String(f)))).join('\n').replace(/\\'/g, "'");
  const parts = [section(read(TEAM), 'What exists today'), section(read(MESSY), 'When the project grows'), section(read(MESSY), 'Your AI brain, and what it learns'), section(read(READY), 'Easy, safe, fast, and ready to grow')];
  const presses = new Set(parts.flatMap((p) => [...p.matchAll(/\*\*([^*]+)\*\*/g)].flatMap((m) => m[1].split(' → '))));
  assert.ok(presses.size > 25, 'the presses are found');
  for (const w of presses) assert.ok(new RegExp(`['"\`]${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(web), `"${w}" is a word of web/`);
  // The ways to them: the tabs and pages as the sections say.
  assert.match(read('web/skillhub.js'), /\['suggested', 'Suggested'\].*\['learned', 'Learned'\]/);
  assert.match(read('web/skilllearned.js'), /id: 'learn', title: 'Learn skills'/);
  assert.match(read('web/workspace.js'), /registerSettingsPage\(\{ id: 'workspace', title: 'Workspace'/);
  assert.match(read('web/pc.js'), /\{ id: 'setup', title: 'Setup'/);
  assert.match(read('web/work.js'), /\['plans', 'Plans', '[a-z]+'\]/);
  assert.ok(read('src/pcsetup/status.mjs').includes("'Working rules', 'info'"), 'the row "Working rules"');
  // A line that names a command names its press first.
  for (const p of parts) for (const line of p.split('\n').filter((l) => /`hop /.test(l))) assert.ok(line.indexOf('**') >= 0 && line.indexOf('**') < line.indexOf('`hop '), line.slice(0, 80));
});
