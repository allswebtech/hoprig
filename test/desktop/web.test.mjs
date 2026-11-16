// The desktop's page files follow the page's own rules (test/server/web.test.mjs reads the top folder of web/):
// DOM only through lib.js, every request through api(), plain modules that parse; and where it sits in the
// product: the "Desktop" page, the bare mode of the shell, Settings → Appearance, a computer's page.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const DESK = path.join(WEB, 'desktop');
const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const files = fs.readdirSync(DESK).filter((f) => f.endsWith('.js'));

test('the desktop files follow the page rules: DOM through lib.js, requests through api(), modules that parse', () => {
  assert.ok(files.length >= 6);
  for (const f of files) {
    const s = fs.readFileSync(path.join(DESK, f), 'utf8');
    assert.doesNotMatch(s, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\(|document\.write\(/, `${f}: no HTML from strings`);
    assert.doesNotMatch(s, /\.replaceChildren\(|\.append\(|\.appendChild\(/, `${f}: fill()/add() from lib.js`);
    assert.doesNotMatch(s, /fetch\(|new WebSocket\(/, `${f}: api()/wsUrl()`);
    const r = spawnSync(process.execPath, ['--check', path.join(DESK, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.ok(s.split('\n').length <= 420, `${f}: a small file`);
  }
  const css = fs.readFileSync(path.join(DESK, 'desktop.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of css.split('}').map((r) => r.split('{')[0].trim()).filter((x) => x && !x.startsWith('@'))) {
    for (const one of sel.split(',').map((x) => x.trim())) assert.doesNotMatch(one, /^\.(on|off|chosen|current|active|sel|selected)\b/, one);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from the tokens');
  assert.match(src('index.html'), /href="desktop\/desktop\.css"/);
  assert.match(src('app.js'), /import '\.\/desktop\/index\.js';/);
});

test('no other company\'s names or marks in the desktop: the styles are "Taskbar" and "Dock", the start button is our mark', () => {
  const all = files.map((f) => fs.readFileSync(path.join(DESK, f), 'utf8')).join('\n') + fs.readFileSync(path.join(DESK, 'desktop.css'), 'utf8');
  assert.doesNotMatch(all, /\b(windows ?(11|10|style)|mac ?os|macintosh|apple|microsoft|finder|explorer\.exe|aqua)\b/i);
  assert.match(all, /'Taskbar'/);
  assert.match(all, /'Dock'/);
  assert.match(src('desktop/bar.js'), /src: 'icon\.svg'/, 'the start button and launcher show the product\'s own mark');
});

test('where it sits: one page beside the dashboard, opened from a page head and a computer\'s page; no sidebar entry, no Start view', () => {
  const idx = src('desktop/index.js');
  assert.match(idx, /registerPage\(\{ id: 'desktop', title: 'Desktop', icon: 'monitor', perComputer: true, render: viewDesktop \}\)/, 'no navigation group');
  assert.match(idx, /registerHeadTool\(\(\) => h\('a\.icon-btn\.desk-headbtn', \{ href: link\('#\/desktop'\), title: 'Desktop mode'/);
  assert.match(src('desktop/desktop.css'), /@media \(max-width: 1023px\), \(max-height: 599px\) \{ \.desk-headbtn \{ display: none; \} \}/, 'wide screens only');
  assert.match(src('desktop/bar.js'), /desk-tray-btn\.desk-back', \{ type: 'button', title: 'Back to the dashboard'/, 'the way back in the tray');
  assert.match(idx, /WIDE = '\(min-width: 1024px\) and \(min-height: 600px\)'/);
  assert.match(idx, /prefs\.get\('desktop\.style', 'taskbar'\)/, 'Taskbar is the default style');
  for (const f of ['desktop/index.js', 'desktop/bar.js', 'settings.js']) assert.doesNotMatch(src(f), /desktop\.start|Start view|startView/, `${f}: no Start view`);
  assert.match(src('settings.js'), /lookPanel\(\), desktopSettings\(\)/);
  assert.match(src('pc.js'), /link\('#\/desktop'\).*'Open desktop'/);
});

test('bare mode: the shell, the trail, the store and Tia each have their part', () => {
  assert.match(src('lib.js'), /export const BARE = .*get\('bare'\) === '1'.*window\.parent !== window/);
  assert.match(src('lib.js'), /window\.parent\.location\.origin === location\.origin/, 'only a desktop of this same site is told anything');
  assert.match(src('lib.js'), /if \(!tellDesktop\(\{ type: 'hoprig:logged-out' \}\)\) location\.href = url\('\/login'\)/);
  const shell = src('shell.js');
  const bare = shell.slice(shell.indexOf('if (BARE) {'), shell.indexOf('const head = h('));
  assert.match(bare, /fill\(app, h\('div\.shell-main', h\(`main\.page/, 'the page alone: no sidebar, no bottom bar, no floating button');
  assert.doesNotMatch(bare, /registeredHeadTools|themeButton|switcher|go\('fab'\)/, 'no head icons, no switcher, no floating button');
  assert.match(src('trail.js'), /function save\(\) \{\n  if \(BARE\) return;/);
  assert.match(src('store.js'), /if \(host\) return host\.refresh\(\);/, 'a window polls nothing itself');
  assert.match(src('tia.js'), /!location\.pathname\.startsWith\('\/login'\) && !BARE\)/);
  // The desktop listens to its own windows only, from this same site.
  assert.match(src('desktop/wm.js'), /e\.origin !== location\.origin/);
  assert.match(src('desktop/wm.js'), /w\.frame\.contentWindow === e\.source/);
});
