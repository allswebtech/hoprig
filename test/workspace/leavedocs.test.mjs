// docs/WORKSPACE.md "Before you format this computer" names every route of src/workspace/leavefeature.mjs (read from
// its routes table, as test/docs-claims-docs.test.mjs does for feature.mjs); the page's title is the same in
// web/leave.js and in that section; the 0.3.4 entry of the changelog has its item.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const TITLE = 'Before you format this computer';
/** The text of one "## " section of a Markdown file, up to the next "## ". */
const part = (file, head) => {
  const t = read(file);
  const at = t.indexOf(`\n## ${head}\n`);
  assert.ok(at >= 0, `${file} has the section "${head}"`);
  const next = t.indexOf('\n## ', at + 4);
  return t.slice(at, next < 0 ? undefined : next).replace(/\s+/g, ' ');
};

test('every route of the feature is named in the section', () => {
  const src = read('src/workspace/leavefeature.mjs');
  const routes = [...src.matchAll(/\['(GET|POST)', \/\^((?:\\\/|[a-z])+)\$\//g)].map((m) => [m[1], m[2].replace(/\\\//g, '/')]);
  assert.equal(routes.length, 3, 'the feature has its three routes');
  const page = part('docs/WORKSPACE.md', TITLE);
  for (const [method, p] of routes) assert.match(page, new RegExp(`\`${method} ${p.replace(/\//g, '\\/')}\``), `${method} ${p} is named`);
});

test('the page\'s title is in web/leave.js and in the section; the section comes after Drop', () => {
  assert.match(read('web/leave.js'), new RegExp(`export const TITLE = '${TITLE}';`));
  const doc = read('docs/WORKSPACE.md');
  assert.ok(doc.indexOf(`## ${TITLE}`) > doc.indexOf('## Drop: a project leaves this computer safely'));
  assert.match(part('docs/WORKSPACE.md', TITLE), /Computers, \*\*Before you format this computer\*\*/);
});

test('the 0.3.4 entry of the changelog has the item', () => {
  const log = read('site/content/changelog.md');
  const entry = log.slice(log.indexOf('\n## 0.3.4 '), log.indexOf('\n## 0.3.3 '));
  assert.match(entry, /\*\*Before you format this computer, one check says what would be lost\.\*\*/);
  assert.match(entry, /\*\*Push my other branches\*\*/);
  const item = entry.slice(entry.indexOf('**Before you format this computer')).split('\n')[0];
  assert.doesNotMatch(item, /Every day|Once a week/, 'no daily or weekly look is promised');
});
