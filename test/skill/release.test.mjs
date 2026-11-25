// A release is a tag (.github/workflows/release.yml): v<version> equal to package.json's version, with a changelog
// section, the hoprig-skill package at the same version; the notes are that section. The workflow publishes only
// when the owner turned NPM_PUBLISH on, through trusted publishing, and never with a stored token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from '../../tools/release-notes.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const version = JSON.parse(read('package.json')).version;
// As on the day of a release: its heading carries the date (RELEASING.md step 1), never "(not released yet)".
const changelog = read('site/content/changelog.md').replace(`## ${version} (not released yet)`, `## ${version} (1 May 2027)`);
const ok = { tag: `v${version}`, version, skillVersion: version, changelog };

test('the notes are the changelog section of the tag\'s version, with full addresses for site links', () => {
  const { notes } = releaseNotes(ok);
  assert.ok(notes.length > 100);
  assert.doesNotMatch(notes, /^## /m, 'only that section, without its heading');
  assert.ok(changelog.includes(notes.trim().split('\n')[0]));
  assert.doesNotMatch(notes, /\]\(\/[^)]/, 'no site-relative link');
  const one = releaseNotes({ ...ok, tag: 'v1.2.3', version: '1.2.3', skillVersion: '1.2.3', changelog: '# Changelog\n\n## 1.2.3 (1 May 2027)\n\nSee [Work](/docs/work/).\n\n## 1.2.2\n\nolder\n' });
  assert.equal(one.notes, 'See [Work](https://hoprig.com/docs/work/).\n');
});

test('notes longer than a release page holds are cut at a section, and the rest is named with the changelog at that tag', async () => {
  const { fitNotes, NOTES_MAX } = await import('../../tools/release-notes.mjs');
  assert.ok(NOTES_MAX < 125_000, 'under what a GitHub release page holds');
  assert.equal(fitNotes('short\n\n### One\n\n- a', 'v1.2.3'), 'short\n\n### One\n\n- a', 'notes that fit are not touched');
  const long = `An opening line.\n\n### One\n\n- ${'a'.repeat(300)}\n\n### Two\n\n- ${'b'.repeat(300)}\n\n### Three\n\n- c`;
  const cut = fitNotes(long, 'v1.2.3', 500);
  assert.ok(cut.startsWith('An opening line.\n\n### One\n\n- aaa'), 'the leading sections stay whole');
  assert.ok(!cut.includes('bbb') && !cut.includes('- c'), 'a section that does not fit is left out whole, and so is every later one');
  assert.ok(cut.endsWith('### The rest of this version\n\nThis version changed more than a release page holds. The whole list is in [the changelog](https://github.com/allswebtech/hoprig/blob/v1.2.3/site/content/changelog.md), with these sections that are not on this page: Two; Three.'));
  // The real changelog: every released section gives notes a release page holds.
  const changelog = fs.readFileSync(new URL('../../site/content/changelog.md', import.meta.url), 'utf8');
  for (const [, version] of changelog.matchAll(/^## (\d+\.\d+\.\d+) \(\d/gm)) {
    const { notes } = releaseNotes({ tag: `v${version}`, version, skillVersion: version, changelog });
    assert.ok(notes.length < 125_000, `${version}: ${notes.length} characters`);
  }
});

test('a tag that is not the version, a missing or empty section, or a skill package behind is refused', () => {
  assert.throws(() => releaseNotes({ ...ok, tag: version }), /not a release tag/);
  assert.throws(() => releaseNotes({ ...ok, tag: 'v99.0.0' }), /not the version in package\.json/);
  assert.throws(() => releaseNotes({ ...ok, tag: `v${version}-rc1` }), /not a release tag/);
  assert.throws(() => releaseNotes({ ...ok, skillVersion: '0.0.0' }), /hoprig-skill.*build-skill/);
  assert.throws(() => releaseNotes({ ...ok, changelog: changelog.replace(`## ${version} `, '## x ') }), /no section/);
  assert.throws(() => releaseNotes({ ...ok, tag: 'v1.0.0', version: '1.0.0', skillVersion: '1.0.0', changelog: '## 1.0.0 (1 May)\n\n## 0.9.0\n\nolder\n' }), /empty/);
});

test('the release workflow: on a v tag, tests before the release, publish only when NPM_PUBLISH is on, no stored token', () => {
  const wf = read('.github/workflows/release.yml');
  assert.doesNotMatch(wf, /\t/, 'YAML is indented with spaces');
  assert.match(wf, /^on:\n {2}push:\n {4}tags: \['v\*'\]$/m);
  // A pushed tag starts it, or the owner from a tag that is there (to finish a release); never a pull request.
  assert.doesNotMatch(wf, /pull_request/);
  // No typed tag: npm's provenance names the run's own ref and commit, so a run from main with a tag typed in would
  // say the tag's files were built from main's newest commit. The tag is the run's own ref, and check refuses any other.
  assert.match(wf, /^ {2}workflow_dispatch:\n\n/m);
  assert.doesNotMatch(wf, /inputs\./);
  assert.match(wf, /^env:\n {2}TAG: \$\{\{ github\.ref_name \}\}$/m);
  const job = (name) => {
    const m = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[a-z-]+:\\n|(?![\\s\\S]))`, 'm').exec(wf);
    assert.ok(m, `job ${name}`);
    return m[1];
  };
  const check = job('check');
  assert.match(check, /if \[ "\$GITHUB_REF" != "refs\/tags\/\$TAG" \]; then\n[^\n]*::error::[^\n]*\n\s*exit 1/);
  assert.ok(check.indexOf('GITHUB_REF') < check.indexOf('actions/checkout'), 'refused before anything else');
  assert.match(check, /node tools\/release-notes\.mjs "\$TAG"/);
  // Only a commit of main is released: its whole history is fetched, and the tag's commit must be on it.
  assert.match(check, /fetch-depth: 0/);
  assert.match(check, /git merge-base --is-ancestor "\$\(git rev-parse "refs\/tags\/\$TAG\^\{commit\}"\)" origin\/main/);
  assert.ok(check.indexOf('merge-base') < check.indexOf('npm test'));
  assert.match(check, /- run: npm test/);
  assert.ok(check.indexOf('release-notes') < check.indexOf('npm test'), 'the cheap check first');
  const release = job('release');
  assert.match(release, /needs: check/);
  assert.match(release, /contents: write/);
  assert.match(release, /gh release create "\$TAG" .*--notes-file/);
  // Every step can run again: a release that is there is left as it is.
  assert.match(release, /if gh release view "\$TAG"[\s\S]*else\n\s*gh release create/);
  const publish = job('publish');
  assert.match(publish, /needs: release/);
  assert.match(publish, /if: vars\.NPM_PUBLISH == 'on'/);
  assert.match(publish, /id-token: write/);
  assert.equal((publish.match(/npm publish --provenance --access public/g) || []).length, 2, 'both packages');
  // A version on npm already is skipped, so a re-run gets past the package that went out and publishes the other.
  for (const name of ['hoprig', 'hoprig-skill']) {
    assert.match(publish, new RegExp(`if \\[ "\\$\\(npm view "${name}@\\$\\{TAG#v\\}" version 2>/dev/null\\)" = "\\$\\{TAG#v\\}" \\]; then\\n[^\\n]*skipped[\\s\\S]*?else\\n\\s*npm publish`), name);
  }
  assert.match(publish, /^ {4}environment: npm$/m, 'the trusted publisher names this environment');
  // Every job checks out the tag (also when the owner starts it for a tag).
  for (const name of ['check', 'release', 'publish']) assert.match(job(name), /ref: refs\/tags\/\$\{\{ env\.TAG \}\}/, name);
  assert.match(publish, /working-directory: packages\/hoprig-skill/);
  const waiting = job('not-published');
  assert.match(waiting, /if: vars\.NPM_PUBLISH != 'on'/);
  assert.match(waiting, /GITHUB_STEP_SUMMARY/);
  assert.match(waiting, /Use workflow from\\" set to the tag/);
  assert.doesNotMatch(wf, /secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/, 'no stored token');
  for (const m of wf.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${m[1]} is pinned to a commit`);
});

test('RELEASING.md is found from CONTRIBUTING.md and the README, and says what a first-time maintainer meets', () => {
  for (const rel of ['CONTRIBUTING.md', 'README.md']) assert.match(read(rel), /\]\(RELEASING\.md\)/, rel);
  const doc = read('RELEASING.md').replace(/\s+/g, ' ');
  assert.match(doc, /Commit all of it, push main, and wait until the `test` workflow has passed/);
  assert.match(doc, /within 2 days/, 'npm\'s trusted publisher expires unless it publishes within 2 days');
  assert.match(doc, /the same day/);
  assert.match(doc, /Before main gets the `hoprig-skill` package/);
  assert.match(doc, /lower than any release tag/);
  assert.match(doc, /Re-run failed jobs/);
  assert.match(doc, /Run workflow\*\*, with \*\*Use workflow from\*\* set to the tag/);
  assert.match(doc, /environment `npm`/);
});

test('the changelog tells what the skill package, the generated skill and the help fixes bring', () => {
  // They came with 0.3.3, so its block says them (the block after it is 0.3.2).
  const at = changelog.indexOf('\n## 0.3.3 ');
  assert.ok(at >= 0, 'the 0.3.3 block stands');
  const newest = changelog.slice(at, changelog.indexOf('\n## ', at + 1));
  assert.match(newest, /npx hoprig-skill --claude/);
  assert.match(newest, /made from the commands themselves/);
  assert.match(newest, /help word after a command only prints help/);
  assert.match(newest, /A release is a tag/);
});
