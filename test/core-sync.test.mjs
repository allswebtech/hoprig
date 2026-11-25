// tools/core-sync.mjs takes the public skills of an export of the shared core into skills/, by the version named in
// core.json. Every test works on a temporary copy of the tree it needs (--root) and a stand-in export, "example-core":
// never on this tree's own skills/, never on a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealed } from './seal.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const TOOL = path.join(REPO, 'tools/core-sync.mjs');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let tmp;
let root;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-sync-')));
  root = path.join(tmp, 'tree');
  // The part of the tree the tool reads and writes: core.json as it is in the repository, and a skills/ folder with
  // one skill of Hoprig's own.
  fs.mkdirSync(path.join(root, 'skills', 'plan-work'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'core.json'), path.join(root, 'core.json'));
  fs.writeFileSync(path.join(root, 'skills', 'plan-work', 'SKILL.md'), skill('plan-work', 'Hoprig\'s own way to plan.'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function skill(name, body, tools = 'get_computer_status') {
  return `---\nname: ${name}\ndescription: "${name} for a test."\nallowed-tools: ${tools}\n---\n\n${body}\n`;
}

/** A stand-in export of the shared core: { 'pack/skill/file': text }, and packs [{ name, public }]. */
function exportOf(version, packs, files, dir = path.join(tmp, `export-${version}`)) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'core-export.json'), JSON.stringify({ name: 'example-core', version, packs }));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, 'skills', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return dir;
}

const PACKS = [{ name: 'core', public: true }, { name: 'vertical', public: false }];
const V1 = {
  'core/talk-plainly/SKILL.md': skill('talk-plainly', 'Say it in plain words.\nOne idea per sentence.'),
  'core/talk-plainly/references/examples.md': '# Examples\n\nShort ones.\n',
  'core/confirm-first/SKILL.md': skill('confirm-first', 'Ask before anything hard to undo.'),
  'vertical/shop-orders/SKILL.md': skill('shop-orders', 'A private skill of the core.'),
};
const v1 = () => exportOf('0.1.0', PACKS, V1);

function run(...args) {
  const r = spawnSync(process.execPath, [TOOL, '--root', root, ...args], { env: sealed({ PATH: process.env.PATH, HOME: tmp }), cwd: tmp, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

/** Every path below `dir` with its kind and content hash (links by their target): a whole-folder snapshot. */
function snapshot(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    out[rel] = st.isSymbolicLink() ? `link ${fs.readlinkSync(p)}` : st.isDirectory() ? 'dir' : sha(fs.readFileSync(p));
  }
  return out;
}

const pin = () => JSON.parse(fs.readFileSync(path.join(root, 'core.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('a dry run shows what it would take and writes nothing', () => {
  const from = v1();
  const before = snapshot(tmp);
  const r = run('--from', from);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^ {2}new +skills\/talk-plainly\/SKILL\.md$/m);
  assert.match(r.out, /^ {2}new +skills\/talk-plainly\/references\/examples\.md$/m);
  assert.match(r.out, /^ {2}new +skills\/confirm-first\/SKILL\.md$/m);
  assert.match(r.out, /not public, left out: vertical/);
  assert.doesNotMatch(r.out, /shop-orders/);
  assert.match(r.out, /Dry run: nothing was written/);
  assert.deepEqual(snapshot(tmp), before);
});

test('--write takes only the public pack, marks each text as the core\'s and records every file\'s hash', async () => {
  const r = run('--from', v1(), '--write');
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(fs.readdirSync(path.join(root, 'skills')).sort(), ['confirm-first', 'plan-work', 'talk-plainly']);
  const text = read('skills/talk-plainly/SKILL.md');
  // The line comes after the front matter, so the skill still starts with it.
  assert.match(text, /^---\nname: talk-plainly\n[\s\S]*?\n---\n<!-- Generated from the shared core 0\.1\.0: change it there\. -->\n\nSay it in plain words\./);
  assert.match(read('skills/talk-plainly/references/examples.md'), /^<!-- Generated from the shared core 0\.1\.0: change it there\. -->\n# Examples/);
  const p = pin();
  assert.equal(p.version, 1);
  assert.equal(p.core, 'example-core');
  assert.equal(p.pinned, '0.1.0');
  assert.equal(p.about, JSON.parse(fs.readFileSync(path.join(REPO, 'core.json'), 'utf8')).about);
  assert.deepEqual(Object.keys(p.files).sort(), ['skills/confirm-first/SKILL.md', 'skills/talk-plainly/SKILL.md', 'skills/talk-plainly/references/examples.md']);
  for (const [rel, h] of Object.entries(p.files)) assert.equal(h, sha(fs.readFileSync(path.join(root, rel))), rel);
  assert.equal(read('skills/plan-work/SKILL.md'), skill('plan-work', 'Hoprig\'s own way to plan.'), 'Hoprig\'s own skill is left as it was');
  // The taken skills are plain skills: Tia's loader reads them as it reads every skill in skills/.
  const { Skills } = await import('../src/assistant/skills.mjs');
  const loaded = new Skills({ dirs: [{ dir: path.join(root, 'skills'), source: 'built-in' }] });
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.all.map((s) => s.name).sort(), ['confirm-first', 'plan-work', 'talk-plainly']);
  assert.match(loaded.get('talk-plainly').body, /Say it in plain words/);
  // The same export again changes nothing.
  const before = snapshot(root);
  const again = run('--from', v1(), '--write');
  assert.equal(again.code, 0, again.all);
  assert.match(again.out, /^ {2}unchanged +skills\/talk-plainly\/SKILL\.md$/m);
  assert.deepEqual(snapshot(root), before);
});

test('a newer version of the core shows a plain diff: new, changed, unchanged and removed files', () => {
  assert.equal(run('--from', v1(), '--write').code, 0);
  const v2 = exportOf('0.2.0', PACKS, {
    'core/talk-plainly/SKILL.md': skill('talk-plainly', 'Say it in plain words.\nOne idea in each sentence.'),
    'core/talk-plainly/references/examples.md': '# Examples\n\nShort ones.\n',
    'core/report-numbers/SKILL.md': skill('report-numbers', 'Name the number.'),
    'vertical/shop-orders/SKILL.md': skill('shop-orders', 'Still private.'),
  });
  const before = snapshot(tmp);
  const r = run('--from', v2);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /The shared core example-core 0\.2\.0 \(pinned now: example-core 0\.1\.0\)/);
  assert.match(r.out, /^ {2}changed +skills\/talk-plainly\/SKILL\.md$/m);
  assert.match(r.out, /^ +- One idea per sentence\.$/m);
  assert.match(r.out, /^ +\+ One idea in each sentence\.$/m);
  assert.doesNotMatch(r.out, /Generated from the shared core/, 'the marking line is not a change');
  assert.match(r.out, /^ {2}unchanged +skills\/talk-plainly\/references\/examples\.md$/m);
  assert.match(r.out, /^ {2}new +skills\/report-numbers\/SKILL\.md$/m);
  assert.match(r.out, /^ {2}removed +skills\/confirm-first\/SKILL\.md$/m);
  assert.deepEqual(snapshot(tmp), before, 'a dry run writes nothing');
  const w = run('--from', v2, '--write');
  assert.equal(w.code, 0, w.all);
  assert.equal(pin().pinned, '0.2.0');
  assert.ok(!fs.existsSync(path.join(root, 'skills/confirm-first')), 'a skill the core no longer has goes, with its folder');
  assert.match(read('skills/talk-plainly/SKILL.md'), /shared core 0\.2\.0[\s\S]*One idea in each sentence/);
  assert.deepEqual(Object.keys(pin().files).sort(), ['skills/report-numbers/SKILL.md', 'skills/talk-plainly/SKILL.md', 'skills/talk-plainly/references/examples.md']);
});

test('a file changed here is never overwritten: it is listed, the tool exits 1 and writes nothing', () => {
  assert.equal(run('--from', v1(), '--write').code, 0);
  fs.appendFileSync(path.join(root, 'skills/talk-plainly/SKILL.md'), 'A line of this computer\'s own.\n');
  const v2 = exportOf('0.2.0', PACKS, { ...V1, 'core/talk-plainly/SKILL.md': skill('talk-plainly', 'A newer text.') });
  const before = snapshot(tmp);
  const r = run('--from', v2, '--write');
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /^ {2}changed locally +skills\/talk-plainly\/SKILL\.md \(differs from what was taken: kept\)$/m);
  assert.match(r.out, /never overwritten: skills\/talk-plainly\/SKILL\.md\..*Nothing was written/);
  assert.deepEqual(snapshot(tmp), before);
  // A skill of Hoprig's own of the same name as one of the core's is not taken over either.
  fs.rmSync(path.join(root, 'skills/talk-plainly/SKILL.md'));
  fs.copyFileSync(path.join(REPO, 'core.json'), path.join(root, 'core.json'));
  const own = exportOf('0.1.0', PACKS, { ...V1, 'core/plan-work/SKILL.md': skill('plan-work', 'The core\'s plan.') }, path.join(tmp, 'export-own'));
  const before2 = snapshot(tmp);
  const r2 = run('--from', own, '--write');
  assert.equal(r2.code, 1, r2.all);
  assert.match(r2.out, /skills\/plan-work\/SKILL\.md \(here already, not taken from the core: kept\)/);
  assert.deepEqual(snapshot(tmp), before2);
});

test('an export with a path that leaves its place, or with a link, is refused whole and nothing is written', () => {
  const cases = {
    'a pack named with ..': () => exportOf('0.1.0', [{ name: '../skills', public: true }], V1, path.join(tmp, 'x-dots')),
    'an absolute pack': () => exportOf('0.1.0', [{ name: path.join(tmp, 'elsewhere'), public: true }], V1, path.join(tmp, 'x-abs')),
    'a file that is a link': () => {
      const d = exportOf('0.1.0', PACKS, V1, path.join(tmp, 'x-link'));
      fs.writeFileSync(path.join(tmp, 'secret.txt'), 'not the core\'s');
      fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(d, 'skills/core/talk-plainly/notes.md'));
      return d;
    },
    'a skill folder that is a link': () => {
      const d = exportOf('0.1.0', PACKS, V1, path.join(tmp, 'x-dirlink'));
      fs.symlinkSync(path.join(root, 'skills/plan-work'), path.join(d, 'skills/core/plan-work'), 'dir');
      return d;
    },
    'a pack that is a link': () => {
      const d = exportOf('0.1.0', [{ name: 'core', public: true }], {}, path.join(tmp, 'x-packlink'));
      fs.rmSync(path.join(d, 'skills'), { recursive: true, force: true });
      fs.mkdirSync(path.join(d, 'skills'));
      fs.symlinkSync(path.join(tmp, 'export-0.1.0', 'skills', 'core'), path.join(d, 'skills/core'), 'dir');
      return d;
    },
  };
  v1();
  for (const [what, make] of Object.entries(cases)) {
    const from = make();
    const before = snapshot(tmp);
    const r = run('--from', from, '--write');
    assert.equal(r.code, 1, `${what}: ${r.all}`);
    assert.match(r.err, /^Refused: .*Nothing was written\.$/m, what);
    assert.deepEqual(snapshot(tmp), before, what);
  }
  // A skills/ folder here that leads elsewhere through a link is not followed either.
  fs.renameSync(path.join(root, 'skills'), path.join(tmp, 'other-skills'));
  fs.symlinkSync(path.join(tmp, 'other-skills'), path.join(root, 'skills'), 'dir');
  const before = snapshot(tmp);
  const r = run('--from', path.join(tmp, 'export-0.1.0'), '--write');
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /skills is a link here: it is not followed/);
  assert.deepEqual(snapshot(tmp), before);
});

test('--check passes while every taken file has its hash, and names each one that changed or went', () => {
  const none = run('--check');
  assert.equal(none.code, 0, none.all);
  assert.match(none.out, /No shared core is pinned: Hoprig's own copy in skills\/ is used\./);
  assert.equal(run('--from', v1(), '--write').code, 0);
  const ok = run('--check');
  assert.equal(ok.code, 0, ok.all);
  assert.match(ok.out, /example-core 0\.1\.0 is as it was taken \(3 files\)/);
  fs.appendFileSync(path.join(root, 'skills/confirm-first/SKILL.md'), 'edited\n');
  fs.rmSync(path.join(root, 'skills/talk-plainly/references/examples.md'));
  const before = snapshot(tmp);
  const bad = run('--check');
  assert.equal(bad.code, 1, bad.all);
  assert.match(bad.out, /skills\/confirm-first\/SKILL\.md \(changed here\)/);
  assert.match(bad.out, /skills\/talk-plainly\/references\/examples\.md \(missing\)/);
  assert.doesNotMatch(bad.out, /talk-plainly\/SKILL\.md/);
  assert.deepEqual(snapshot(tmp), before, '--check writes nothing');
});

test('the repository\'s own pin names no core yet, and its check passes', () => {
  const p = JSON.parse(fs.readFileSync(path.join(REPO, 'core.json'), 'utf8'));
  assert.deepEqual({ version: p.version, core: p.core, pinned: p.pinned }, { version: 1, core: null, pinned: null });
  assert.equal(p.about.split(/(?<=\.)\s+/).length, 2, 'two plain sentences');
  const r = spawnSync(process.execPath, [TOOL, '--check'], { env: sealed({ PATH: process.env.PATH, HOME: tmp }), cwd: tmp, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the guide and the changelog say what the tool does, and the pin file stays out of the package', () => {
  const flat = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\s+/g, ' ');
  const doc = flat('docs/SKILLS.md');
  const at = doc.indexOf('## Skills from the shared core');
  assert.ok(at > 0 && at < doc.indexOf('## For the guided first run'), 'its own section, before the guided first run');
  for (const words of [
    'Hoprig never needs that repository to run',
    '`node tools/core-sync.mjs --from <export folder>` shows what a version of the core would change',
    'and writes nothing',
    '"Generated from the shared core <version>: change it there."',
    'is never overwritten: it is listed, and nothing is written',
    '`--check` exits 1 and names every taken file that changed or went',
    '`core-export.json` (`name`, `version`, `packs`: each `{ name, public }`)',
    'One that holds a link, an absolute path or `..` is refused whole',
  ]) assert.ok(doc.includes(words), words);
  // The line the guide quotes is the one the tool writes.
  assert.match(fs.readFileSync(TOOL, 'utf8'), /`<!-- Generated from the shared core \$\{version\}: change it there\. -->\\n`/);
  const log = fs.readFileSync(path.join(REPO, 'site/content/changelog.md'), 'utf8').replace(/\r\n?/g, '\n');
  const from = log.indexOf('\n## 0.3.4 ');
  const block = log.slice(from, log.indexOf('\n## ', from + 1)).replace(/\s+/g, ' ');
  assert.ok(block.includes('**Built-in skills can be taken from a shared core, by version.**'), 'a line in the unreleased block');
  assert.ok(block.includes('A skill changed here is never overwritten'));
  // Hoprig does not read core.json when it runs, so the package does not carry it.
  const files = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).files;
  assert.ok(!files.includes('core.json') && !files.includes('tools'), files.join(', '));
  for (const dir of ['src', 'bin', 'web']) {
    for (const f of fs.readdirSync(path.join(REPO, dir), { recursive: true }).filter((f) => /\.m?js$/.test(f))) {
      assert.doesNotMatch(fs.readFileSync(path.join(REPO, dir, f), 'utf8'), /core\.json|core-sync/, `${dir}/${f} reads the pin`);
    }
  }
});

test('wrong arguments print the usage and do nothing', () => {
  const before = snapshot(tmp);
  for (const bad of [[], ['--write'], ['--check', '--write'], ['--from'], ['--from', tmp, '--check'], ['--nope']]) {
    const r = run(...bad);
    assert.equal(r.code, 2, bad.join(' '));
    assert.match(r.err, /usage: node tools\/core-sync\.mjs/);
  }
  assert.deepEqual(snapshot(tmp), before);
});
