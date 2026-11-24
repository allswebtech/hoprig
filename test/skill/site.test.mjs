// For AI readers: the site publishes the skill itself as Markdown (/skill/SKILL.md and its reference beside it), and
// llms.txt and the skill's page say how an AI gets it (npx hoprig-skill, hoprig skills).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { siteFiles } from '../../site/scripts/after-build.mjs';
import { notHeld, npxNames } from '../../tools/npx-held.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// What the site publishes, from its content layer: the pages' HTML bodies and the files written beside them (the
// Next pages put each body in as it stands, in their frame).
const { pages, files } = await siteFiles(ROOT);
const read = (rel) => {
  if (rel.endsWith('/index.html')) return pages.find((p) => p.url === `/${rel.slice(0, -'index.html'.length)}`).body;
  if (!files.has(rel)) throw new Error(`the site does not publish ${rel}`);
  return String(files.get(rel));
};

test('the skill is a page of the site as Markdown, exactly as it ships, with its reference beside it', () => {
  assert.equal(read('skill/SKILL.md'), fs.readFileSync(path.join(ROOT, 'templates/skills/hoprig/SKILL.md'), 'utf8'));
  assert.equal(read('skill/references/commands.md'), fs.readFileSync(path.join(ROOT, 'templates/skills/hoprig/references/commands.md'), 'utf8'));
});

test('llms.txt and the skill\'s page say how an AI gets the skill', () => {
  const llms = read('llms.txt');
  assert.match(llms, /\(https:\/\/hoprig\.com\/skill\/SKILL\.md\)/);
  assert.match(llms, /npx hoprig-skill --claude/);
  assert.match(llms, /hoprig skills add hoprig --user/);
  for (const page of [read('skill/index.html'), read('skill.md')]) {
    assert.match(page, /npx hoprig-skill --claude/);
    assert.match(page, /\/skill\/SKILL\.md/);
    assert.match(page, /hop skills update/);
    assert.doesNotMatch(page, /Coming:/, 'the package is no longer "coming"');
  }
});

test('the site is not deployed while it names an npx package that npm does not have (anyone could take the name)', () => {
  const texts = ['llms.txt', 'skill/index.html', 'skill.md'].map(read).join('\n');
  assert.ok(npxNames(texts).includes('hoprig-skill'));
  assert.deepEqual(npxNames('run `npx -y @scope/tool-x --flag` or npx hoprig-skill. Not npxfoo bar'), ['@scope/tool-x', 'hoprig-skill']);
  assert.deepEqual(notHeld(['hoprig', 'hoprig-skill'], (n) => n === 'hoprig'), ['hoprig-skill']);
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/site.yml'), 'utf8');
  const build = wf.indexOf('run: npm run build');
  const held = wf.indexOf('run: node tools/npx-held.mjs site/out');
  const upload = wf.indexOf('upload-pages-artifact');
  assert.ok(build > 0 && held > build && upload > held, 'site.yml checks the built site before it uploads it');
});

test('the skill page says how to add it before anything else, with a link to the details', () => {
  for (const page of [read('skill/index.html'), read('skill.md')]) {
    const first = page.search(/<h2|^## /m);
    const intro = page.slice(0, first);
    assert.match(intro, /npx hoprig-skill --claude/);
    assert.match(intro, /hop skills add hoprig --user/);
    assert.match(intro, /#how-to-add-it/);
  }
  assert.match(read('skill/index.html'), /<h2 id="how-to-add-it">/);
});
