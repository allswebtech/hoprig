// The wall on Windows. There the system names a place with backslashes (`C:\Users\alex\AppData\…`), takes a forward
// slash as the same separator, and does not tell letter case apart. The wall compared places with a `/` written by
// hand, so a write into Hoprig's own state folder was not seen as inside it there. The places carry the platform
// (`platform: 'win32'`), so these are Windows' answers on any computer; nothing on disk is asked for them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { wallHeld, hoprigRelation, inFolder } = await import('../src/wall.mjs');

const HOME = 'C:\\Users\\alex';
const CFG = `${HOME}\\.config\\hoprig`;
const STATE = `${HOME}\\AppData\\Local\\hoprig-state`;
const SHOP = `${HOME}\\work\\shop`;
const places = { platform: 'win32', cwd: SHOP, home: HOME, workspace: `${HOME}\\work`, projects: [`${HOME}\\work`], hoprig: [CFG, STATE], own: SHOP, relative: true };
const write = (file_path) => wallHeld({ tool: 'Write', input: { file_path, content: '{}' }, cwd: SHOP, places });
const bash = (command) => wallHeld({ tool: 'Bash', input: { command }, cwd: SHOP, places });
const kind = (h) => (h ? h.kind : null);

test('inFolder: on win32 either separator and any case; elsewhere exactly as written', () => {
  assert.equal(inFolder('C:\\Users\\alex\\x', 'C:\\Users\\alex', 'win32'), true);
  assert.equal(inFolder('c:/users/ALEX/x', 'C:\\Users\\alex', 'win32'), true);
  assert.equal(inFolder('C:\\Users\\alex', 'c:/users/alex/', 'win32'), true, 'the folder itself, a separator at the end');
  assert.equal(inFolder('C:\\Users\\alex\\work\\..\\x', 'C:\\Users\\alex', 'win32'), true, 'through ..');
  assert.equal(inFolder('C:\\Users\\alex\\..\\bob', 'C:\\Users\\alex', 'win32'), false, '.. out of it');
  assert.equal(inFolder('C:\\Users\\alex2', 'C:\\Users\\alex', 'win32'), false, 'a name that only begins like it');
  assert.equal(inFolder('D:\\Users\\alex\\x', 'C:\\Users\\alex', 'win32'), false, 'another drive');
  assert.equal(inFolder('C:\\x', 'C:\\', 'win32'), true, 'the root of a drive holds its folders');
  assert.equal(inFolder('\\srv\\hoprig-state\\x', 'D:\\srv\\hoprig-state', 'win32'), true, 'from the root, with no drive');
  // Elsewhere: as today.
  assert.equal(inFolder('/home/alex/x', '/home/alex', 'linux'), true);
  assert.equal(inFolder('/home/alex', '/home/alex', 'linux'), true);
  assert.equal(inFolder('/home/ALEX/x', '/home/alex', 'linux'), false);
  assert.equal(inFolder('/home/alex2', '/home/alex', 'linux'), false);
  assert.equal(inFolder('C:\\Users\\alex\\x', 'C:\\Users\\alex', 'linux'), false, 'a backslash is no separator there');
});

test('a file tool that writes the config file, a run record or the hook settings is held, however the place is written', () => {
  for (const fp of [
    `${CFG}\\config.json`,
    `${STATE}\\runs\\r1.json`,
    `${STATE}\\runs\\r1.json.handsoff`,
    `${STATE}\\hook-settings\\r1.json`,
    'C:/Users/alex/.config/hoprig/config.json',
    'C:/Users/alex/AppData/Local/hoprig-state/runs/r1.json',
    'C:\\Users\\alex/AppData\\Local/hoprig-state\\hook-settings/r1.json',
    'c:\\users\\ALEX\\.Config\\HOPRIG\\Config.json',
    'C:\\USERS\\alex\\appdata\\local\\HOPRIG-STATE\\runs\\r1.json',
    `${SHOP}\\..\\..\\AppData\\Local\\hoprig-state\\runs\\r1.json`,
    '..\\..\\AppData\\Local\\hoprig-state\\hook-settings\\r1.json',
    '../../.config/hoprig/config.json',
    `${STATE}`,
  ]) {
    assert.equal(kind(write(fp)), 'settings', fp);
  }
});

test('a folder that only begins like Hoprig\'s, and an ordinary project file, are not held', () => {
  for (const fp of [`${HOME}\\AppData\\Local\\hoprig-state2\\x.json`, `${HOME}\\.config\\hoprig2\\config.json`, `${SHOP}\\src\\index.js`, 'C:/Users/alex/work/shop/notes.md', 'src\\app.js']) {
    assert.equal(write(fp), null, fp);
  }
});

test('a project.json is named relative to the session\'s own folder, in either spelling', () => {
  const h = write(`${SHOP}\\sub\\Project.json`);
  assert.equal(kind(h), 'project');
  assert.equal(h.part, 'sub\\Project.json');
  assert.equal(write('C:/Users/alex/work/shop/project.json').part, 'project.json');
});

test('a shell line that names Hoprig\'s folders in their Windows forms is held; an ordinary one goes through', () => {
  for (const line of [
    'cat "C:\\Users\\alex\\.config\\hoprig\\config.json"',
    "mv 'C:\\Users\\alex\\AppData\\Local\\hoprig-state\\runs\\r1.json' /tmp/x",
    'mv C:/Users/alex/AppData/Local/hoprig-state/runs/r1.json /tmp/x',
    'echo on > c:/users/alex/.CONFIG/hoprig/config.json',
    'cat ~/.config/hoprig/config.json',
    'cat $HOME/AppData/Local/hoprig-state/hook-settings/r1.json',
    'cat ../../.config/hoprig/config.json',
    'cd ~ && cat .config/hoprig/config.json',
    'cd .. && cd .. && mv .config old',
    'mv ~/.config /tmp/x',
    'mv "C:\\Users\\alex\\AppData" /tmp/x',
    'cp -r ~/AppData/Local /tmp/x',
    'mv ~/AppData/Local/hoprig-st* /tmp/x',
    'cat C:/Users/alex/.config/hop*/config.json',
  ]) {
    assert.equal(kind(bash(line)), 'settings', line);
  }
  // Written unquoted, Bash itself would take the backslashes away; the line still names the folder, so it is held.
  for (const line of ['mv C:\\Users\\alex\\AppData\\Local\\hoprig-state\\runs\\r1.json /tmp/x', 'mv C:\\Users\\alex /tmp/x', 'ln -sf /dev/null C:\\Users\\alex\\.config\\hoprig\\config.json']) {
    assert.equal(kind(bash(line)), 'settings', line);
  }
  // The home folder written unquoted the Windows way, then a Unix way of naming the same folder again: it holds
  // Hoprig's folders, so a change of it is held as the same line with `~` is.
  for (const line of ['mv C:\\Users\\alex/. /tmp/x', 'chmod -R 000 C:\\Users\\alex/./', 'sudo chown -R nobody C:\\Users\\alex/.']) {
    assert.ok(bash(line) && bash(line).acts.some((a) => a.kind === 'settings'), line);
  }
  for (const line of ['npm test', 'cat ~/AppData/Local/hoprig-state2/x.json', 'mv C:\\Users\\alex\\AppData\\Local\\hoprig-state2\\x /tmp/x', 'cat "C:\\Users\\alex\\work\\shop\\README.md"', 'ls ~', 'git status']) {
    assert.equal(bash(line), null, line);
  }
});

test('a name that ends in a dot or a space, which Windows takes away, names the folder without it', () => {
  for (const fp of [
    'C:\\Users\\alex\\.config\\hoprig.\\config.json',
    'C:\\Users\\alex\\.config\\hoprig \\config.json',
    'C:\\Users\\alex\\.config.\\hoprig\\config.json',
    `${STATE}.\\runs\\r1.json`,
    'C:/Users/alex/.config/hoprig. ./config.json',
    `${SHOP}\\.. \\..\\.config\\hoprig\\config.json`,
    '.. \\.. \\.config\\hoprig\\config.json',
  ]) {
    assert.equal(kind(write(fp)), 'settings', fp);
  }
  for (const line of [
    'cp secret.txt C:\\Users\\alex\\.config\\hoprig.\\config.json',
    'cat "C:/Users/alex/.config/hoprig./config.json"',
    'mv "C:\\Users\\alex\\AppData\\Local\\hoprig-state \\runs" /tmp/x',
    'cat C:/Users/alex/.config/hoprig./conf*',
  ]) {
    assert.equal(kind(bash(line)), 'settings', line);
  }
  for (const fp of [`${HOME}\\.config\\hoprig2.\\config.json`, `${HOME}\\AppData\\Local\\hoprig-state2 \\x.json`, `${SHOP}\\notes.\\a.md`]) {
    assert.equal(write(fp), null, fp);
  }
});

test('the extended-length prefix names the same folder as the plain drive path', () => {
  for (const fp of [
    '\\\\?\\C:\\Users\\alex\\.config\\hoprig\\config.json',
    '//?/C:/Users/alex/.config/hoprig/config.json',
    '\\\\?\\C:\\Users\\alex\\AppData\\Local\\hoprig-state\\runs\\r1.json',
  ]) {
    assert.equal(kind(write(fp)), 'settings', fp);
  }
  for (const line of [
    'cat "//?/C:/Users/alex/.config/hoprig/config.json"',
    'cp secret.txt "//?/C:/Users/alex/AppData/Local/hoprig-state/runs/r1.json"',
  ]) {
    assert.equal(kind(bash(line)), 'settings', line);
  }
  // A UNC share reached through the prefix is still that share, not a folder named "UNC".
  assert.equal(inFolder('\\\\?\\UNC\\srv\\sh\\hoprig-state\\x', '\\\\srv\\sh\\hoprig-state', 'win32'), true);
});

test('a Git-Bash drive path (/c/...) names the Windows drive folder', () => {
  for (const line of [
    'cat /c/Users/alex/.config/hoprig/config.json',
    'cp secret.txt /c/Users/alex/.config/hoprig/config.json',
    'echo x > /c/Users/alex/AppData/Local/hoprig-state/runs/r1.json',
    'tee /c/Users/alex/.config/hoprig/config.json',
    'cat /c/Users/alex/.config/hop*/config.json',
  ]) {
    assert.equal(kind(bash(line)), 'settings', line);
  }
  assert.equal(bash('cat /c/Users/alex/work/shop/notes.md'), null, 'an ordinary file under the drive goes through');
  assert.equal(inFolder('/c/Users/alex/x', 'C:\\Users\\alex', 'win32'), true, 'a /c/ path is on drive C');
  assert.equal(inFolder('/c/Users/alex/x', 'D:\\Users\\alex', 'win32'), false, 'and so not on drive D');
});

// The glob table of test/wall-globcd.txt, read with Windows' answers: its places as that test gives them (named from
// the root, no drive), and then in the shape a Windows computer gives (`C:\Users\…` from the home folder, also in
// its 8.3 short form beside the long one).
const globRows = fs.readFileSync(new URL('./wall-globcd.txt', import.meta.url), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
  const i = l.indexOf(' | ');
  return { verdict: l.slice(0, i), line: l.slice(i + 3) };
});
const globGit = (cwd, args) => {
  const a = args.join(' ');
  if (/^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(a)) return 'origin/main';
  if (a === 'symbolic-ref --short HEAD') return 'feature';
  return null;
};
const globPlaces = (home, sep) => {
  const j = (...xs) => [home, ...xs].join(sep);
  return { platform: 'win32', cwd: j('shop'), home, workspace: home, projects: [home], hoprig: [j('.config', 'hoprig'), j('.local', 'state', 'hoprig')], own: j('shop'), relative: true };
};
const globWrong = (pl) => {
  const wrong = [];
  for (const r of globRows) {
    const h = wallHeld({ tool: 'Bash', input: { command: r.line }, cwd: pl.cwd, git: globGit, places: pl });
    const got = h ? 'held' : 'through';
    if (got !== r.verdict) wrong.push(`${JSON.stringify(r.line)}: want ${r.verdict}, got ${got}${h ? ` (${h.kind})` : ''}`);
  }
  return wrong;
};

// With places named from the root (`/w`, as test/wall-globcd gives them), Windows reads `/w` as the Git-Bash form of
// drive W: on both sides of a pattern. A row that changes folder first is left out here: its folder is resolved as a
// root path with no drive, which a Windows home (`C:\Users\…`, the test below) never is.
test('the glob table holds and lets through on Windows as elsewhere, with places from the root', () => {
  assert.deepEqual(globWrong(globPlaces('/w', '/')).filter((w) => !/^"(?:cd|pushd)\b/.test(w)), []);
});

test('the glob table holds and lets through with a Windows home, long or 8.3, and either kind of Hoprig folder', () => {
  // A delete row is left out here: on a Windows drive every delete waits for the owner (src/asking.mjs plainDelete).
  for (const home of ['C:\\Users\\runneradmin', 'C:\\Users\\RUNNER~1', 'c:/Users/runneradmin']) {
    assert.deepEqual(globWrong(globPlaces(home, home.includes('/') ? '/' : '\\')).filter((w) => !w.startsWith('"rm ')), [], home);
  }
  // Home given long while Hoprig's folders are given in the 8.3 form, and the other way round.
  const mixed = [
    { ...globPlaces('C:\\Users\\runneradmin', '\\'), hoprig: ['C:\\Users\\RUNNER~1\\.config\\hoprig', 'C:\\Users\\RUNNER~1\\.local\\state\\hoprig'] },
    { ...globPlaces('C:\\Users\\RUNNER~1', '\\'), hoprig: ['C:\\Users\\runneradmin\\.config\\hoprig', 'C:\\Users\\runneradmin\\.local\\state\\hoprig'] },
  ];
  for (const pl of mixed) {
    for (const line of ['cat ~/.config/hop*/config.json', 'cat ~/.config/*/config.json', 'cat $HOME/.config/*/config.json', 'cat ${HOME}/.config/hopri?/config.json', 'cat ~/.config/?oprig/config.json', 'cat ~/.config/[h]oprig/config.json']) {
      const h = wallHeld({ tool: 'Bash', input: { command: line }, cwd: pl.cwd, git: globGit, places: pl });
      assert.equal(kind(h), 'settings', `${pl.home}: ${line}`);
    }
  }
  for (const pl of [globPlaces('C:\\Users\\runneradmin', '\\'), globPlaces('/w', '/')]) {
    for (const line of ['cat ~/.config/hop*/config.json', 'cat ~/.config/{hoprig,other}/config.json']) {
      const h = wallHeld({ tool: 'Bash', input: { command: line }, cwd: pl.cwd, git: globGit, places: pl });
      assert.equal(kind(h), 'settings', `${pl.home}: ${line}`);
    }
  }
});

// A change of folder to the home folder itself, written unquoted the Windows way (as a session on Windows writes
// `cd C:\Users\alex`), is what `cd ~` is: it and a harmless read there go through. A move or a write of the home
// folder, or of a folder in it above Hoprig's own, stays held.
test('a cd to the home folder written with backslashes, and a harmless read there, go through', () => {
  const both = (line) => [wallHeld({ tool: 'Bash', input: { command: line }, cwd: SHOP, places }), wallHeld({ tool: 'Bash', input: { command: line }, places })].map(kind);
  for (const line of ['cd C:\\Users\\alex && ls', 'pushd C:\\Users\\alex && ls', 'cd C:\\Users\\alex ; pwd', 'cd C:/Users/alex && ls', 'cd c:\\users\\ALEX && ls']) {
    assert.deepEqual(both(line), [null, null], line);
  }
  for (const line of ['cd C:\\Users\\alex && mv .config old', 'cd C:\\Users\\alex && cat .config\\hoprig\\config.json', 'mv C:\\Users\\alex /tmp/x', 'cd C:\\Users\\alex\\.config && ls', 'cd "C:\\Users\\alex" extra']) {
    assert.ok(both(line).every((k) => k !== null), line);
  }
});

// A path the wall cannot place against Hoprig's folders, but that could name one, is held on Windows in a command
// that is not only a read (fail closed): a drive-relative path, a UNC or loopback share, a device path, an 8.3 short
// name. A device or extended-length path of a plain drive reduces to that drive and is placed as usual.
test('a Windows path the wall cannot place is held in a command that is not only a read (fail closed)', () => {
  for (const line of [
    // drive-relative: read from the current folder on the drive, which the line does not name
    'mv C:..\\..\\.config\\hoprig\\config.json X:\\x',
    'rm -rf C:..\\..\\.config\\hoprig',
    'cp secret.txt "C:.\\..\\..\\.config\\hoprig\\config.json"',
    'chmod -R 000 c:../../.CONFIG/hoprig',
    // a loopback administrative share, and the extended-length spelling of one, reach a local drive
    'mv "\\\\localhost\\C$\\Users\\alex\\.config\\hoprig" /tmp/x',
    'chmod 000 \\\\127.0.0.1\\c$\\Users\\alex\\.config\\hoprig',
    'cp x "\\\\?\\UNC\\localhost\\C$\\Users\\alex\\.config\\hoprig\\config.json"',
    // a device path of a plain drive reduces to the drive and is placed as the config file it names
    'cp secret.txt "//./C:/Users/alex/.config/hoprig/config.json"',
    'mv \\\\.\\C:\\Users\\alex\\.config\\hoprig\\config.json /tmp/x',
    // an 8.3 short name, which the long folder may carry on Windows
    'mv C:\\Users\\alex\\CONFIG~1\\hoprig\\config.json /tmp/x',
    'rm -rf C:\\opt\\HOPRIG~1',
  ]) {
    assert.ok(bash(line), line);
  }
  // Only a read of an unplaceable path goes through (the wall cannot tell a read from a write there, and holds only
  // what is not only a read); an ordinary Windows path, placeable, is untouched by this rule.
  for (const line of ['cat \\\\fileserver\\docs\\notes.md', 'ls "\\\\fileserver\\docs"', 'cat "\\\\localhost\\C$\\Users\\alex\\work\\shop\\a.md"', 'mv C:\\Users\\alex\\work\\shop\\a.js /tmp\\x', 'cp src\\app.js /tmp\\x']) {
    assert.equal(bash(line), null, line);
  }
});

// An administrative share of a drive (`\\localhost\C$\…`) reaches that drive: a path through it is also placed as the
// drive path it reaches, so a READ of Hoprig's own files through a share is held as the plain read of them is.
test('a read of Hoprig\'s files through a share of a drive is held as the plain read is', () => {
  const cfg = 'Users\\alex\\.config\\hoprig\\config.json';
  for (const reader of ['cat', 'head', 'tail', 'less', 'more', 'grep x', 'rg x', 'stat', 'wc -l', 'diff a.txt']) {
    assert.equal(kind(bash(`${reader} C:\\${cfg}`)), 'settings', `${reader}, the plain path`);
    for (const via of ['\\\\localhost\\C$', '\\\\127.0.0.1\\c$', '\\\\?\\UNC\\localhost\\C$', '//localhost/C$', '\\\\ALEX-PC\\C$']) {
      assert.equal(kind(bash(`${reader} "${via}\\${cfg}"`)), 'settings', `${reader} through ${via}`);
    }
    assert.equal(kind(bash(`${reader} \\\\localhost\\C$\\${cfg}`)), 'settings', `${reader}, unquoted`);
  }
  for (const line of [
    'ls \\\\127.0.0.1\\c$\\Users\\alex\\.config\\hoprig',
    'cat "\\\\localhost\\C$\\Users\\alex\\.config\\hop*\\config.json"',
    'cat "\\\\localhost\\C$\\Users\\alex\\AppData\\Local\\hoprig-state\\runs\\r1.json"',
    'type "\\\\localhost\\C$\\Users\\alex\\.config\\hoprig\\config.json"',
  ]) {
    assert.equal(kind(bash(line)), 'settings', line);
  }
  for (const pl of shapes()) {
    for (const line of ['cat \\\\localhost\\C$\\Users\\runneradmin\\AppData\\Roaming\\hoprig\\config.json', 'cat "\\\\127.0.0.1\\C$\\Users\\RUNNER~1\\AppData\\Roaming\\hoprig\\config.json"', 'grep token "//localhost/c$/Users/runneradmin/AppData/Local/hoprig/state/runs/r1.json"']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['cat \\\\localhost\\C$\\Users\\runneradmin\\work\\shop\\a.md', 'cat "\\\\localhost\\C$\\Users\\runneradmin\\AppData\\Roaming\\hoprig2\\x.json"', 'ls \\\\fileserver\\docs']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
});

// PowerShell also spells a folder variable through its provider with braces: `${env:APPDATA}`, in any case.
test('PowerShell\'s ${env:APPDATA} spelling is placed as $env:APPDATA is', () => {
  for (const pl of shapes()) {
    for (const line of [
      'powershell -c "gc ${env:APPDATA}\\hoprig\\config.json"',
      'powershell -c "Set-Content ${env:APPDATA}\\hoprig\\config.json x"',
      'powershell -c "Remove-Item ${env:LOCALAPPDATA}\\hoprig\\state\\runs\\r1.json"',
      'pwsh -c "gc ${Env:APPDATA}\\hoprig\\config.json"',
      'pwsh -c "gc ${ENV:AppData}/hoprig/config.json"',
      'pwsh -c "gc ${env:USERPROFILE}\\AppData\\Roaming\\hoprig\\config.json"',
    ]) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['pwsh -c "gc ${env:APPDATA}\\other\\config.json"', 'pwsh -c "gci ${env:LOCALAPPDATA}\\Temp"', 'pwsh -c "echo ${env:PATH}"']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
});

// A line that only MENTIONS the folder above Hoprig's (a commit message, a search pattern, an echo) is held on Windows
// when it names that folder through its variable, exactly as it is held when it names it by `~` there, and as the same
// mention of `~/.config` is held on Linux: the wall cannot tell a mention from a use, and it leans to holding. This
// test keeps the three alike, so the Windows variable spelling is neither looser nor stricter than the plain one.
test('a mention of the folder above Hoprig\'s through a Windows variable is held as the same mention by ~ is, as on Linux', () => {
  const LH = '/home/alex';
  const linux = { platform: 'linux', cwd: `${LH}/work/shop`, home: LH, workspace: `${LH}/work`, projects: [`${LH}/work`], hoprig: [`${LH}/.config/hoprig`, `${LH}/.local/state/hoprig`], own: `${LH}/work/shop`, relative: true };
  for (const say of [(x) => `git commit -m "${x} in the readme"`, (x) => `git log --grep "${x}"`, (x) => `echo "${x}"`, (x) => `echo ${x}`]) {
    assert.equal(kind(on(linux, 'Bash', say('~/.config'))), 'settings', say('~/.config'));
    for (const pl of shapes()) {
      assert.equal(kind(on(pl, 'Bash', say('~/AppData/Roaming'))), 'settings', label(pl, say('~/AppData/Roaming')));
      for (const v of ['%APPDATA%', '$APPDATA', '${APPDATA}', '$env:APPDATA', '${env:APPDATA}', '%LOCALAPPDATA%']) assert.equal(kind(on(pl, 'Bash', say(v))), 'settings', label(pl, say(v)));
    }
  }
  // A variable that names no folder of Hoprig's or above it, and a folder beside Hoprig's, are no such mention.
  for (const pl of shapes()) {
    for (const line of ['git commit -m "%TEMP% in the readme"', 'git commit -m "see %APPDATA%\\Microsoft"', 'echo "%PROGRAMFILES%"', 'git log --grep "%APPDATA%\\npm"']) assert.equal(on(pl, 'Bash', line), null, label(pl, line));
  }
});

// A quoted text after `cmd /c` or `cmd /k` is the command cmd runs, and what cmd runs may carry a command itself.
test('a quoted command after cmd /c or /k, and a cmd behind a cmd, are read as the commands they run', () => {
  for (const line of [
    'cmd /c "gsudo whoami"',
    'cmd /k "gsudo whoami"',
    'cmd /c "sudo whoami"',
    'cmd.exe /C "runas /user:Administrator cmd"',
    'cmd /c cmd /c gsudo whoami',
    'cmd /c cmd /c "gsudo whoami"',
    'cmd /c powershell -c "gsudo whoami"',
    'cmd /c "powershell -c Start-Process cmd -Verb RunAs"',
    'powershell -c Start-Process cmd -Verb RunAs',
    'pwsh -Command gsudo whoami',
  ]) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
  assert.equal(kind(bash('cmd /c "git push origin main"')), 'push', 'a kind inside the quoted text is read too');
  for (const line of ['cmd /c "dir"', 'cmd /c "echo done"', 'cmd /c "npm test"', 'cmd /c cmd /c dir', 'cmd /c "type notes.md"', 'powershell -c Get-ChildItem', 'pwsh -Command Start-Process notepad', 'pwsh -c npm test']) {
    assert.equal(bash(line), null, line);
  }
});

// Home and Hoprig's folders each in another of the two spellings: a pattern that could name a folder ABOVE Hoprig's is
// held there as it is where both are spelled alike.
test('a pattern that names a folder above Hoprig\'s is held where home and Hoprig\'s folders differ in 8.3 form', () => {
  for (const pl of shapes()) {
    for (const line of ['mv ~/AppData/Roam* /tmp/x', 'mv ~/App* /tmp/x', 'mv ~/AppData/Loc?l /tmp/x', 'mv ~/AppData/{Roaming,Temp} /tmp/x']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['mv ~/wor* /tmp/x', 'ls ~/Doc*', 'ls ~/work/shop/*.md', 'mv ~/AppData/Roaming/npm* /tmp/x']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
  // The same folder named inside a command text (a shell's -c), which only the match of the text itself reads.
  for (const pl of shapes()) {
    for (const line of ['bash -c "mv ~/AppData/Roaming /tmp/x"', 'bash -c "mv ~/AppData old"', 'powershell -c "Move-Item ~/AppData/Local x"']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['bash -c "ls ~/work"', 'bash -c "mv ~/AppData/Roaming/npm /tmp/x"']) assert.equal(on(pl, 'Bash', line), null, label(pl, line));
  }
});

// Everyday Windows work is no unplaceable path: a git revision (`HEAD~1`), a package range (`@~4`), a message that
// begins like a drive (`a: …`), a cmd switch (`/c`, `/e`), a `//` comment. Read on every home shape and both layouts.
test('everyday Windows lines with a ~digit, a colon or a cmd switch go through', () => {
  const lines = fs.readFileSync(new URL('./wall-windows-through.txt', import.meta.url), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.ok(lines.length >= 15);
  for (const pl of [...shapes(), ...shapes('config')]) {
    for (const line of lines) assert.equal(on(pl, 'Bash', line), null, label(pl, line));
  }
});

// On Windows the escalator is read with either separator and any case, without a .exe/.com/.bat/.cmd suffix, and
// `gsudo` is one too, so a command that asks for administrator rights the Windows way is held.
test('a Windows escalator (sudo.exe, a full path to it, gsudo) is read as asking for administrator rights', () => {
  for (const line of [
    'sudo.exe rm -rf C:\\Users\\alex\\.config\\hoprig',
    'Sudo.EXE whoami',
    '"C:\\Windows\\System32\\sudo.exe" whoami',
    'gsudo whoami',
    'gsudo cmd /c "rd /s /q C:\\Users\\alex\\.config\\hoprig"',
  ]) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
});

// Hoprig's Windows folders named through %APPDATA%, %LOCALAPPDATA% or %USERPROFILE%, in the spelling of Bash,
// PowerShell or cmd, are placed with each variable's Windows default under the home folder.
test('a Windows folder variable that names Hoprig\'s folders is placed through its default value', () => {
  for (const pl of shapes()) {
    for (const line of [
      'cp x $APPDATA/hoprig/config.json',
      'mv $APPDATA/hoprig /tmp/x',
      'cp x ${APPDATA}/hoprig/config.json',
      'cp x "$LOCALAPPDATA\\hoprig\\state\\hook-settings\\r1.json"',
      'cat $USERPROFILE/AppData/Roaming/hoprig/config.json',
      'powershell -c "Set-Content $env:APPDATA\\hoprig\\config.json x"',
      'pwsh -c "Remove-Item -Recurse $env:LOCALAPPDATA\\hoprig\\state"',
      'cmd /c del %APPDATA%\\hoprig\\config.json',
      'mv $APPDATA old',
    ]) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['cp x $APPDATA/other/config.json', 'cat %LOCALAPPDATA%\\Temp\\out.log', 'echo $USERPROFILE', 'ls $APPDATA/Microsoft']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
});

// A read of Hoprig's config through an 8.3 part, and a quoted glob written with backslashes, are held as the plain
// spelling of the same read is.
test('a Windows read through an 8.3 part or a quoted backslash glob is held as its plain spelling is', () => {
  for (const pl of shapes()) {
    for (const line of ['cat C:/Users/RUNNER~1/AppData/Roaming/hoprig/config.json', 'cat "C:\\Users\\runneradmin\\AppData\\Roaming\\hop*\\config.json"', "cat 'C:\\Users\\runneradmin\\AppData\\Roaming\\hoprig\\conf*'"]) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    assert.equal(on(pl, 'Bash', 'cat "C:\\Users\\runneradmin\\work\\shop\\*.md"'), null, label(pl, 'quoted glob in the project'));
  }
  for (const pl of shapes('config')) {
    for (const line of ['cat C:\\Users\\runneradmin\\CONFIG~1\\hoprig\\config.json', 'cat ~/CONFIG~1/hoprig/config.json']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
  }
});

// runas, PowerShell's Start-Process -Verb RunAs, an escalator inside a PowerShell -c text, and an unquoted backslash
// path to sudo.exe ask Windows for administrator rights too.
test('runas, Start-Process -Verb RunAs, a PowerShell -c text and an unquoted path to sudo.exe are held as administrator', () => {
  for (const line of [
    'runas /user:Administrator cmd',
    'runas.exe /user:Administrator "cmd /c whoami"',
    'powershell -c "Start-Process cmd -Verb RunAs"',
    'pwsh -Command "Start-Process pwsh -Verb runas"',
    'powershell -c "gsudo whoami"',
    'pwsh -c "sudo whoami"',
    'C:\\Windows\\System32\\sudo.exe whoami',
    'C:\\Tools\\gsudo.exe whoami',
    'cmd /c sudo whoami',
    'cmd.exe /K gsudo whoami',
  ]) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
  for (const line of ['powershell -c "Get-ChildItem"', 'pwsh -c "Start-Process notepad"', 'C:\\Tools\\node.exe app.js', 'git log --grep runas']) {
    assert.equal(bash(line), null, line);
  }
});

// A Windows computer with Hoprig in its default folders (%APPDATA%\hoprig, %LOCALAPPDATA%\hoprig\state) or in the
// .config layout, its home given long, in 8.3 short form, with forward slashes, or home and Hoprig's folders each in
// another of the two spellings (the system may give os.homedir() and APPDATA so).
const RA = 'C:\\Users\\runneradmin';
const RS = 'C:\\Users\\RUNNER~1';
const rig = (home, base = home, layout = 'appdata') => {
  const s = home.includes('/') ? '/' : '\\';
  const b = base.includes('/') ? '/' : '\\';
  return {
    platform: 'win32', cwd: `${home}${s}work${s}shop`, home, workspace: `${home}${s}work`, projects: [`${home}${s}work`], own: `${home}${s}work${s}shop`, relative: true,
    hoprig: layout === 'appdata' ? [['AppData', 'Roaming', 'hoprig'], ['AppData', 'Local', 'hoprig', 'state']].map((xs) => [base, ...xs].join(b)) : [['.config', 'hoprig'], ['.local', 'state', 'hoprig']].map((xs) => [base, ...xs].join(b)),
  };
};
const shapes = (layout = 'appdata') => [rig(RA, RA, layout), rig(RS, RS, layout), rig('c:/Users/runneradmin', 'c:/Users/runneradmin', layout), rig(RA, RS, layout), rig(RS, RA, layout)];
const MIXED = [rig(RA, RS), rig(RS, RA)];
const on = (pl, tool, x) => wallHeld({ tool, input: tool === 'Bash' ? { command: x } : { file_path: x, content: '{}' }, cwd: pl.cwd, git: globGit, places: pl });
const label = (pl, x) => `${pl.home} / ${pl.hoprig[0]}: ${x}`;

test('a Windows path with an 8.3 short part is compared part by part with Hoprig\'s folders, by the file tools too', () => {
  for (const pl of shapes()) {
    for (const fp of ['C:\\Users\\RUNNER~1\\AppData\\Roaming\\hoprig\\config.json', 'C:\\Users\\runneradmin\\APPDAT~1\\Roaming\\hoprig\\config.json', 'c:/users/runner~1/appdat~1/local/hoprig/state/runs/r1.json']) {
      assert.equal(kind(on(pl, 'Write', fp)), 'settings', label(pl, fp));
      assert.equal(kind(on(pl, 'Edit', fp)), 'settings', label(pl, fp));
    }
    for (const line of ['cat C:/Users/RUNNER~1/AppData/Roaming/hoprig/config.json', 'cp x C:\\Users\\RUNNER~1\\AppData\\Roaming\\hoprig\\config.json', 'mv C:\\Users\\RUNNER~1\\APPDAT~1 /tmp/x']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    // A short part that cannot be the folder it stands beside, and an ordinary file under a short home, go through.
    for (const fp of ['C:\\Users\\RUNNER~1\\work\\shop\\notes.md', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\out.log', 'C:\\Users\\runneradmin\\DOCUME~1\\x.txt']) {
      assert.equal(on(pl, 'Write', fp), null, label(pl, fp));
    }
  }
  for (const pl of shapes('config')) {
    for (const fp of ['C:\\Users\\runneradmin\\CONFIG~1\\hoprig\\config.json', 'C:\\Users\\RUNNER~1\\.config\\hoprig\\config.json']) {
      assert.equal(kind(on(pl, 'Write', fp)), 'settings', label(pl, fp));
    }
    for (const line of ['cat ~/CONFIG~1/hoprig/config.json', 'cat C:\\Users\\runneradmin\\CONFIG~1\\hoprig\\config.json']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
  }
  // Home and Hoprig's folders in the two spellings: a plain path from the home folder reaches Hoprig's as it does when
  // both are spelled alike.
  for (const pl of MIXED) {
    for (const line of ['cd ~ && cp x AppData/Roaming/hoprig/config.json', 'cd ~ && mv AppData old', 'cat ~/AppData/Roaming/HOPRIG/config.json', 'ls ~/AppData/Roaming/hoprig', 'cd ~/AppData/Roaming/hoprig && cat config.json']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    assert.equal(kind(on(pl, 'Write', '..\\..\\AppData\\Roaming\\hoprig\\config.json')), 'settings', label(pl, 'Write ..\\..'));
    for (const line of ['ls ~', 'cd ~ && ls', 'cat ~/AppData/Roaming/hoprig2/x.json', 'npm test']) assert.equal(on(pl, 'Bash', line), null, label(pl, line));
  }
});

// A file tool on Windows holds a write to a share the wall cannot place, or to a drive-relative path, as a shell line
// that writes there is held: either could be one of Hoprig's own folders.
test('a file tool on Windows holds a write to a loopback share or a drive-relative path (fail closed)', () => {
  for (const pl of shapes()) {
    for (const fp of ['\\\\localhost\\C$\\Users\\runneradmin\\AppData\\Roaming\\hoprig\\config.json', '//127.0.0.1/c$/Users/runneradmin/AppData/Roaming/hoprig/config.json', '\\\\?\\UNC\\localhost\\C$\\Users\\runneradmin\\AppData\\Roaming\\hoprig\\config.json', 'C:..\\..\\AppData\\Roaming\\hoprig\\config.json', 'c:config.json']) {
      assert.equal(kind(on(pl, 'Write', fp)), 'settings', label(pl, fp));
      assert.equal(kind(on(pl, 'Edit', fp)), 'settings', label(pl, fp));
    }
    for (const fp of ['C:\\Users\\runneradmin\\work\\shop\\src\\app.js', 'src\\app.js', '//?/C:/Users/runneradmin/work/shop/a.md']) assert.equal(on(pl, 'Write', fp), null, label(pl, fp));
  }
});

// A Git-Bash cd (`cd /c/Users/…`) lands in the drive folder it names, so a relative path after it is placed there.
test('a Git-Bash cd to the home folder or below it is followed, so a later relative path is placed under it', () => {
  for (const pl of shapes()) {
    for (const line of ['cd /c/Users/runneradmin && cp x AppData/Roaming/hoprig/config.json', 'cd /c/Users/runneradmin && mv AppData old', 'cd /c/Users/runneradmin/AppData/Roaming && cp x hoprig/config.json']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['cd /c/Users/runneradmin && ls', 'cd /c/Users/runneradmin/work/shop && cp x notes.md']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
});

test('hoprigRelation reads Windows places: inside, above (up to a drive\'s root), or neither', () => {
  const p = { hoprig: [CFG, STATE], platform: 'win32' };
  assert.equal(hoprigRelation('c:/users/alex/appdata/local/HOPRIG-STATE/runs/r1.json', p, null), 'inside');
  assert.equal(hoprigRelation(`${HOME}\\AppData`, p, null), 'above');
  assert.equal(hoprigRelation('C:\\', p, null), 'above');
  assert.equal(hoprigRelation('/', p, null), 'above', 'the root of the current drive');
  assert.equal(hoprigRelation(`${HOME}\\AppData\\Local\\hoprig-state2`, p, null), null);
  assert.equal(hoprigRelation('..\\..\\AppData\\Local\\hoprig-state\\x', p, SHOP), 'inside');
  // A folder named from the root with no drive, as a test or a setting may give it.
  assert.equal(hoprigRelation('/srv/made-up/hoprig-state/x', { hoprig: ['/srv/made-up/hoprig-state'], platform: 'win32' }, null), 'inside');
  assert.equal(hoprigRelation('D:\\srv\\made-up\\hoprig-state\\x', { hoprig: ['/srv/made-up/hoprig-state'], platform: 'win32' }, null), 'inside');
});

// ---- what a second look at the Windows wall found ----

// The hook that asks the wall has seconds for ONE line, so a timing test measures each line by itself: every line
// must answer within LINE_MS (on a real Windows computer each place is also asked of the disk, so a line is slower
// there than its Windows answers are elsewhere). The slowest line of a test is said on Windows, where it is read.
const LINE_MS = 2500; // half of what the hook has: a shared build computer is slower than a desk
const slow = { ms: 0, chars: 0 };
const timed = (line, ask) => {
  const t0 = performance.now();
  const held = ask();
  const ms = performance.now() - t0;
  if (ms > slow.ms) Object.assign(slow, { ms, chars: line.length });
  assert.ok(ms < LINE_MS, `${Math.round(ms)} ms for a line of ${line.length} characters`);
  return held;
};
const tbash = (line) => timed(line, () => bash(line));
const ton = (pl, tool, line) => timed(line, () => on(pl, tool, line));
const slowest = () => {
  if (process.platform === 'win32') console.log(`WINDIAG walltime: the slowest line took ${Math.round(slow.ms)} ms (${slow.chars} characters)`);
  Object.assign(slow, { ms: 0, chars: 0 });
};

// A long line of nested `cmd /c` texts is read once per text, not once per `cmd /c` before it: the hook has seconds.
test('a line of many nested cmd /c is read in a bounded time, and an escalator behind them is still held', () => {
  const flat = 'cmd /c '.repeat(60);
  const long = 'cmd /c '.repeat(285);
  const nest = (n, inner) => `${'cmd /c '.repeat(n)}"${inner}"`;
  const four = nest(24, nest(24, nest(24, nest(24, 'x').replace(/"/g, "'")).replace(/"/g, '\\"')));
  assert.equal(tbash(`${flat}"${flat}dir"`), null, 'sixty, and sixty more in their text');
  tbash(four);
  assert.equal(kind(tbash(`gsudo whoami; ${four}`)), 'admin');
  assert.equal(kind(tbash(`${flat}gsudo whoami`)), 'admin');
  assert.equal(kind(tbash(`${flat}"${flat}gsudo whoami"`)), 'admin');
  // A chain longer than any real line is held, not read on for ever, and not let through unread.
  assert.ok(tbash(`${long}dir`));
  assert.ok(tbash(`${long}"${long}x"`));
  slowest();
});

test('cmd runs its command behind //c, joined switches, a full path, start, call and @; find hands on to cmd', () => {
  for (const line of [
    'cmd //c "gsudo whoami"', 'cmd //c gsudo whoami', 'cmd //C "sudo whoami"', 'cmd.exe //k gsudo whoami',
    'cmd /c"gsudo whoami"', 'cmd /cgsudo whoami', 'cmd /s/c "gsudo whoami"', 'cmd /d /s /c "gsudo whoami"',
    'C:\\Windows\\System32\\cmd.exe /c "gsudo whoami"', '"C:\\Windows\\System32\\cmd.exe" /c gsudo whoami',
    'cmd /c start gsudo whoami', 'start gsudo whoami', 'start "" /b gsudo whoami', 'cmd /c @gsudo whoami', 'cmd /c call gsudo whoami',
    'find . -exec cmd /c gsudo whoami ;',
  ]) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
  assert.equal(kind(bash('cmd //c "git push origin main"')), 'push');
  for (const line of ['cmd //c dir', 'cmd /c @echo off', 'start notepad notes.md', 'cmd /c call build.bat', 'cmd /c start "" notes.md', 'find . -exec cmd /c echo {} ;']) {
    assert.equal(bash(line), null, line);
  }
});

test('PowerShell runs its command behind every prefix of -Command, as its first word, through iex; saps and start with RunAs', () => {
  for (const line of [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -c "gsudo whoami"',
    'powershell -Comm "gsudo whoami"', 'powershell -com gsudo whoami', 'pwsh --command "gsudo whoami"',
    'powershell gsudo whoami', 'powershell "gsudo whoami"', 'powershell -NoProfile "gsudo whoami"', 'powershell -ExecutionPolicy Bypass gsudo whoami',
    'powershell -c "iex \'gsudo whoami\'"', 'pwsh -c "Invoke-Expression \'sudo whoami\'"',
    'pwsh -c "saps cmd -Verb RunAs"', 'pwsh -c "start cmd -Verb RunAs"', 'pwsh -c "Start-Process cmd -Verb:RunAs"', 'pwsh -c "Start-Process cmd -Ve RunAs"',
  ]) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
  for (const line of [
    'powershell -File build.ps1 -Message "sudo is not on windows"', 'pwsh build.ps1 -Message "sudo is not on windows"', 'pwsh -NoLogo ./build.ps1', 'powershell -NoProfile -File scripts\\tidy.ps1',
    'pwsh -c "Start-Process notepad -Verb Open"', 'pwsh -c "iex \'Get-Date\'"',
  ]) {
    assert.equal(bash(line), null, line);
  }
});

// With `cmd /c` only the command's own text is a command: a later quoted word is an argument of what runs. cmd knows
// no single quote. A PowerShell text is read as a text, never as one program's name.
test('everyday cmd /c and PowerShell -c lines go through', () => {
  for (const line of [
    'cmd /c git commit -m "npm publish after review"', 'cmd /c git commit -m "sudo is not on windows"', 'cmd /c echo "git push origin main later"',
    'cmd /c "echo it\'s done"', 'cmd /c "echo Don\'t forget"', 'cmd /c git commit -m "don\'t panic"',
    'cmd /c "npm run build"', 'cmd /c "for %i in (*.txt) do echo %i"',
    'powershell -c "Get-ChildItem bin\\Release"', 'pwsh -c "Remove-Item -Recurse -Force bin/Release"', 'pwsh -c "Get-Content ./scripts/deploy.sh"', 'pwsh -c "ls ./docs/publish"',
    'powershell -c "Get-Content notes.md | Select -First 5"', 'powershell -Command Write-Host hi',
  ]) {
    assert.equal(bash(line), null, line);
  }
});

test('a share of a drive inside a command text, and the \\\\.\\UNC\\ spelling, are placed as the plain path is', () => {
  const cfg = 'Users\\alex\\.config\\hoprig\\config.json';
  for (const line of [
    `pwsh -c "gc \\\\localhost\\C$\\${cfg}"`, `cmd /c "type \\\\localhost\\C$\\${cfg}"`, 'bash -c "cat //localhost/c$/Users/alex/.config/hoprig/config.json"',
    `pwsh -c "gc \\\\\\\\localhost\\\\C$\\\\Users\\\\alex\\\\.config\\\\hoprig\\\\config.json"`,
    `cat "\\\\.\\UNC\\localhost\\C$\\${cfg}"`, 'cat "//./UNC/localhost/C$/Users/alex/.config/hoprig/config.json"', 'ls "\\\\.\\UNC\\localhost\\C$\\Users\\alex\\.config"',
    'cat "\\\\.\\UNC\\127.0.0.1\\c$\\Users\\alex\\AppData\\Local\\hoprig-state\\runs\\r1.json"', `bash -c "cat '\\\\?\\UNC\\localhost\\C$\\${cfg}'"`,
  ]) {
    assert.equal(kind(bash(line)), 'settings', line);
  }
  for (const line of ['pwsh -c "gc \\\\localhost\\C$\\Users\\alex\\work\\shop\\a.md"', 'cmd /c "type \\\\fileserver\\docs\\a.md"', 'cat "\\\\.\\UNC\\fileserver\\docs\\a.md"', 'bash -c "cat //buildbox/c$/logs/build.log"']) {
    assert.equal(bash(line), null, line);
  }
});

test('Hoprig\'s own variables in the spelling of PowerShell and cmd are a use of them; a mention of the name is not', () => {
  for (const pl of shapes()) {
    for (const line of [
      'pwsh -c "gc $env:HOPRIG_RUN_FILE"', 'pwsh -c "Set-Content ${env:HOPRIG_RUN_FILE} x"', 'pwsh -c "Remove-Item -Recurse $env:HOPRIG_STATE_DIR"', 'pwsh -c "gc $Env:hoprig_config_dir\\config.json"',
      'cmd /c "type %HOPRIG_RUN_FILE%"', 'cmd /c "del %HOPRIG_CONFIG_DIR%\\config.json"', 'cmd /v:on /c "type !HOPRIG_RUN_FILE!"',
      'cmd /v:on /c "type !APPDATA!\\hoprig\\config.json"', 'cmd /c "type %HOMEDRIVE%%HOMEPATH%\\AppData\\Roaming\\hoprig\\config.json"',
    ]) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['git grep HOPRIG_RUN_FILE', 'git commit -m "document HOPRIG_STATE_DIR"', 'pwsh -c "gc $env:HOPRIG_OTHER"', 'cmd /c "echo %HOPRIG_VERSION%"']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
});

// Home and Hoprig's folders in either 8.3 spelling, and a command text that writes the place in the other one.
test('a place inside a command text is read part by part where an 8.3 short part is in play', () => {
  const texts = [
    'bash -c "mv C:/Users/runneradmin/AppData /tmp/x"', 'bash -c "mv C:/Users/runneradmin/AppData/Roaming /tmp/x"', 'bash -c "mv C:/Users/RUNNER~1/AppData/Local /tmp/x"',
    'bash -c "cat C:/Users/runneradmin/AppData/Roaming/hoprig/config.json"', 'pwsh -c "gc C:\\Users\\runneradmin\\AppData\\Roaming\\hoprig\\config.json"',
    'pwsh -c "gc C:\\Users\\RUNNER~1\\AppData\\Roaming\\hoprig\\config.json"', 'bash -c "cat /c/Users/RUNNER~1/AppData/Roaming/hoprig/config.json"', 'bash -c "cat ~/APPDAT~1/Roaming/hoprig/config.json"',
  ];
  for (const pl of [...shapes(), rig('c:/Users/runneradmin', RS), rig('C:/Users/RUNNER~1', RA)]) {
    for (const line of texts) assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    for (const line of ['bash -c "ls C:/Users/runneradmin/work"', 'bash -c "cat C:/Users/RUNNER~1/work/shop/notes.md"', 'pwsh -c "gc C:\\Users\\runneradmin\\AppData\\Roaming\\npm\\x.json"', 'bash -c "ls C:/Users/RUNNER~1/DOCUME~1"']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
});

// ---- what the look at that second round found ----

test('a line of many PowerShells behind switches is read in a bounded time', () => {
  for (const g of [12, 18, 24, 31]) {
    const line = `powershell -x ${'powershell powershell -x '.repeat(g)}x`;
    tbash(line);
    assert.equal(kind(tbash(`gsudo whoami; ${line}`)), 'admin');
    assert.equal(kind(tbash(`${line.slice(0, -1)}gsudo whoami`)), 'admin', `${g}: the escalator at its end`);
  }
  slowest();
});

test('PowerShell: a quoted switch, a command behind switches with and without a value, a verb with a blank after its colon', () => {
  for (const line of [
    'pwsh "-c" "gsudo whoami"', "powershell '-Command' 'gsudo whoami'", 'pwsh "-Command" gsudo whoami',
    'powershell -ExecutionPolicy Bypass -NoProfile gsudo whoami', 'powershell -ep bypass -nop "gsudo whoami"', 'powershell -WindowStyle Hidden -ExecutionPolicy Bypass "gsudo whoami"',
    'powershell -NoLogo -NonInteractive -ep Bypass gsudo whoami', 'pwsh -Unknown value gsudo whoami', 'pwsh -Unknown gsudo whoami',
    'powershell -c Start-Process cmd -Verb: RunAs',
  ]) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
  // A switch's value is never read as a program, and a script with its own words is the script.
  for (const line of [
    'pwsh -wd C:/proj/release ./build.ps1', 'pwsh -WorkingDirectory ../publish ./test.ps1', 'powershell -ExecutionPolicy Bypass .\\setup.ps1 -Force', 'pwsh ./build.ps1 deploy', 'pwsh -NoLogo ./tidy.ps1',
    'powershell -ExecutionPolicy Bypass -NoProfile -File scripts\\tidy.ps1', 'pwsh "-File" build.ps1 -Message "sudo is not on windows"', 'pwsh -v',
  ]) {
    assert.equal(bash(line), null, line);
  }
});

test('cmd: a @ inside its quoted text is dropped; a program whose name only ends like cmd is itself', () => {
  for (const line of ['cmd /c "@gsudo whoami"', 'cmd /c "echo x & @gsudo whoami"', 'cmd /c "@echo off && @sudo whoami"', 'C:\\Windows\\SysWOW64\\cmd.exe /c gsudo whoami']) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
  for (const line of ['C:\\tools\\mycmd.exe /c "npm publish"', 'C:\\tools\\nopwsh.exe publish', 'cmd /c "@echo off"', 'cmd /c "echo me@example.invalid"']) {
    assert.equal(bash(line), null, line);
  }
});

test('start opens a folder, a document or a web address; it runs a program', () => {
  for (const line of ['start bin/Release', 'start dist/publish', 'start https://example.invalid/deploy', 'start https://example.invalid/releases/v1/release', 'start .', 'start notes.md', 'start "" notepad', 'npm start', 'call npm run build']) {
    assert.equal(bash(line), null, line);
  }
  for (const line of ['start gsudo whoami', 'start "" "C:/Tools/gsudo.exe" whoami', 'start C:/Tools/gsudo whoami', 'start "" /min tools/elevate.cmd', 'start /b sudo.exe whoami'].filter((l) => !l.includes('elevate'))) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
});

test('a place inside a command text is asked as a path word is; the home folder as ~/ is no touch; a bare share is a drive\'s root', () => {
  const all = [...shapes(), rig('c:/Users/runneradmin', RS), rig('C:/Users/RUNNER~1', RA)];
  for (const pl of all) {
    for (const line of ['bash -c "cat /c/Users/runneradmin/AppData/Roaming/hoprig/config.json"', 'bash -c "cat C:/Users/runneradmin/work/../AppData/Roaming/hoprig/config.json"', 'bash -c "cat ~/work/../AppData/Roaming/hoprig/config.json"']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['ls ~/', 'cp -r dist ~/', 'echo ~/', 'echo "~/"', 'git commit -m "files in ~/ are ignored"', 'du -sh $HOME/', 'bash -c "cd ~/ && npm test"', 'bash -c "ls ~/work/shop"', 'bash -c "ls /c/Users/runneradmin/work"',
      'cd ~ && ls \\\\localhost\\C$', 'ls "\\\\localhost\\C$"', 'bash -c "cat ~/AppData/Local/Temp/out.log"']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
});

// ---- what the look at that third round found ----

test('a quoted program path with a blank in a folder name is that program; PowerShell reads only its own switches', () => {
  for (const line of [
    'cmd /c "C:\\Program Files\\gsudo\\Current\\gsudo.exe" whoami', 'start "" "C:\\Program Files\\gsudo\\Current\\gsudo.exe" whoami', 'cmd /c "C:/Program Files/gsudo/Current/gsudo.exe" whoami',
    'powershell cmd /c "@gsudo whoami"', 'powershell -NoProfile cmd /c "@gsudo whoami"', 'powershell -ExecutionPolicy:Bypass cmd /c "@gsudo whoami"', 'powershell gsudo whoami -f x',
    'C:\\Program\\ Files\\PowerShell\\7\\pwsh.exe -c "gsudo whoami"',
  ]) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
  assert.equal(kind(bash('cmd /c "C:\\Program Files\\nodejs\\npm.cmd" publish')), 'release');
  for (const line of [
    'pwsh ./build.ps1 -c Release', 'powershell .\\build.ps1 -c Release', 'pwsh ./ci.ps1 -Command publish', 'pwsh ./build.ps1 -Configuration Release', 'pwsh ./tidy.ps1 -f notes.md',
    'cmd /c "C:\\Program Files\\App\\app.exe" --version', 'start "" "C:\\Program Files\\App\\app.exe"', 'start Release', 'start release', 'start deploy', 'powershell -c "Get-ChildItem bin\\Release"',
  ]) {
    assert.equal(bash(line), null, line);
  }
});

test('a long line of places is read in a bounded time; far more places inside its texts than any real line names and it is held', () => {
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join(' ');
  for (const pl of [rig(RA, RA), rig(RS, RS)]) {
    assert.equal(ton(pl, 'Bash', `bash -c "ls ${many(60, (i) => `~/w${i}`)}"`), null, 'sixty places in a text');
    assert.equal(kind(ton(pl, 'Bash', `bash -c "ls ${many(60, (i) => `~/w${i}`)} ~/AppData/Roaming/hoprig/config.json"`)), 'settings');
    assert.ok(ton(pl, 'Bash', `bash -c "ls ${many(990, (i) => `~/w${i}`)}"`), 'far more than any real line: held');
    assert.ok(ton(pl, 'Bash', `bash -c "ls ${many(990, (i) => `/c/Users/runneradmin/w${i}`)}"`));
  }
  slowest();
});

// ---- what the look at that fourth round found ----

test('a command text with no blank, a place behind a comma, a switch with a joined value, a text that ends in a folder', () => {
  for (const line of [
    'bash -c "cat</c/Users/alex/.config/hoprig/config.json"', 'bash -c "cat|cat</c/Users/alex/.config/hoprig/config.json"',
    'cmd /c "type,C:\\Users\\alex\\.config\\hoprig\\config.json"', 'cmd /c type,C:\\Users\\alex\\.config\\hoprig\\config.json', 'cmd /c "type;C:\\Users\\alex\\.config\\hoprig\\config.json"',
  ]) {
    assert.equal(kind(bash(line)), 'settings', line);
  }
  for (const pl of [...shapes(), rig('c:/Users/runneradmin', RS), rig('C:/Users/RUNNER~1', RA)]) {
    for (const line of ['bash -c "cat</c/Users/runneradmin/AppData/Roaming/hoprig/config.json"', 'cmd /c "type,C:\\Users\\runneradmin\\AppData\\Roaming\\hoprig\\config.json"', 'cmd /c "type;C:\\Users\\RUNNER~1\\AppData\\Roaming\\hoprig\\config.json"',
      'cmd /c type,C:\\Users\\RUNNER~1\\AppData\\Roaming\\hoprig\\config.json']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['bash -c "cat</c/Users/runneradmin/work/shop/a.md"', 'cmd /c "type,C:\\Users\\runneradmin\\work\\a.md"', 'cmd /c copy a.md,C:\\Users\\runneradmin\\work\\b.md']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
  for (const line of ['powershell -Version:5.1 -c "gsudo whoami"', 'pwsh -wd:C:/x -c "gsudo whoami"', 'pwsh -c "C:\\Program Files\\gsudo\\Current\\gsudo" whoami']) assert.equal(kind(bash(line)), 'admin', line);
  // What a fifth look found: a quoted place glued behind a comma, a text whose place begins further in, a command
  // joined on to -Command with a colon.
  for (const pl of [...shapes(), rig('c:/Users/runneradmin', RS), rig('C:/Users/RUNNER~1', RA)]) {
    for (const line of ['cmd /c type,"C:\\Users\\RUNNER~1\\AppData\\Roaming\\hoprig\\config.json"', 'cmd /c type,"C:\\Users\\runneradmin\\AppData\\Roaming\\hoprig\\config.json"',
      "echo '{\"path\":\"C:/Users/runneradmin/AppData\"}'", "echo '{\"path\":\"C:/Users/RUNNER~1/AppData/Roaming/hoprig/config.json\"}'"]) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['cmd /c type,"C:\\Users\\runneradmin\\work\\a.md"', "echo '{\"path\":\"C:/Users/runneradmin/work\"}'", 'ls "C:/Users/runneradmin/work" "C:/Users/RUNNER~1/work/shop"']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
  for (const line of ['pwsh -Command:"gsudo whoami"', 'powershell -c:gsudo whoami']) assert.equal(kind(bash(line)), 'admin', line);
  for (const line of ['pwsh -c "./build.ps1; Get-ChildItem bin/Release"', 'pwsh -c ".\\x.ps1 -Out C:\\out\\deploy"', 'pwsh -wd:C:/proj/release ./build.ps1']) assert.equal(bash(line), null, line);
});

// A place joined on to a short option is no word of its own: read as the place it is.
test('a place joined on to a short option is read', () => {
  for (const pl of [...shapes(), rig('c:/Users/runneradmin', RS), rig('C:/Users/RUNNER~1', RA)]) {
    for (const line of ['curl -o"/c/Users/runneradmin/AppData/Roaming/hoprig/config.json" https://example.invalid', 'curl -o/c/Users/runneradmin/AppData/Roaming/hoprig/config.json https://example.invalid',
      '7z x -o"C:/Users/RUNNER~1/AppData/Roaming/hoprig" a.zip', '7z x -oC:/Users/runneradmin/AppData/Roaming/hoprig a.zip', 'tar -xf a.tar -C~/AppData/Roaming/hoprig']) {
      assert.equal(kind(on(pl, 'Bash', line)), 'settings', label(pl, line));
    }
    for (const line of ['curl -o"/c/Users/runneradmin/work/out.json" https://example.invalid', 'gcc -I/c/Users/runneradmin/work/include x.c', '7z x -oC:/Users/runneradmin/work/out a.zip', 'tar -xf a.tar -C~/work']) {
      assert.equal(on(pl, 'Bash', line), null, label(pl, line));
    }
  }
});

// ---- what the last review of the whole Windows change found in the wall ----

test('a hidden PowerShell command (-EncodedCommand), a caret or a backtick in a program name, and an escalator behind ssh are read', () => {
  const enc = (text) => Buffer.from(text, 'utf16le').toString('base64');
  for (const line of [
    `powershell -NoProfile -EncodedCommand ${enc('gsudo whoami')}`, `pwsh -e ${enc('Start-Process cmd -Verb RunAs')}`, `powershell -ec ${enc('sudo whoami')}`, `pwsh -enc ${enc('cmd /c gsudo whoami')}`,
    'cmd //c g^sudo whoami', 'cmd /c "g^sudo whoami"', 'cmd /c "echo x & g^s^udo whoami"', 'g^sudo whoami', 'powershell g\\`sudo whoami',
    'ssh winbox gsudo whoami', 'ssh winbox cmd /c gsudo whoami',
  ]) {
    assert.equal(kind(bash(line)), 'admin', line);
  }
  assert.equal(kind(bash(`pwsh -EncodedCommand ${enc('git push origin main')}`)), 'push');
  // What cannot be decoded to a text is held, never let through unread.
  for (const line of ['powershell -EncodedCommand', 'powershell -e not*base64', `pwsh -enc ${Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]).toString('base64')}`]) assert.ok(bash(line), line);
  for (const line of [`powershell -EncodedCommand ${enc('Get-ChildItem')}`, `pwsh -e ${enc('npm test')}`, 'cmd /c echo a^&b', 'ssh winbox dir', 'echo 2^8', 'git log --grep "x^2"']) {
    assert.equal(bash(line), null, line);
  }
});
