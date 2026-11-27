#!/usr/bin/env node
// Dev-only: the chat box's buttons and chips, and New session's Worktree switch, in a real browser (a copy of the
// App chat drive's setup with scenes of its own). The App chat's states in a real browser, as pictures to look at. It runs
// `hoprig demo` from a copy of this tree in a temp folder, with the demo's coding-tool stand-in wrapped by
// tools/app-chat-standin.mjs (scenes with background tasks and a turn that keeps running), and the local Chrome.
//
//   TMPDIR=/tmp node tools/app-chat-drive.mjs [--port 7905] [--out <folder>] [--theme light|dark] [--width 1440]
//
// Sessions it makes: shop-frontend (the demo's story, waiting for an OK), api-server (a turn that runs, with four
// background tasks, then one and two messages queued behind it), docs-site (the turn over, four tasks still running in
// the background), mobile-app (a turn that finished). Pictures: Home, each chat, the queue, the list hidden where
// the page has a way to hide it, and the Background tasks sheet. It prints what the page says in each state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(opt('--port', '7905'));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'app-chat-drive')));
const THEME = opt('--theme', 'light');
const W = Number(opt('--width', '1440'));
const H = W < 600 ? 844 : 900;
const MOBILE = W < 600;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The drive's own copy of the tree: the demo's stand-in becomes chat-real.mjs, the wrapper takes its place.
const TREE = fs.mkdtempSync(path.join(os.tmpdir(), 'app-drive-tree-'));
for (const part of fs.readdirSync(ROOT)) {
  if (['node_modules', '.git', 'site', 'docs', 'test'].includes(part)) continue;
  fs.cpSync(path.join(ROOT, part), path.join(TREE, part), { recursive: true });
}
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(TREE, 'node_modules'));
fs.renameSync(path.join(TREE, 'src/demo/chat.mjs'), path.join(TREE, 'src/demo/chat-real.mjs'));
fs.copyFileSync(path.join(ROOT, 'tools/app-chat-standin.mjs'), path.join(TREE, 'src/demo/chat.mjs'));

const chrome = await launchChrome({ realHome: true });
const { main } = await import(path.join(TREE, 'src/demo/index.mjs'));
const hooks = { onReady: (i) => (hooks.info = i) };
if ((await main(['--no-open', '--quiet', '--port', String(PORT)], hooks)) !== null) throw new Error('the demo did not start');
await hooks.background;
const { url } = hooks.info;
const stopAll = async () => {
  await chrome.close().catch(() => {});
  await hooks.stop();
  fs.rmSync(TREE, { recursive: true, force: true });
};
setTimeout(async () => {
  console.error('app-chat-drive: still running after 6 minutes; stopping');
  await stopAll();
  process.exit(1);
}, 6 * 60_000).unref();

const J = JSON.stringify;
const ev = (e) => chrome.evaluate(e);
const post = (p, body) => ev(`fetch(${J(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${J(J(body))} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
const get = (p) => ev(`fetch(${J(p)}).then((r) => r.json())`);
async function waitFor(expr, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}
let loads = 0;
async function view(hash, wait = 2500) {
  await chrome.viewport(W, H, { mobile: MOBILE, theme: THEME });
  await chrome.goto(`${url}/?drive=${++loads}${hash}`, wait);
}
const tag = `${THEME}-${W}`;
async function shot(name) {
  const f = path.join(OUT, `${name}-${tag}.png`);
  fs.writeFileSync(f, await chrome.shot());
  console.log(`picture ${f}`);
}

try {
  await chrome.viewport(W, H, { mobile: MOBILE, theme: THEME });
  await chrome.goto(hooks.info.link, 2500);
  const chats = (await get('api/chats')).chats || [];
  const story = chats[0];
  const projects = path.dirname(story.cwd);
  const r = await post('api/chats', { dir: path.join(projects, 'api-server'), text: 'drive: running' });
  const running = r.body.id;
  await sleep(3000);
  const box = `document.querySelector('textarea.chat-input')`;
  const type = (t) => ev(`(() => { const t = ${box}; t.value = ${J(t)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const vis = (sel) => `(() => { const e = document.querySelector(${J(sel)}); return !!e && !e.classList.contains('hidden') && e.getClientRects().length > 0; })()`;
  const report = async (name) => console.log(`${name}: stop ${await ev(vis('.chat-stop'))}, send ${await ev(vis('.chat-send'))}, send title ${J(await ev(`document.querySelector('.chat-send').title`))}`);
  await view(`#/chat/${running}`, 3000);
  await ev(`${box}.focus()`);
  await shot('c1-running-empty-box');
  await report('empty box, turn runs');
  // The stand-in reports no context: show the ring as it reads once it does, to see the row's widest state.
  await ev(`(() => { const r = document.querySelector('.chat-ring'); r.classList.remove('hidden'); r.querySelector('.chat-ring-text').textContent = 'Context 10%'; })()`);
  await sleep(200);
  const geo = await ev(`(() => { const c = document.querySelector('.chat-composer').getBoundingClientRect(); const b = document.querySelector('.chat-stop').getBoundingClientRect(); const ch = document.querySelector('.chat-chips'); const last = ch.lastElementChild.getBoundingClientRect(); const cr = ch.getBoundingClientRect(); return { composerRight: c.right, stopRight: b.right, chipsRight: cr.right, lastChipRight: last.right, chipsScrollW: ch.scrollWidth, chipsClientW: ch.clientWidth, wrap: getComputedStyle(ch).flexWrap }; })()`);
  console.log(`geometry: ${J(geo)}`);
  await type('a message to queue');
  await sleep(300);
  await shot('c2-running-with-text');
  await report('text in box, turn runs');
  await ev(`${box}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(800);
  console.log(`after Esc with text: status ${J(await ev(`document.querySelector('.chat-status').innerText.replace(/\\s+/g, ' ')`))}`);
  await type('');
  // The path event: "Attach as context".
  await ev(`document.dispatchEvent(new CustomEvent('chat-attach-path', { detail: { path: 'src/cart.js' } }))`);
  await sleep(300);
  console.log(`attach: box ${J(await ev(`${box}.value`))}`);
  await shot('c3-attached');
  // New session's options: the Worktree switch.
  await view('#/new', 2500);
  await ev(`(() => { for (const d of document.querySelectorAll('details')) d.open = true; })()`);
  await sleep(500);
  await ev(`(() => { const i = document.querySelector('[data-key="worktree"]'); if (i) i.scrollIntoView({ block: 'center' }); })()`);
  await sleep(300);
  await shot('c4-new-options');
  console.log(`worktree switch: ${J(await ev(`(() => { const i = document.querySelector('[data-key="worktree"]'); return i ? { checked: i.checked, text: i.closest('.ns-worktree').innerText.replace(/\\s+/g, ' ') } : null; })()`))}`);
  const errs = chrome.errors.filter((e) => !/Failed to load resource|net::ERR_ABORTED/.test(e));
  console.log(`page errors: ${errs.length ? errs.slice(0, 5).join(' | ') : 'none'}`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
await stopAll();
process.exit(process.exitCode || 0);
