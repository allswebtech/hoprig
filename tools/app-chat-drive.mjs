#!/usr/bin/env node
// Dev-only (not in the published package): the App chat's states in a real browser, as pictures to look at. It runs
// `hoprig demo` from a copy of this tree in a temp folder, with the demo's coding-tool stand-in wrapped by
// tools/app-chat-standin.mjs (scenes with background tasks and a turn that keeps running), and the local Chrome.
//
//   TMPDIR=/tmp node tools/app-chat-drive.mjs [--port 7905] [--out <folder>] [--theme light|dark] [--width 1440]
//                                             [--no-guard | --only-guard]
//
// It also makes the checks (a message taken back, handed back for editing, Up, a task stopped, a task that ends, the
// turn's Stop) and the LAYOUT GUARD (tools/app-chat-guard.mjs): in every state it makes, at the widths 1440, 1200, 1024
// and 390, with the panel at the right shown and hidden, it looks for a page that scrolls sideways, a part outside its
// column or the window, two parts that lie over each other, text cut without a way to read it, and a picture that is
// not inside its button with a margin. A fault is a line "FAULT state | width | part | what | by Npx" with its picture;
// a fault or a failed check ends the drive with exit 1.
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
import { COLLECT, judge, line } from './app-chat-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(opt('--port', '7905'));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'app-chat-drive')));
const THEME = opt('--theme', 'light');
const W = Number(opt('--width', '1440'));
const H = Number(opt('--height', W < 600 ? 844 : 900));
const MOBILE = W < 600;
const PHONE = argv.includes('--phone') || argv.includes('--phone-only'); // --phone-only: the phone's pictures and checks, nothing else
const GUARD = !argv.includes('--no-guard') && !argv.includes('--phone-only');
const PICTURES = !argv.includes('--only-guard') && !argv.includes('--phone-only');
const ONLY = opt('--states', '').split(',').filter(Boolean); // the guard's states by name (default: all)
// A width is a number (the height follows it) or WxH; the phone views are 393x852 (an iPhone) and 393x450 (its keyboard open).
const VIEWS = opt('--widths', '1440,1200,1024,390,393x852,393x450').split(',').map((t) => { const [w, h] = t.split('x').map(Number); return { w, h: h || (w < 600 ? 844 : 900), name: h ? t : String(w) }; });
const failed = []; // the faults and the failed checks: the drive ends with 1 when there is one
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
  console.error('app-chat-drive: still running after 20 minutes; stopping');
  await stopAll();
  process.exit(1);
}, 20 * 60_000).unref(); // the whole run is long on a busy computer: split the guard by --states, side by side

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
  await chrome.viewport(W, H, { mobile: MOBILE, touch: MOBILE, theme: THEME });
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

const count = (sel) => ev(`[...document.querySelectorAll(${J(sel)})].filter((e) => e.getClientRects().length).length`);
const click = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${J(sel)})].find((x) => !${J(text || '')} || x.innerText.includes(${J(text || '')}) || (x.getAttribute('aria-label') || '').startsWith(${J(text || '')})); if (b) b.click(); return !!b; })()`);
const boxText = () => ev(`document.querySelector('textarea.chat-input, textarea') && document.querySelector('textarea.chat-input, textarea').value`);
/** A check: its name and whether it held; a failed one is a fault of the drive's exit. */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'check ok' : 'CHECK FAILED'}: ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed.push(name);
}
/** A new session in a folder of the demo's projects (made when it is not there), with a first message. */
async function made(projects, folder, text, branch) {
  const dir = path.join(projects, folder);
  fs.mkdirSync(dir, { recursive: true });
  if (branch) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  }
  const r = await post('api/chats', { dir, text });
  if (!r.body || !r.body.id) throw new Error(`no chat in ${folder}: ${J(r)}`);
  return r.body.id;
}
const queueOn = async (id, texts) => {
  for (const text of texts) await post(`api/chats/${id}/send`, { text });
  await sleep(1200);
};
const SHORT = ['Also check the refund e-mail template, please.', 'Then update the release notes.', 'And tell me when the tests pass.'];
const LONG = [
  Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ').slice(0, 600), // 600 characters with spaces
  'x'.repeat(300), // 300 characters without any space
];

async function checks(projects) {
  const id = await made(projects, 'checks', 'drive: running');
  await sleep(2500);
  await view(`#/chat/${id}`, 2500);
  await queueOn(id, SHORT);
  const q = () => count('.chat-queued');
  check('three queued messages show as three bubbles', (await q()) === 3, `${await q()}`);
  // Edit: the bubble leaves the queue, its words are in the box.
  await click('.chat-queued .chat-edit-queued');
  await sleep(1200);
  check('Edit hands the message back: the bubble leaves and its text is in the box', (await q()) === 2, `${await q()} left`);
  const first = await boxText();
  check('Edit puts the words in the box', SHORT.includes(String(first || '').trim()), J(first));
  // Remove: the bubble leaves, the box is not touched.
  await ev(`(() => { const t = document.querySelector('textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('.chat-queued .chat-unqueue');
  await sleep(1200);
  check('Remove takes the message back: the bubble leaves', (await q()) === 1, `${await q()} left`);
  // Up in the empty box: the last queued message comes back for editing.
  await ev(`(() => { const t = document.querySelector('textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); })()`);
  await sleep(1200);
  check('Up in the empty box takes the last message back into the box', (await q()) === 0 && SHORT.includes(String((await boxText()) || '').trim()), `${await q()} left, box ${J(await boxText())}`);
  await shot('12-after-edit-remove-up');
  // Stop of a task: open the part, press Stop of the first row; its row leaves.
  if ((await count('.chat-bg-row')) === 0) await click('.chat-bg-toggle');
  await sleep(500);
  const before = await count('.chat-bg-row');
  await click('.chat-bg-row [aria-label^="Stop"], .chat-bg-row [title^="Stop"]');
  await sleep(2500);
  const after = await count('.chat-bg-row');
  check('Stop of a task: its row leaves the Background tasks part', before === 4 && after === 3, `${before} rows, then ${after}`);
  // Stop of the turn: with words in the box the button place is Send (one place, never both), so the box is emptied first.
  await ev(`(() => { const t = document.querySelector('textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const stopShown = await count('.chat-stop');
  await click('.chat-stop');
  await sleep(2500);
  check('Stop ends the turn: the Stop button goes', stopShown > 0 && (await count('.chat-stop')) === 0, `shown ${stopShown}, then ${await count('.chat-stop')}`);
  // A task that ends by itself.
  const ending = await made(projects, 'ending', 'drive: ending');
  await sleep(1500);
  await view(`#/chat/${ending}`, 2000);
  if ((await count('.chat-bg-row')) === 0) await click('.chat-bg-toggle');
  const had = await count('.chat-bg-row');
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    await sleep(500);
    gone = (await count('.chat-bg-row')) === 0;
  }
  check('a task that ends leaves the Background tasks part', had === 1 && gone, `${had} row, gone ${gone}`);
}

/** The phone's own pictures and checks (--phone): a turn that runs under a long message, the box focused in the short
 *  view (the keyboard open), the chat ready. Run at 393x852 with --width 393 --height 852. */
async function phone(projects, story) {
  const long = 'Make the whole shop easier to use\n- fix every gap and issue you find\n- the dashboard and the admin: simpler, more complete, remove what is not needed\n- understand what we use it for and make it easier again\n\n\nAs fast as possible. And at the end merge into main, then I will deploy\n\n\nPlease finish it 100% complete';
  const run = await made(projects, 'phone-run', `drive: running\n${long}`);
  const idle = await made(projects, 'phone-ready', 'Hello, what does this app do?');
  await sleep(4000);
  const look = () => ev(`(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) }; };
    const chips = [...document.querySelectorAll('.chat-chips > *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().width > 8).map((e) => Math.round(e.getBoundingClientRect().top));
    return { vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth, vvScale: visualViewport && visualViewport.scale, vvLeft: visualViewport && visualViewport.offsetLeft,
      bar: r('.chat-bar'), list: r('.chat-scroll'), composer: r('.chat-composer'), chips: r('.chat-chips'), chipTops: [...new Set(chips)], status: r('.chat-status'), wrap: r('.chat-wrap'), dock: r('.chat-dock'),
      rewind: r('.chat-rewindbtn'), bubble: r('.chat-user'), placeholder: (document.querySelector('textarea.chat-input') || {}).placeholder, statusFs: parseFloat(getComputedStyle(document.querySelector('.chat-status')).fontSize),
      chipFs: parseFloat(getComputedStyle(document.querySelector('.chat-chip')).fontSize),
      fields: [...document.querySelectorAll('input, textarea, select')].filter((e) => e.getClientRects().length && !['checkbox', 'radio', 'file'].includes(e.type)).map((e) => parseFloat(getComputedStyle(e).fontSize)) }; })()`);
  for (const [name, id] of [['turn', run], ['ready', idle]]) {
    await view(`#/chat/${id}`, 3000);
    await shot(`p1-${name}`);
    const a = await look();
    console.log(`phone ${name}: ${J(a)}`);
    check(`phone ${name}: the page is not wider than the screen`, a.scrollW <= a.vw && a.bodyW <= a.vw, `${a.scrollW}/${a.bodyW} of ${a.vw}`);
    check(`phone ${name}: every field has a text size of 16 px or more`, a.fields.length > 0 && a.fields.every((f) => f >= 16), J(a.fields));
    check(`phone ${name}: the chips are in one row, inside the screen`, a.chipTops.length === 1 && a.chips.r <= a.vw, J(a.chipTops));
    check(`phone ${name}: the placeholder is one short line`, a.placeholder && a.placeholder.length < 50 && !/Esc/.test(a.placeholder), J(a.placeholder));
    check(`phone ${name}: the box is one line high (the placeholder does not wrap)`, a.composer.h <= 52, `${a.composer.h}px`);
    if (name === 'turn') check('phone turn: the placeholder says the message is read after its step', /after its step/.test(a.placeholder || ''), J(a.placeholder));
    if (a.rewind && a.bubble) check(`phone ${name}: Rewind to here is not beside the bubble`, a.rewind.y >= a.bubble.b - 2 && a.rewind.w < a.vw / 2, J([a.rewind, a.bubble]));
    check(`phone ${name}: the status text is not smaller than the chips text`, a.statusFs >= a.chipFs, `${a.statusFs}/${a.chipFs}`);
  }
  // The keyboard: the visible height shrinks (393x450), the box is focused.
  await chrome.viewport(W, 450, { mobile: true, touch: true, theme: THEME });
  await ev(`document.querySelector('textarea.chat-input').focus()`);
  await sleep(800);
  await shot('p2-focused-short');
  const k = await look();
  console.log(`phone keyboard: ${J(k)}`);
  check('phone keyboard: the page is not wider than the screen', k.scrollW <= k.vw && k.bodyW <= k.vw, `${k.scrollW}/${k.bodyW} of ${k.vw}`);
  check('phone keyboard: the title bar is at the top, the box above the bottom', k.bar && k.bar.y === 0 && k.composer && k.composer.b <= k.vh && k.chips.x >= 0 && k.chips.r <= k.vw, J([k.bar, k.composer]));
  check('phone keyboard: the conversation keeps room', k.list && k.list.h >= 80, J(k.list));
  await chrome.viewport(W, H, { mobile: true, touch: true, theme: THEME });
}

/** The layout guard: each state at each width, the panel shown and hidden. */
async function guard(projects, story) {
  const states = [];
  const add = (name, id, setup) => states.push({ name, hash: `#/chat/${id}`, setup });
  const openTasks = async () => {
    if ((await count('.chat-bg-row')) === 0) await click('.chat-bg-toggle');
    await sleep(300);
  };
  const t4 = await made(projects, 'g-tasks4', 'drive: running');
  const t1 = await made(projects, 'g-tasks1', 'drive: one');
  const t12 = await made(projects, 'g-tasks12', 'drive: twelve');
  const lq = await made(projects, 'g-queue-long', 'drive: running');
  const wide = await made(projects, 'g-wide', 'drive: wide', 'feature/' + 'branch-name-of-a-very-long-kind-'.repeat(4).slice(0, 111));
  const reply = await made(projects, 'g-reply-' + 'folder'.repeat(10), 'drive: reply', 'bugfix/' + 'refund-'.repeat(20).slice(0, 113));
  const bg = await made(projects, 'g-background', 'drive: background');
  await sleep(4000);
  await queueOn(lq, LONG);
  await queueOn(wide, LONG);
  add('home', '', null);
  add('needs-ok', story.chatId);
  add('tasks-4', t4, openTasks);
  add('tasks-1', t1, openTasks);
  add('tasks-12', t12, openTasks);
  add('queue-long', lq, openTasks);
  add('wide-task-and-queue', wide, openTasks);
  add('long-names-and-reply', reply);
  add('background-only', bg, openTasks);
  const t0 = Date.now();
  let looked = 0;
  for (const st of states.filter((x) => !ONLY.length || ONLY.includes(x.name))) {
    console.log(`guard state ${st.name} at ${Math.round((Date.now() - t0) / 1000)}s`);
    for (const { w, h, name } of VIEWS) {
      for (const rail of ['on', 'off']) {
        await chrome.viewport(w, h, { mobile: w < 600, touch: w < 600, theme: THEME });
        await ev(`localStorage.setItem('chat.rail', ${J(rail)})`).catch(() => {});
        await chrome.goto(`${url}/?guard=${++loads}${st.hash.startsWith('#/chat') ? st.hash : '#/'}`, 700);
        await waitFor(`document.querySelector('.chat-list, .chat-wrap, .group-head, main') !== null`, 4000);
        if (st.setup) await st.setup();
        await sleep(300);
        const got = await ev(COLLECT);
        const faults = judge(got.boxes, got.win);
        looked++;
        const label = `${st.name}${rail === 'off' ? ', panel hidden' : ''}`;
        if (faults.length || (argv.includes('--guard-shots') && rail === 'on')) {
          const f = path.join(OUT, `guard-${st.name}-${name}-${rail === 'off' ? 'nopanel' : 'panel'}-${THEME}.png`);
          fs.writeFileSync(f, await chrome.shot());
          for (const x of faults) {
            console.log(line(label, name, x));
            failed.push(`${label} ${w} ${x.part}`);
          }
          console.log(`picture ${f}`);
        }
      }
    }
  }
  console.log(`layout guard: ${looked} views (states x widths x panel shown and hidden), ${failed.length ? 'faults found' : 'clean'}`);
}

try {
  await chrome.viewport(W, H, { mobile: MOBILE, theme: THEME });
  await chrome.goto(hooks.info.link, 2500); // the one-time sign-in link
  const chats = (await get('api/chats')).chats || [];
  const story = chats[0];
  if (!story) throw new Error('the demo has no chat');
  const projects = path.dirname(story.cwd);
  const make = async (folder, text) => {
    const r = await post('api/chats', { dir: path.join(projects, folder), text });
    if (!r.body || !r.body.id) throw new Error(`no chat in ${folder}: ${J(r)}`);
    return r.body.id;
  };
  const running = await make('api-server', 'drive: running');
  const background = await make('docs-site', 'drive: background');
  const finished = await make('mobile-app', 'Hello, what does this app do?');
  await sleep(4000);

  if (PICTURES) {
  // Home first: the four sessions and their states.
  await view('#/', 3000);
  await shot('01-home');
  await says('home');

  // The story's chat: it waits for an OK.
  await view(`#/chat/${story.chatId}`, 3500);
  await shot('02-chat-needs-ok');
  await says('needs-ok');

  // A turn that runs with four background tasks; then one, then two messages queued behind it.
  await view(`#/chat/${running}`, 3000);
  await shot('03-running-tasks');
  await says('running');
  console.log(`send 1: ${J(await post(`api/chats/${running}/send`, { text: 'Also check the refund e-mail template, please.' }))}`);
  await sleep(1500);
  await shot('04-running-one-queued');
  await says('one-queued');
  console.log(`send 2: ${J(await post(`api/chats/${running}/send`, { text: 'And when the tests pass, write a short summary of what changed for the release notes. Keep it to five lines.' }))}`);
  await sleep(1500);
  await shot('05-running-two-queued');
  await says('two-queued');
  await shot('05b-queue-and-tasks');
  // The strip or the rail's tasks, opened: the Background tasks sheet.
  const opened = await ev(`(() => { const b = document.querySelector('.chat-bg-all'); if (b) { b.click(); return 'strip'; } return ''; })()`);
  if (opened) {
    await sleep(800);
    await shot('06-tasks-sheet');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  }

  // The turn is over, four tasks still run in the background (the owner's picture).
  await view(`#/chat/${background}`, 3000);
  await shot('07-background-turn-over');
  await says('background');

  // A turn that finished: in the chat, in the list, on Home.
  await view(`#/chat/${finished}`, 3000);
  await shot('08-finished');
  await says('finished');
  await view('#/', 3000);
  await shot('09-home-after');
  await says('home-after');

  // The session list hidden, where the page has a way to hide it (none: said, not pictured).
  const hide = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /hide (the )?(session list|sidebar)/i.test(x.getAttribute('aria-label') || x.title || x.innerText)); return b ? (b.click(), true) : false; })()`);
  console.log(`a control to hide the session list: ${hide ? 'yes' : 'none found on Home'}`);
  await view(`#/chat/${background}`, 3000);
  const hideChat = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /hide (the )?(session list|sidebar)/i.test(x.getAttribute('aria-label') || x.title || x.innerText)); return b ? (b.click(), true) : false; })()`);
  console.log(`a control to hide the session list in the chat: ${hideChat ? 'yes' : 'none'}`);
  if (hideChat) {
    await sleep(600);
    await shot('10-list-hidden');
    const side = () => ev(`!!document.querySelector('.chat-sidebar, .chat-side') && document.querySelector('.chat-sidebar, .chat-side').getBoundingClientRect().width > 0`);
    console.log(`list visible after hide: ${await side()}; saved: ${await ev(`localStorage.getItem('chat.side')`)}`);
    await view(`#/chat/${background}`, 2500);
    console.log(`list visible after reload: ${await side()}`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await sleep(500);
    console.log(`list visible after Ctrl+backslash: ${await side()}`);
    await shot('11-list-back-by-key');
  }
  const homeIcon = await ev(`!![...document.querySelectorAll('.chat-head a, .chat-head button, .chat-titlebar a, .chat-titlebar button, .chat-homebtn')].find((x) => /home/i.test(x.getAttribute('aria-label') || x.title || x.innerText))`);
  console.log(`a Home control at the top of the chat: ${homeIcon ? 'yes' : 'none'}`);
  }

  // The checks: what Edit, Remove, Up, a task's Stop, a task that ends and the turn's Stop do, in the browser.
  if (PICTURES) await checks(projects);
  if (PHONE) await phone(projects, story);
  if (GUARD) await guard(projects, story);
  if (failed.length) console.log(`${failed.length} fault${failed.length === 1 ? '' : 's'} or failed check${failed.length === 1 ? '' : 's'}`);
  const errs = chrome.errors.filter((e) => !/Failed to load resource|net::ERR_ABORTED/.test(e));
  console.log(`page errors: ${errs.length ? errs.slice(0, 5).join(' | ') : 'none'}`);
} catch (e) {
  console.error(`app-chat-drive: ${e.stack || e}`);
  process.exitCode = 1;
} finally {
  await stopAll();
}
process.exit(process.exitCode || (failed.length ? 1 : 0));
