// The floor of "Allow everything" on Windows (wall.mjs wipesWhole): the same removal of a whole home, workspace,
// projects folder or disk is held when the shell is Git Bash (rm), PowerShell or cmd. The places are Windows-shaped and
// read with Windows' rules, so these run on every system (places.platform).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { wipesWhole } = await import('../src/wall.mjs');

const home = 'C:\\Users\\alex';
const ws = `${home}\\Workspace`;
const projects = `${ws}\\projects`;
const shop = `${projects}\\shop`;
const places = (cwd = shop) => ({ platform: 'win32', cwd, home, workspace: ws, projects: [projects], hoprig: [], own: shop, relative: true });
const hit = (command, cwd) => wipesWhole({ command, places: places(cwd) });

test('Windows: a removal of a whole home, workspace, projects folder or drive is a hit, in every spelling', () => {
  for (const [c, want] of [
    ['rm -rf ~', 'home'], ['rm -rf $HOME', 'home'], ['rm -rf C:/Users/alex', 'home'], ['rm -rf /c/Users/alex', 'home'], ['rm -rf c:/users/ALEX/', 'home'],
    ['rm -rf "C:\\Users\\alex"', 'home'], ['rm -rf C:\\Users\\alex', 'home'], ['rm -rf C:\\Users\\alex\\*', 'home'], ['rm -rf $USERPROFILE', 'home'],
    ['rm -rf /c/Users', 'home'], ['rm -rf C:\\Users\\', 'home'],
    ['Remove-Item -Recurse -Force C:\\Users\\alex', 'home'], ['Remove-Item -Recurse -Force -Path C:\\Users\\alex', 'home'], ['Remove-Item -Path:C:\\Users\\alex -Recurse', 'home'],
    ['Remove-Item -Recurse -Force $env:USERPROFILE', 'home'], ['ri -r -fo %USERPROFILE%', 'home'], ['rd /s /q C:\\Users\\alex', 'home'], ['rmdir /S /Q "C:\\Users\\alex"', 'home'],
    ['rd /s /q %USERPROFILE%\\Workspace', 'workspace'], ['del /s /q C:\\Users\\alex\\Workspace\\projects', 'projects'],
    ['rm -rf ~/Workspace', 'workspace'], ['rm -rf C:\\Users\\alex\\Workspace\\projects\\*', 'projects'],
    ['rm -rf /', 'disk'], ['rm -rf /*', 'disk'], ['rm -rf C:\\', 'disk'], ['rm -rf C:/', 'disk'], ['rm -rf /c', 'disk'], ['rm -rf /c/', 'disk'], ['rm -rf D:\\', 'disk'],
    ['rm -rf C:\\*', 'disk'], ['Remove-Item -Recurse -Force C:\\', 'disk'], ['rd /s /q D:\\', 'disk'], ['rm -rf "\\\\?\\C:\\Users\\alex"', 'home'],
    ['ls && rm -rf ~', 'home'], ['cd C:\\Users\\alex\\Workspace && rm -rf projects', 'projects'], ['cd /c/Users/alex && rm -rf .', 'home'],
  ]) assert.equal(hit(c), want, c);
  assert.equal(hit('rm -rf ..', shop), 'projects');
  assert.equal(hit('rm -rf *', projects), 'projects');
  assert.equal(hit('rd /s /q ..', shop), 'projects');
});

test('Windows: everything else is not a hit', () => {
  for (const c of [
    'rm -rf node_modules', 'rm -rf dist', 'rm -rf C:\\Users\\alex\\Workspace\\projects\\shop\\dist', 'rm -rf C:/Users/alex/.cache/x', 'rm -rf ~/.cache/x',
    'Remove-Item -Recurse -Force dist', 'rd /s /q build', 'del /q C:\\Users\\alex\\notes.txt', 'rm -rf C:\\Users\\bob', 'rm -rf C:\\Users\\alex2', 'rm -rf C:\\Temp\\x',
    'rm -rf "$DIR"', 'echo rm -rf C:\\', 'dir C:\\', 'git rm -r C:/Users/alex', 'rm -rf', 'rm -rf %UNKNOWN%',
  ]) assert.equal(hit(c), null, c);
  assert.equal(hit('rm -rf *', shop), null);
  assert.equal(hit('rm -rf ..', null), null);
});
