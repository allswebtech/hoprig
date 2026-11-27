#!/usr/bin/env node
// Dev-only (not in the published package): the title bar's Terminal pane, Fork, rename in place and the new keys in a real browser; the head below is the first drive's: the App chat's states in a real browser, as pictures to look at. It runs
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
/** What the chat page says: the status line, the strip, the queue, the rail's tasks, the sidebar's rows. */
const says = (name) => ev(`(() => { const t = (s) => [...document.querySelectorAll(s)].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
  return { status: t('.chat-status'), strip: t('.chat-bg'), queue: t('.chat-queued'), rail: t('.chat-bg-row'), side: t('.chat-side .chat-side-row, .chat-sidebar li').slice(0, 12), head: t('.chat-head, .chat-titlebar').slice(0, 2), home: t('.group-head, .sess-card .pill, .groupHead').slice(0, 20) }; })()`)
  .then((r) => console.log(`says ${name}: ${J(r)}`));

try {
  await chrome.viewport(W, H, { mobile: MOBILE, theme: THEME });
  await chrome.goto(hooks.info.link, 2500);
  const chats = (await get('api/chats')).chats || [];
  const story = chats[0];
  if (!story) throw new Error('the demo has no chat');
  const id = (await post('api/chats', { dir: path.join(path.dirname(story.cwd), 'api-server'), text: 'Hello, what does this app do?' })).body.id;
  await sleep(4000);
  const click = (sel) => ev(`(() => { const b = document.querySelector(${J(sel)}); if (b) b.click(); return !!b; })()`);
  const key = (init) => ev(`document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${J(init)})))`);
  await view(`#/chat/${id}`, 3500);
  await shot('20-chat-bar');
  console.log(`bar buttons: ${J(await ev(`[...document.querySelectorAll('.chat-tbtn')].map((b) => b.title)`))}`);
  // Terminal: the button opens the pane under the chat.
  if (!MOBILE) {
    await click('.chat-tbtn');
    await sleep(3500);
    await shot('21-terminal-open');
    const info = () => ev(`(() => { const p = document.querySelector('.chat-termpane'); const r = p.getBoundingClientRect(); const c = document.querySelector('.chat-col').getBoundingClientRect(); return { shown: !p.classList.contains('hidden'), frames: p.querySelectorAll('iframe').length, pane: [r.top, r.bottom, r.width], dockBottom: c.bottom, pressed: document.querySelector('.chat-tbtn').getAttribute('aria-pressed'), shell: (() => { try { return p.querySelector('iframe').contentDocument.body.innerText.slice(0, 200); } catch (e) { return String(e); } })() }; })()`);
    console.log(`terminal: ${J(await info())}`);
    await key({ key: '`', code: 'Backquote', ctrlKey: true });
    await sleep(500);
    console.log(`after Ctrl+backtick: ${J(await info())}`);
    await key({ key: '`', code: 'Backquote', ctrlKey: true });
    await sleep(1500);
    console.log(`after Ctrl+backtick again: ${J(await info())}`);
    await click('.chat-term-add');
    await sleep(3500);
    await shot('22-terminal-two-tabs');
    console.log(`tabs: ${J(await ev(`[...document.querySelectorAll('.chat-term-tab')].map((b) => b.innerText + ':' + b.getAttribute('aria-selected'))`))}`);
    await click('.chat-term-hide');
  }
  // The title edits in place.
  if (!MOBILE) {
    await click('.chat-title');
    await sleep(400);
    await shot('23-title-edit');
    console.log(`title input: ${J(await ev(`(() => { const i = document.querySelector('.chat-title-input'); return i ? { value: i.value, focused: document.activeElement === i } : null; })()`))}`);
    await ev(`(() => { const i = document.querySelector('.chat-title-input'); i.value = 'Renamed in place'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await sleep(1500);
    console.log(`title after Enter: ${J(await ev(`document.querySelector('.chat-title-text').innerText`))}; input gone: ${await ev(`!document.querySelector('.chat-title-input')`)}`);
    await click('.chat-title');
    await sleep(200);
    await ev(`(() => { const i = document.querySelector('.chat-title-input'); i.value = 'Never saved'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); })()`);
    await sleep(800);
    console.log(`title after Esc: ${J(await ev(`document.querySelector('.chat-title-text').innerText`))}`);
    // The session menu: Fork, Open in > Continue in Terminal.
    await click('.chat-caret');
    await sleep(500);
    await shot('24-session-menu');
    console.log(`menu: ${J(await ev(`[...document.querySelectorAll('[role=menuitem]')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`))}`);
    await ev(`(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find((e) => /^Open in/.test(e.innerText.trim())); if (b) b.click(); })()`);
    await sleep(500);
    await shot('25-open-in');
    await key({ key: 'Escape', code: 'Escape' });
    await key({ key: 'Escape', code: 'Escape' });
  }
  // Ctrl+Alt+N: the new-session screen; the sheet lists the keys.
  await key({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
  await sleep(800);
  await shot('26-new-session-key');
  console.log(`new session shown: ${await ev(`!!document.querySelector('dialog[open], .newsession, [data-newsession]')`)}`);
  await ev(`(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); })()`);
  await sleep(500);
  await key({ key: '/', code: 'Slash', ctrlKey: true });
  await sleep(600);
  await shot('27-shortcuts');
  const errs = chrome.errors.filter((e) => !/Failed to load resource|net::ERR_ABORTED/.test(e));
  console.log(`page errors: ${errs.length ? errs.slice(0, 5).join(' | ') : 'none'}`);
} catch (e) {
  console.error(`panes-head-drive: ${e.stack || e}`);
  process.exitCode = 1;
} finally {
  await stopAll();
}
process.exit(process.exitCode || 0);
