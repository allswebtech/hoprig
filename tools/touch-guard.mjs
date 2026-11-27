// Touch guard: on a phone (393 by 852, touch) every control of every page is at least 44 by 44. Opens the built-in demo
// of this tree, visits the pages of the menu, the bar, their tabs and Settings, and lists each visible button, link
// that is a control, switch, tab and field that is smaller. Exit 1 when there is one. The terminal's own screen
// helpers (xterm's hidden input) are not controls.
//   node tools/touch-guard.mjs [--port 7960] [--shots <folder>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const PORT = arg('--port', '7960');
const SHOTS = arg('--shots', null);
const MIN = 44;
const PAGES = [
  '#/', '#/work', '#/work/plans', '#/work/schedules', '#/work/activity', '#/workspace', '#/skills', '#/brain', '#/providers', '#/computers',
  '#/computers/add', '#/computer', '#/computer/setup', '#/computer/advanced', '#/settings', '#/settings/new-sessions', '#/settings/notifications',
  '#/settings/appearance', '#/settings/security', '#/settings/tia', '#/settings/automations', '#/settings/updates', '#/tia',
];

const { main } = await import(path.join(ROOT, 'src/demo/index.mjs'));
const hooks = { onReady: (i) => (hooks.info = i) };
if ((await main(['--no-open', '--quiet', '--port', PORT], hooks)) !== null) throw new Error('the demo did not start');
await hooks.background;
const chrome = await launchChrome({});
setTimeout(() => process.exit(2), 280_000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SMALL = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.right > 0 && r.left < innerWidth; };
  const lab = (e) => String(e.getAttribute('aria-label') || e.title || e.innerText || e.value || e.placeholder || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 40);
  const controls = [...document.querySelectorAll('button, a[href], select, input:not([type=hidden]), summary, textarea, [role=tab], [role=button]')]
    .filter((e) => vis(e) && !e.closest('dialog:not([open])') && !e.closest('.xterm') && !e.classList.contains('hidden') && !/xterm-helper/.test(e.className));
  return controls.filter((e) => { const r = e.getBoundingClientRect(); return r.height < ${MIN} - 0.5 || r.width < ${MIN} - 0.5; })
    .map((e) => { const r = e.getBoundingClientRect(); return e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : '') + ' "' + lab(e) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height); });
})()`;
let bad = 0;
try {
  await chrome.viewport(393, 852, { mobile: true, theme: 'light', touch: true });
  await chrome.goto(hooks.info.link, 2500);
  let n = 0;
  for (const hash of PAGES) {
    await chrome.goto(`${hooks.info.url}/?g=${++n}${hash}`, 2200);
    const small = await chrome.evaluate(SMALL);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, `touch-${hash.replace(/[^a-z0-9]+/gi, '_')}.png`), await chrome.shot());
    }
    console.log(`${small.length ? 'SMALL' : 'ok   '} ${hash}${small.length ? `: ${small.join('; ')}` : ''}`);
    bad += small.length;
  }
} finally {
  await chrome.close().catch(() => {});
  await hooks.stop();
}
console.log(bad ? `${bad} control(s) under ${MIN} by ${MIN}` : `every control is at least ${MIN} by ${MIN}`);
process.exit(bad ? 1 : 0);
