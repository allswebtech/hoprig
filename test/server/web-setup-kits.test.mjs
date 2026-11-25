// "Set up this computer" on the Setup part (web/pcsetup.js) and the job card (web/setupjob.js): a toolchain kit (Flutter,
// Android) says in its row, before the one yes, what was found and is used where it is, what it downloads and from which
// host, about how big, what it changes and what stays the owner's own step; the job shows a download's progress and,
// when a check fails, a plain sentence with what to do. Written from the fields of /api/pcsetup/kits and /api/pcsetup/job
// (src/pcsetup/kitinfo.mjs, src/pcsetup/feature.mjs), so a kit with the same fields shows the same way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.location ??= { hostname: '127.0.0.1', pathname: '/', hash: '', origin: 'http://127.0.0.1' };
globalThis.fetch = () => new Promise(() => {});

const setup = await import('../../web/pcsetup.js');
const job = await import('../../web/setupjob.js');
const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

const WS = '/home/alex/Workspace';
const PATH_LINE = `case ":$PATH:" in *":$HOME/Workspace/development/flutter/flutter/bin:"*) ;; *) PATH="$HOME/Workspace/development/flutter/flutter/bin:$PATH"; export PATH ;; esac  # flutter`;
const HOME_LINE = 'export ANDROID_HOME="$HOME/Workspace/development/sdk/android-sdk"  # android-home';

test('a toolchain kit row says what it downloads, from which host, about how big, what it changes and what stays yours', () => {
  const facts = setup.kitFacts({
    id: 'flutter', title: 'Flutter',
    downloads: [{ what: "Flutter's current stable release", host: 'storage.googleapis.com', checksum: 'sha256', text: "Flutter's current stable release, from storage.googleapis.com over https (checked against its sha256)" }],
    size: { download: 1.6e9, disk: 3e9, text: 'about 1.6 GB to download, about 3 GB on disk' },
    changes: [`a new folder ${WS}/development/flutter/flutter`, `these lines in the hoprig kits block of your shell start files: ${PATH_LINE}; ${HOME_LINE}`],
    found: [],
    yours: [{ kit: 'Flutter', text: "Flutter needs xz-utils, libglu1-mesa (Flutter's own list for Linux): install them yourself; this asks before it changes anything", command: 'sudo apt-get install -y xz-utils libglu1-mesa' }],
  });
  assert.deepEqual(facts.map((f) => f.kind), ['downloads', 'size', 'changes', 'changes', 'yours']);
  assert.equal(facts[0].text, "Downloads Flutter's current stable release, from storage.googleapis.com over https (checked against its sha256)");
  assert.equal(facts[1].text, 'About 1.6 GB to download, about 3 GB on disk');
  assert.equal(facts[2].text, `Changes: a new folder ${WS}/development/flutter/flutter`);
  // The shell lines as they will stand in the start files, one per line: never cut inside a line's own "; ".
  assert.equal(facts[3].text, 'Changes: these lines in the hoprig kits block of your shell start files:');
  assert.equal(facts[3].code, `${PATH_LINE}\n${HOME_LINE}`);
  assert.match(facts[4].text, /^Yours to do, Hoprig does not run it: Flutter needs xz-utils/);
  assert.equal(facts[4].code, 'sudo apt-get install -y xz-utils libglu1-mesa', 'the command to type, shown');
});

test('a tool found on the computer reads as found and used where it is; nothing is said to be downloaded', () => {
  const facts = setup.kitFacts({
    id: 'flutter', downloads: [], size: null, yours: [],
    changes: [`${WS}/development/flutter/flutter becomes a link to ~/flutter (nothing of it is moved, copied or changed)`],
    found: [{ name: 'Flutter', where: '~/flutter', version: '3.41.2', text: 'found at ~/flutter: used where it is' }],
  });
  assert.deepEqual(facts.map((f) => [f.kind, f.text]), [
    ['found', 'Flutter 3.41.2 found at ~/flutter: used where it is'],
    ['changes', `Changes: ${WS}/development/flutter/flutter becomes a link to ~/flutter (nothing of it is moved, copied or changed)`],
  ]);
  // A kit without these fields (Basics, PHP) has no such lines.
  assert.deepEqual(setup.kitFacts({ id: 'basics', items: [] }), []);
  assert.deepEqual(setup.kitFacts({ id: 'php', downloads: [], size: null, changes: [], found: [], yours: [] }), []);
});

test('the job shows a running download\'s progress on its step, from the newest line pc setup wrote', () => {
  const label = 'Flutter, the stable release';
  const lines = ['  → Flutter, the stable release: (Hoprig) download …', `    ${label}: 0 bytes of about 1.5 GB`, `    ${label}: 152 MB of about 1.5 GB`, 'some other line: 3 MB', `    ${label}: 304 MB of about 1.5 GB`];
  assert.equal(job.progressOf(lines, label), '304 MB of about 1.5 GB');
  assert.equal(job.progressOf([`    ${label}: 1.2 GB`], label), '1.2 GB', 'a server that gave no size: only what arrived');
  assert.equal(job.progressOf(['    Other step: 5 MB of about 9 MB'], label), null, 'another step\'s line is not this one\'s');
  assert.equal(job.progressOf([`    ${label}: the list was read`], label), null, 'only a size line');
  assert.match(read('web/setupjob.js'), /stepRow\(s, s\.inside && s\.state === 'running' \? progress\.get\(s\.label\) \|\| null : null\)/, 'the card passes it to the running step');
});

test('a failed check says in one plain sentence what went wrong and what to do', () => {
  const s = { label: 'Flutter, the stable release', state: 'fail', inside: true, why: 'its sha256 is not the one the vendor publishes: the download was thrown away', todo: 'Run it again. If it fails the same way, do not install it by hand from that place: tell the Hoprig project.' };
  assert.equal(job.stepFailWords(s), 'Flutter, the stable release did not work: its sha256 is not the one the vendor publishes: the download was thrown away. Run it again. If it fails the same way, do not install it by hand from that place: tell the Hoprig project.');
  assert.equal(job.stepFailWords({ ...s, todo: null }), 'Flutter, the stable release did not work: its sha256 is not the one the vendor publishes: the download was thrown away. Nothing was put in its place; run it again later.');
  assert.equal(job.stepFailWords({ ...s, state: 'ok' }), null);
  assert.equal(job.stepFailWords({ label: 'install git', state: 'fail', command: 'sudo apt-get install -y git' }), null, 'a command step: its output says why');
});

test('on Windows the sheet names the kits it does not offer as one list that reads well with four titles', () => {
  assert.equal(setup.notCoveredWords(['PHP + database', 'Flutter versions (fvm)', 'Flutter', 'Android']), 'PHP + database, Flutter versions (fvm), Flutter and Android: not covered on Windows, so they are not offered here.');
  assert.equal(setup.notCoveredWords(['PHP + database']), 'PHP + database: not covered on Windows, so it is not offered here.');
  assert.match(read('web/pcsetup.js'), /h\('p\.hint', notCoveredWords\(d\.notCovered\)\)/);
});

test('the sheet draws these lines in each kit row, before the commands and the one Install', () => {
  const src = read('web/pcsetup.js');
  const row = src.indexOf('...kitFacts(k).map(');
  assert.ok(row > 0, 'the kit row draws kitFacts');
  assert.ok(row > src.indexOf("openSheet({ title: 'Set up this computer'") && row < src.indexOf("}, 'Install')),"), 'inside the sheet, above the Install button');
});

test('Setup names each kit\'s rows by the kit\'s title, and the Flutter kit\'s row is an optional extra with its Install…', async () => {
  const { KITS } = await import('../../src/pcsetup/kits.mjs');
  const { GROUPS, kitChecks } = await import('../../src/pcsetup/status.mjs');
  // Every group pc status gives a row (each kit, and the others) has the same title on the page.
  for (const [g, title] of Object.entries(GROUPS)) assert.equal(setup.GROUP_TITLES[g], title, g);
  // The page names no kit that is not in the kit data (a title ahead of its kit would promise it).
  assert.deepEqual(Object.keys(setup.GROUP_TITLES).filter((g) => g.startsWith('kit:')), KITS.map((k) => `kit:${k.id}`));
  const sys = { platform: 'linux', pm: 'apt', root: false, arch: 'x64', home: '/home/alex', ws: WS, env: { SHELL: '/bin/bash' }, has: () => true, blockHas: () => false };
  const rows = kitChecks({ flutter: [{ id: 'flutter', name: 'Flutter', state: 'missing', version: null, detail: '', shellLine: true }] }, sys);
  assert.deepEqual(rows.map((c) => [c.group, c.id, c.label, c.status, c.setupKit, c.fix]), [['kit:flutter', 'flutter.flutter', 'Flutter', 'info', 'flutter', 'hoprig pc setup --kits flutter']]);
  const s = setup.setupSummary(rows);
  assert.deepEqual([s.fix.length, s.optional.length, s.offers.length], [0, 1, 1], 'under Optional, counted, never "to fix"');
});

test('the sheet\'s command and shell lines wrap at a space first, never inside a word such as "android-tools"', () => {
  const src = read('web/pcsetup.js');
  const sheet = src.slice(src.indexOf('async function setupSheet('), src.indexOf("}, 'Install')),"));
  assert.ok(!/wordBreak: 'break-all'/.test(sheet.slice(0, sheet.indexOf('d.java ?'))), 'no break-all in the kit rows and Will run');
  assert.match(sheet, /const pre = \(lines\) => h\('pre', \{ style: \{[^}]*overflowWrap: 'anywhere'/);
  assert.match(sheet, /f\.code \? h\('code\.mono', \{ style: \{[^}]*overflowWrap: 'anywhere'/);
});
