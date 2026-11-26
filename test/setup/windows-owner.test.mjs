// Windows: a set-up run as administrator leaves its folders to the Administrators group. Set-up says so at its start
// and gives the line that hands them back at its end; doctor names the workspace and Claude Code's folder when they
// belong to that group. Hoprig changes no owner itself: every program asked is recorded, and icacls is never one.
// Made-up answers of whoami and PowerShell: nothing real runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeFetch, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
globalThis.fetch = fakeFetch({});

const W = await import('../../src/setup/winowner.mjs');
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const WHOAMI_USER = `"pc-example\\alex","${ME}"\r\n`;
const groups = (elevated) => [
  '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
  '"VORDEFINIERT\\Administratoren","Alias","S-1-5-32-544","Mandatory group, Enabled by default, Enabled group, Group owner"',
  elevated ? '"Verbindliche Beschriftung\\Hohe Verbindlichkeitsstufe","Label","S-1-16-12288",""' : '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
].join('\r\n') + '\r\n';

/** A stand-in for Windows: answers whoami and PowerShell's owner question, records every argv. */
function windows({ elevated = false, owners = {} } = {}) {
  const calls = [];
  const run = async (given) => {
    // Windows' own whoami comes by its full path there (winowner.mjs whoamiBin): recorded by its name.
    const argv = /[\\/]whoami\.exe$/i.test(given[0]) ? ['whoami', ...given.slice(1)] : given;
    calls.push(argv);
    if (argv[0] === 'whoami' && argv[1] === '/groups') return { ok: true, stdout: groups(elevated), stderr: '' };
    if (argv[0] === 'whoami' && argv[1] === '/user') return { ok: true, stdout: WHOAMI_USER, stderr: '' };
    if (argv[0] === 'powershell.exe') {
      const dir = Object.keys(owners).find((d) => argv[4].includes(`'${d.replace(/'/g, "''")}'`));
      return dir ? { ok: true, stdout: `${owners[dir]}\r\n`, stderr: '' } : { ok: false, stdout: '', stderr: 'not found' };
    }
    return { ok: false, stdout: '', stderr: `not a program of this test: ${argv[0]}` };
  };
  return { calls, run };
}

const neverIcacls = (calls) => assert.ok(calls.every((a) => !/icacls|takeown|Set-Acl/i.test(a.join(' '))), `asked: ${calls.map((a) => a[0]).join(', ')}`);

/**
 * PowerShell's reading of a line: single-quoted words, double-quoted words, bare words. A single quote is ' or one of
 * the typographic quotes U+2018 to U+201B (about_Quoting_Rules); two of them in a row inside such a word are one.
 */
function psWords(line) {
  const out = [];
  const re = /['‘-‛]((?:[^'‘-‛]|['‘-‛]{2})*)['‘-‛]|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/(['‘-‛])['‘-‛]/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/** The hand-back line's arguments as PowerShell reads them: the owner, then each folder. */
function handBack(fix) {
  const head = `& { ${W.HANDBACK_WALK} } `;
  assert.ok(String(fix).startsWith(head), fix);
  return psWords(fix.slice(head.length)).filter((w) => w !== ',');
}

const WS = 'C:\\Users\\alex\\Workspace';
const CL = 'C:\\Users\\alex\\.claude';
const dirs = [['Workspace', WS], ["Claude Code's folder", CL]];
const all = () => true;

test('doctor: both folders owned by the Administrators group: named, with the line that hands them back to my SID', async () => {
  const w = windows({ owners: { [WS]: 'S-1-5-32-544', [CL]: 'S-1-5-32-544' } });
  const c = await W.ownerCheck({ platform: 'win32' }, { run: w.run, dirs, exists: all });
  assert.equal(c.id, 'winowner');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /Workspace .*Workspace and Claude Code's folder .*\.claude belong to the Administrators group/);
  assert.match(c.detail, /Hoprig changes nothing/);
  assert.match(c.detail, /Run as administrator/);
  assert.deepEqual(handBack(c.fix), [`*${ME}`, WS, CL]);
  // The owner is asked by its SID (the group's name depends on the language), one PowerShell call per folder.
  const ps = w.calls.filter((a) => a[0] === 'powershell.exe');
  assert.equal(ps.length, 2);
  assert.deepEqual(ps[0], W.ownerArgv(WS));
  assert.match(ps[0][4], /^\$ErrorActionPreference = 'SilentlyContinue'; \$p = 'C:\\Users\\alex\\Workspace'; \$s = \[System\.Security\.AccessControl\.AccessControlSections\]::Owner; .*\[System\.IO\.Directory\]::GetAccessControl\(\$p, \$s\).*\.GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)\.Value\)$/);
  // No cmdlet: no module of Windows PowerShell is loaded (Get-Acl made doctor wait 17 to 19 s for it).
  assert.doesNotMatch(ps[0][4], /\b(Get|Set)-[A-Z]\w+/);
  assert.deepEqual(w.calls.find((a) => a[0] === 'whoami'), ['whoami', '/user', '/fo', 'csv', '/nh']);
  neverIcacls(w.calls);
});

test('doctor: only one folder owned by the group: only that one is named', async () => {
  const w = windows({ owners: { [WS]: ME, [CL]: 'S-1-5-32-544' } });
  const c = await W.ownerCheck({ platform: 'win32' }, { run: w.run, dirs, exists: all });
  assert.equal(c.status, 'warn');
  assert.doesNotMatch(c.detail, /Workspace C:/);
  assert.match(c.detail, /Claude Code's folder .*\.claude belongs to/);
  assert.deepEqual(handBack(c.fix), [`*${ME}`, CL]);
  neverIcacls(w.calls);
});

test('doctor: the person owns both: ok; a folder that is not there: nothing asked about it; none there: no line', async () => {
  let w = windows({ owners: { [WS]: ME, [CL]: ME } });
  const c = await W.ownerCheck({ platform: 'win32' }, { run: w.run, dirs, exists: all });
  assert.equal(c.status, 'ok');
  assert.equal(c.fix, '');
  assert.ok(!w.calls.some((a) => a[0] === 'whoami'), 'no SID needed when nothing is to hand back');
  w = windows({ owners: { [CL]: 'S-1-5-32-544' } });
  const one = await W.ownerCheck({ platform: 'win32' }, { run: w.run, dirs, exists: (d) => d === CL });
  assert.equal(one.status, 'warn');
  assert.equal(w.calls.filter((a) => a[0] === 'powershell.exe').length, 1);
  w = windows();
  assert.equal(await W.ownerCheck({ platform: 'win32' }, { run: w.run, dirs, exists: () => false }), null);
  assert.deepEqual(w.calls, []);
  assert.equal(await W.ownerCheck({ platform: 'linux' }, { run: async () => assert.fail('nothing asked'), dirs, exists: all }), null);
  // Off Windows with no stand-in, doctor asks nothing (the real powershell is never started).
  assert.equal(W.winRun({}), process.platform === 'win32' ? W.winRun({}) : null);
});

test('the hand-back line keeps a path with spaces, a quote, % or $ as one argument', () => {
  // A Windows path cannot hold a double quote; a space, a single quote, % and $ it can.
  for (const dir of ['C:\\Users\\Alex Smith\\Workspace', "C:\\Users\\o'brien\\.claude", 'D:\\100% work\\$HOME\\ws', "C:\\it's 50% off\\$x y"]) {
    const line = W.handBackLine(dir, ME);
    assert.deepEqual(handBack(line), [`*${ME}`, dir], line);
    // The owner question holds the path as one single-quoted word of its command text.
    assert.ok(W.ownerArgv(dir)[4].includes(`$p = '${dir.replace(/'/g, "''")}';`));
  }
  // PowerShell ends a single-quoted string at a typographic quote too: each is doubled, so a folder named with one
  // stays one word, in the line that is pasted and in the owner question Hoprig runs itself.
  for (const dir of ['C:\\Users\\alex\\Bob\u2019s work', 'C:\\a\u2019;Remove-Item x;\u2019', 'D:\\\u2018x\u2019 \u201Ay\u201B']) {
    assert.deepEqual(handBack(W.handBackLine(dir, ME)), [`*${ME}`, dir], dir);
    const cmd = W.ownerArgv(dir)[4];
    const words = psWords(cmd.slice(cmd.indexOf('$p = ') + 5, cmd.indexOf('; $s = ')));
    assert.deepEqual(words, [dir], cmd);
  }
  assert.equal(handBack(W.handBackLine('C:\\a b\\', ME))[1], 'C:\\a b', 'no backslash before the closing quote');
  assert.equal(handBack(W.handBackLine('C:\\', ME))[1], 'C:\\');
  assert.match(W.handBackLine('C:\\x', null), /'\*<your SID: whoami \/user>'/);
});

test('the hand-back line never goes through a link: no /T; a junction is handed back by itself (/L), not gone into', () => {
  // On Windows the workspace links projects as junctions (workspace/link.mjs): icacls /T could reach what they point
  // at, outside the folder. The walk gives each item its own icacls with no /T, and stops at a reparse point.
  const line = W.handBackAll([WS, CL], ME);
  assert.doesNotMatch(line, /\/T\b/i, line);
  const walk = W.HANDBACK_WALK;
  const calls = walk.match(/icacls [^;}]*/g);
  assert.deepEqual(calls, ['icacls $i.FullName /setowner $o /L /C /Q', 'icacls $i.FullName /setowner $o /C /Q']);
  // The link test (1024: FILE_ATTRIBUTE_REPARSE_POINT) comes first and returns before the walk goes deeper.
  const link = walk.indexOf('if($i.Attributes -band 1024){icacls $i.FullName /setowner $o /L /C /Q; return}');
  assert.ok(link > 0 && link < walk.indexOf('gci '), walk);
  assert.ok(walk.indexOf('gci -LiteralPath $i.FullName -Force') > walk.indexOf('if($i.PSIsContainer)'), 'only a real folder is gone into');
  // Health carries a fix of another computer up to 500 characters (machines/health.mjs pickHealth).
  const long = W.handBackAll(['C:\\Users\\alexandra-example\\Workspace', 'C:\\Users\\alexandra-example\\.claude'], ME);
  assert.ok(long.length <= 500, `${long.length}: ${long}`);
});

test('doctor says the line does not go into links', async () => {
  const w = windows({ owners: { [WS]: 'S-1-5-32-544' } });
  const c = await W.ownerCheck({ platform: 'win32' }, { run: w.run, dirs, exists: all });
  assert.match(c.detail, /does not go into links \(junctions\): what they point at keeps its owner/);
  neverIcacls(w.calls);
});

test('elevated: the token is High integrity in any display language; not elevated: Medium; no answer: unknown', async () => {
  assert.equal(await W.runsElevated(windows({ elevated: true }).run), true);
  assert.equal(await W.runsElevated(windows({ elevated: false }).run), false);
  assert.equal(await W.runsElevated(async () => ({ ok: false, stdout: '' })), null);
});

// Set-up as Windows, its other parts doing nothing: only the start and the end are what is looked at.
const NOPARTS = {
  workspace: async () => ({ ok: true, changed: false }),
  git: async () => ({ ok: true, changed: false }),
  pc: async () => ({ ok: true, changed: false, missing: [], code: 0 }),
  projects: async () => ({ dir: '/nowhere', names: ['demo'] }),
  projectSkills: async () => ({ ok: true, added: [], skipped: [] }),
  userSkills: async () => ({ ok: true, added: [], skipped: [] }),
};

async function setupAsWindows(w) {
  const rec = recorder();
  const ui = makeUi({ interactive: false, write: rec.write, askLine: async (q) => assert.fail(`unexpected question: ${q}`) });
  const sys = K.sysInfo({ platform: 'win32', env: { ...process.env }, has: () => false, pm: null, root: false, locales: null, run: w.run });
  await SU.setup(['--only', 'skills', '--yes'], { ui, sys, parts: NOPARTS });
  return rec.text;
}

test('set-up run as administrator says so at its start and gives the hand-back line at its end; nothing changes an owner', async () => {
  const ws = process.env.HOPRIG_WORKSPACE_DIR;
  const cl = process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(cl, { recursive: true });
  const w = windows({ elevated: true, owners: { [ws]: 'S-1-5-32-544', [cl]: 'S-1-5-32-544' } });
  const text = await setupAsWindows(w);
  const start = text.indexOf('Set-up runs as administrator: the folders it makes will belong to the Administrators group');
  const end = text.indexOf('Set-up ran as administrator:');
  assert.ok(start >= 0 && end > start, text);
  assert.ok(start < text.indexOf('Node.js'), 'said before anything else is done');
  const fix = text.slice(end).split('\n')[0];
  assert.deepEqual(handBack(fix.slice(fix.indexOf('& { '))), [`*${ME}`, ws, cl], text);
  neverIcacls(w.calls);
});

test('set-up not run as administrator says nothing of it and asks no owner', async () => {
  const w = windows({ elevated: false, owners: {} });
  const text = await setupAsWindows(w);
  assert.doesNotMatch(text, /administrator/i);
  assert.deepEqual(w.calls.map((a) => a.slice(0, 2).join(' ')), ['whoami /groups']);
  assert.ok(path.isAbsolute(process.env.HOPRIG_WORKSPACE_DIR));
});

test('Windows\' own whoami by its full path under the system root; the bare name only where none is known', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const own = 'C:\\Windows\\System32\\whoami.exe';
  assert.equal(W.whoamiBin({ env, exists: (f) => f === own }), own, 'never a whoami found earlier on PATH (Git for Windows has one)');
  assert.equal(W.whoamiBin({ env: { windir: 'D:\\Win' }, exists: (f) => f === 'D:\\Win\\System32\\whoami.exe' }), 'D:\\Win\\System32\\whoami.exe');
  assert.equal(W.whoamiBin({ env, exists: () => false }), 'whoami', 'not there: the name');
  assert.equal(W.whoamiBin({ env: {}, exists: () => true }), 'whoami', 'no system root: the name');
});
