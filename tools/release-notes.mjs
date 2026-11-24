#!/usr/bin/env node
// The notes of a release, and the check that a tag may be one (.github/workflows/release.yml runs it first):
//
//   node tools/release-notes.mjs v0.3.2 [--out <file>]
//
// The tag is "v" and the version in package.json, the hoprig-skill package has the same version, and the changelog
// (site/content/changelog.md) has a section "## <version> (<date>)" with something in it, its heading dated (not the
// "(not released yet)" it carries until the release: RELEASING.md step 1). The notes are that section
// without its heading, its site links made full addresses (a GitHub release page is not on the site).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE = 'https://hoprig.com';

/** { notes } for a tag, or throws an Error with the plain reason. Pure: the test gives it every case. */
export function releaseNotes({ tag, version, skillVersion, changelog }) {
  if (!/^v\d+\.\d+\.\d+$/.test(String(tag || ''))) throw new Error(`"${tag}" is not a release tag: a release tag is v<major>.<minor>.<patch>, such as v${version}`);
  if (tag !== `v${version}`) throw new Error(`the tag ${tag} is not the version in package.json (${version}): the tag is v${version}, or the version moves first`);
  if (skillVersion !== version) throw new Error(`packages/hoprig-skill has version ${skillVersion}, Hoprig ${version}: run node tools/build-skill.mjs`);
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (at === -1) throw new Error(`the changelog (site/content/changelog.md) has no section "## ${version} (<date>)"`);
  if (/\(not released yet\)/i.test(lines[at])) throw new Error(`the changelog's heading for ${version} still says "(not released yet)": write the release date in its place (RELEASING.md step 1)`);
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end === -1) end = lines.length;
  const notes = lines.slice(at + 1, end).join('\n').trim()
    .replace(/\]\((\/[^)\s]*)\)/g, (_, href) => `](${SITE}${href})`);
  if (!notes) throw new Error(`the changelog's section for ${version} is empty`);
  return { notes: `${notes}\n` };
}

function main(argv) {
  const tag = argv.find((a) => !a.startsWith('--'));
  const o = argv.indexOf('--out');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const { notes } = releaseNotes({
    tag,
    version: JSON.parse(read('package.json')).version,
    skillVersion: JSON.parse(read('packages/hoprig-skill/package.json')).version,
    changelog: read('site/content/changelog.md'),
  });
  if (o > -1) fs.writeFileSync(argv[o + 1], notes);
  else process.stdout.write(notes);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exitCode = 1;
  }
}
