// An extra folder on Windows (src/workspace/needswalk.mjs ruleForm, needs.mjs extraFolder and extraSettings), with
// Windows' answers given as arguments (platform 'win32', made-up C:\ paths): there is no Windows computer in this test.
// Claude Code reads a path in a rule in POSIX form on Windows ("C:\Users\alice becomes /c/Users/alice", its
// permissions page), so a folder is named that way before RULE_SAFE is asked and in every rule written for it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { needsWorld } from './needsfix.mjs';

const N = await import('../../src/workspace/needs.mjs');
const W = await import('../../src/workspace/needswalk.mjs');

const PARTS = 'C:\\Users\\alex\\example\\projects\\kits\\parts';
const BLOG_IGNORE = 'C:\\Users\\alex\\example\\projects\\blog\\ignore';

test('Windows: a folder on a drive is named in the POSIX form the coding tool reads, and may be opened', () => {
  assert.equal(W.ruleForm(PARTS, 'win32'), '/c/Users/alex/example/projects/kits/parts');
  assert.equal(W.ruleForm('D:/work/shop', 'win32'), '/d/work/shop', 'a forward slash after the drive too');
  assert.equal(W.ruleForm('C:\\', 'win32'), '/c', 'the drive itself');
  assert.equal(W.nameable(PARTS, 'win32'), true, 'the folder is opened');
  assert.equal(W.RULE_SAFE.test(PARTS), false, 'RULE_SAFE itself stays as strict for the form it checks');
  // Elsewhere nothing changes: the path is its own form.
  assert.equal(W.ruleForm('/home/alex/ws/parts', 'linux'), '/home/alex/ws/parts');
  assert.equal(W.ruleForm('/Users/alex/ws/parts', 'darwin'), '/Users/alex/ws/parts');
});

test('Windows: a share, a path with no drive and an odd character are still refused', () => {
  for (const p of ['\\\\server\\share\\parts', '//server/share/parts', '\\\\?\\C:\\Users\\alex\\parts', '\\Users\\alex\\parts', 'C:parts']) {
    assert.equal(W.ruleForm(p, 'win32'), null, p);
    assert.equal(W.nameable(p, 'win32'), false, p);
  }
  for (const p of ['C:\\Users\\alex\\a(b)\\parts', 'C:\\Users\\alex\\[x]\\parts', 'C:\\Users\\alex\\a*b', 'C:\\Users\\alex\\a{b}']) assert.equal(W.nameable(p, 'win32'), false, p);
});

test('Windows: every rule written for an extra folder names it as //c/...', async () => {
  const walked = { [PARTS]: { credLinks: ['keys'], privLinks: [{ link: 'theirs', to: BLOG_IGNORE }] } };
  const s = await N.extraSettings([PARTS], { dir: '/nonexistent-example-ws', projects: '/nonexistent-example-ws/projects', walked, platform: 'win32' });
  const rd = '/c/Users/alex/example/projects/kits/parts';
  assert.deepEqual(s.additionalDirectories, [PARTS], 'the folder is given as it is on the disk');
  for (const r of [`Edit(/${rd}/**)`, `Write(/${rd}/**)`, `NotebookEdit(/${rd}/**)`, `Read(/${rd}/no-ai)`, `Read(/${rd}/**/ignore/**)`, `Read(/${rd}/keys)`, `Read(/${rd}/keys/**)`, `Read(/${rd}/theirs/**)`, 'Read(//c/Users/alex/example/projects/blog/ignore)', 'Read(//c/Users/alex/example/projects/blog/ignore/**)']) {
    assert.ok(s.deny.includes(r), r);
  }
  assert.ok(s.deny.every((r) => /^(Edit|Write|NotebookEdit|Read)\(\/\/c\//.test(r)), 'every rule names it by its absolute path in POSIX form');
  assert.ok(!s.deny.some((r) => r.includes('\\') || r.includes(':')), 'no backslash, no drive colon');
  assert.equal(N.rebase('Read(secret.txt)', W.ruleForm(PARTS, 'win32'))[1], `Read(/${rd}/**/secret.txt)`);
  // A folder with a share's path cannot be named: it gets no rules and is not given.
  assert.equal(await N.extraSettings(['\\\\server\\share\\parts'], { dir: '/nonexistent-example-ws', walked: { '\\\\server\\share\\parts': { credLinks: [], privLinks: [] } }, platform: 'win32' }), null);
  // A private link that leads to a share: the whole folder is closed to Read.
  const far = await N.extraSettings([PARTS], { dir: '/nonexistent-example-ws', walked: { [PARTS]: { credLinks: [], privLinks: [{ link: 'theirs', to: '\\\\server\\share\\ignore' }] } }, platform: 'win32' });
  assert.ok(far.deny.includes(`Read(/${rd}/**)`));
});

// On a Windows computer the fixture's folders lie on a drive, so there the answer is the folder opened.
const ON_WIN = process.platform === 'win32';

test('Windows: the decision asks the form a rule names, so a folder with no drive letter is refused with the same words', async () => {
  // Off Windows this computer's folders have no drive letter: on win32 they are what a share is, a path a rule cannot name.
  const w = needsWorld('needs-win-share');
  try {
    const self = fs.realpathSync(w.shop);
    const r = await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self, platform: 'win32' });
    if (ON_WIN) assert.equal(r.ok, true, r.why);
    else {
      assert.equal(r.ok, false);
      assert.equal(r.why, "kits/parts: its folder's path has a character the coding tool's rules cannot name, so it is not opened");
    }
    const ok = await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self });
    assert.equal(ok.ok, true, `here it is opened as before: ${ok.why}`);
  } finally {
    w.cleanup();
  }
});

test('Windows: a link into a private folder whose place cannot be named keeps the folder closed', async () => {
  const w = needsWorld('needs-win-privlink');
  try {
    const d = fs.realpathSync(w.parts);
    fs.mkdirSync(`${w.projects}/blog/ignore`, { recursive: true });
    fs.symlinkSync(`${w.projects}/blog/ignore`, `${d}/theirs`);
    const fence = { creds: fs.realpathSync(`${w.ws}/credentials`), brain: fs.realpathSync(`${w.ws}/ai_brain`), bounds: [fs.realpathSync(w.ws), fs.realpathSync(w.projects)] };
    const here = await W.linkWalk(d, fence);
    assert.equal(here.why, undefined, 'here it is walked as before');
    assert.equal(here.privLinks.length, 1);
    const win = await W.linkWalk(d, { ...fence, platform: 'win32' });
    if (ON_WIN) assert.equal(win.privLinks.length, 1, win.why);
    else assert.match(win.why, /its link theirs leads into a private folder and has a character the coding tool's rules cannot name/);
  } finally {
    w.cleanup();
  }
});
