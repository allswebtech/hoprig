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
const { withPlatform } = await import('./pin-platform.mjs');
// The defaults are those of Linux and macOS; Windows has two more optional kits, and the docs say which.
const WIN_OPTIONAL = ['Python', 'Terminal extras'];
const onLinux = (fn) => withPlatform('linux', fn);

// Only the kits in the kit data: a kit named in README or the changelog before it is there fails here.
const kits = KITS;
const words = (s) => s.split(/, | and /).map((x) => x.trim());

test('README names every kit, the default ones and the optional ones, as the kit data has them', async () => {
  const text = flat(read('README.md'));
  const m = /\*\*Kits\*\*: (.+?) are set up by default; (.+?) are optional, off until you choose them\. On Windows, (.+?) are optional too\./.exec(text);
  assert.ok(m, 'README has the Kits line');
  await onLinux(() => {
    assert.deepEqual(words(m[1]), kits.filter((k) => k.defaultOn).map((k) => k.title));
    assert.deepEqual(words(m[2]), kits.filter((k) => !k.defaultOn).map((k) => k.title));
  });
  await withPlatform('win32', () => {
    assert.deepEqual(words(m[3]), kits.filter((k) => !k.defaultOn && !words(m[2]).includes(k.title)).map((k) => k.title), 'what is optional on Windows besides those');
  });
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

test('the changelog and PC-SETUP.md name the Android kit by its id, its place, the vendor\'s host and what stays yours', async () => {
  const { ANDROID } = await import('../src/pcsetup/kits.mjs');
  const log = flat(read('site/content/changelog.md'));
  const item = log.slice(log.indexOf('- **Android, into the workspace\'s `development/` folder.**'));
  assert.ok(item.length < log.length, 'the item stands');
  assert.ok(kits.some((k) => k.id === 'android' && !k.defaultOn && k.windows === false), 'an optional kit, not on Windows');
  assert.match(item, /`hoprig pc setup --kits android`/);
  assert.match(item, new RegExp(`in \`${DEV_PLACES.androidSdk.rel}\``));
  assert.match(item, new RegExp(`downloaded only from ${ANDROID.host.replace(/\./g, '\\.')} over https`));
  assert.match(item, /the sha1 the list gives \(its only checksum\)/);
  assert.match(item, /Hoprig never accepts the licence for you\. Android Studio is not downloaded/);
  assert.equal(ANDROID.host, 'dl.google.com');
  assert.ok(ANDROID.list.startsWith(`https://${ANDROID.host}/`) && ANDROID.base.startsWith(`https://${ANDROID.host}/`), 'the list and the archives come from one host');
  const doc = flat(read('docs/PC-SETUP.md'));
  const row = read('docs/PC-SETUP.md').split('\n').find((l) => l.startsWith('| **Android** '));
  assert.match(row, new RegExp(`\`${DEV_PLACES.androidSdk.rel}\``));
  assert.match(row, /dl\.google\.com over https/);
  assert.match(doc, /Hoprig never accepts it and never runs `sdkmanager`/);
  assert.match(doc, /cmdline-tools\/latest\/bin\/sdkmanager" --sdk_root="\$HOME\/Workspace\/development\/sdk\/android-sdk" --licenses/);
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

test('docs/PC-SETUP.md has a row in its Kits table for every kit, by the title the Setup page shows', async () => {
  const doc = read('docs/PC-SETUP.md');
  const table = doc.slice(doc.indexOf('| Kit | Items | How |'), doc.indexOf('\n\n', doc.indexOf('| Kit | Items | How |')));
  const rows = [...table.matchAll(/^\| \*\*(.+?)\*\*( \(optional, off by default\))? \|/gm)].map((m) => ({ title: m[1], optional: Boolean(m[2]) }));
  await onLinux(() => assert.deepEqual(rows, kits.map((k) => ({ title: k.title, optional: !k.defaultOn }))));
  await withPlatform('win32', () => {
    for (const k of kits.filter((x) => !x.defaultOn && !rows.find((r) => r.title === x.title).optional)) {
      assert.ok(WIN_OPTIONAL.includes(k.title), k.title);
      assert.match(table.split('\n').find((l) => l.startsWith(`| **${k.title}** `)), /on Windows this kit is optional/, `${k.title}: the row says it is optional on Windows`);
    }
  });
  const flutter = table.split('\n').find((l) => l.startsWith('| **Flutter** '));
  assert.match(flutter, new RegExp(`\`${DEV_PLACES.flutter.rel}\``), 'the Flutter row names its place');
  assert.match(flutter, new RegExp(FLUTTER.host.replace(/\./g, '\\.')), 'the Flutter row names the host');
});
