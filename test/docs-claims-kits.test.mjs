// What README.md and the changelog say about the kits of `pc setup`, held to the kit data (src/pcsetup/kits.mjs) and
// the places of development/ (src/workspace/layout.mjs): a kit added, made optional or moved without its sentence fails
// here, and so does a sentence changed alone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const { KITS, FLUTTER } = await import('../src/pcsetup/kits.mjs');
const { DEV_PLACES } = await import('../src/workspace/layout.mjs');

// Only the kits in the kit data: a kit named in README or the changelog before it is there fails here.
const kits = KITS;
const words = (s) => s.split(/, | and /).map((x) => x.trim());

test('README names every kit, the default ones and the optional ones, as the kit data has them', () => {
  const m = /\*\*Kits\*\*: (.+?) are set up by default; (.+?) are optional, off until you choose them\./.exec(flat(read('README.md')));
  assert.ok(m, 'README has the Kits line');
  assert.deepEqual(words(m[1]), kits.filter((k) => k.defaultOn).map((k) => k.title));
  assert.deepEqual(words(m[2]), kits.filter((k) => !k.defaultOn).map((k) => k.title));
});

test('the changelog names the Flutter kit by its id, its place and the vendor\'s host, and no kit that is not there', () => {
  const log = flat(read('site/content/changelog.md'));
  const item = log.slice(log.indexOf('- **Flutter, into the workspace\'s `development/` folder.**'));
  assert.ok(item.length < log.length, 'the item stands');
  const ids = /`hoprig pc setup --kits ([a-z,]+)`/.exec(item)[1].split(',');
  for (const id of ids) assert.ok(kits.some((k) => k.id === id && !k.defaultOn), `${id} is an optional kit`);
  assert.match(item, new RegExp(`Flutter is its current stable release, in \`${DEV_PLACES.flutter.rel}\``));
  if (!KITS.some((k) => k.id === 'android')) assert.doesNotMatch(log.slice(log.indexOf('### Setting up a computer: optional kits'), log.indexOf('### Setting up a server')), /\bAndroid kit|--kits [a-z,]*android|ANDROID_HOME|android-sdk/, 'no Android kit is promised');
  assert.match(log, new RegExp(`A new nvm goes into \`${DEV_PLACES.nvm.rel}\``));
  assert.equal(FLUTTER.host, 'storage.googleapis.com');
  assert.match(FLUTTER.list, /^https:\/\/storage\.googleapis\.com\//, 'the list is read from the host the archive comes from');
  for (const lead of ['A toolchain you already have is used where it is.', 'The shell lines are one block.', 'The Setup sheet says it before the one yes.']) {
    assert.ok(log.includes(`- **${lead}**`), lead);
  }
});

test('the sheet\'s promise in the changelog is what the page draws', () => {
  const page = read('web/pcsetup.js');
  const job = read('web/setupjob.js');
  const log = flat(read('site/content/changelog.md'));
  assert.match(log, /The Flutter kit's row says what it downloads and from which host, about how big it is \(to download and on disk\), what it changes \(the folder, a link, the shell lines\), what was found and is used where it is, and what stays yours to do\. While it runs, the job shows how far the download is; when a check fails, it says in one sentence what went wrong and what to do\./);
  for (const kind of ['found', 'downloads', 'size', 'changes', 'yours']) assert.match(page, new RegExp(`kind: '${kind}'`), `the kit row has its ${kind} line`);
  assert.match(job, /`Downloaded \$\{progress\}`/, 'the job shows how far the download is');
  assert.match(job, /did not work: \$\{why\}\./, 'a failed check says what went wrong');
});

test('docs/PC-SETUP.md has a row in its Kits table for every kit, by the title the Setup page shows', () => {
  const doc = read('docs/PC-SETUP.md');
  const table = doc.slice(doc.indexOf('| Kit | Items | How |'), doc.indexOf('\n\n', doc.indexOf('| Kit | Items | How |')));
  const rows = [...table.matchAll(/^\| \*\*(.+?)\*\*( \(optional, off by default\))? \|/gm)].map((m) => ({ title: m[1], optional: Boolean(m[2]) }));
  assert.deepEqual(rows, kits.map((k) => ({ title: k.title, optional: !k.defaultOn })));
  const flutter = table.split('\n').find((l) => l.startsWith('| **Flutter** '));
  assert.match(flutter, new RegExp(`\`${DEV_PLACES.flutter.rel}\``), 'the Flutter row names its place');
  assert.match(flutter, new RegExp(FLUTTER.host.replace(/\./g, '\\.')), 'the Flutter row names the host');
});
