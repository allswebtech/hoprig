#!/usr/bin/env node
// Dev-only (not in the published package): the App chat's reply, path and list states in a real browser, as pictures to
// look at: a reply with a link, italic, a code block and a path; a path button and its menu; Archive with Undo; the
// session list's rows; and, narrower than 900 px, the list over the chat. It runs the demo from a copy of this tree
// with the stand-ins of tools/app-chat-standin.mjs (long states) and its own scene ("drive: reply").
//
//   TMPDIR=/tmp node tools/app-chat-reply-drive.mjs [--port 7905] [--out <folder>] [--theme light|dark] [--width 1440]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(opt('--port', '7905'));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'app-chat-reply-drive')));
const THEME = opt('--theme', 'light');
const W = Number(opt('--width', '1440'));
const H = W < 600 ? 844 : 900;
const MOBILE = W < 600;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPLY_STANDIN = `
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const sessionId = val('--resume') || val('--session-id');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const real = spawn(process.execPath, [path.join(HERE, 'chat-real.mjs'), ...argv], { stdio: ['pipe', 'pipe', 'inherit'] });
readline.createInterface({ input: real.stdout }).on('line', (l) => process.stdout.write(l + '\\n'));
real.on('exit', (c) => process.exit(c ?? 0));
const usage = { input_tokens: 1200, cache_read_input_tokens: 18000, cache_creation_input_tokens: 0, output_tokens: 140 };
function say(content, id) {
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', content: [] } }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: 'assistant', message: { id, role: 'assistant', content, usage }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: null, session_id: sessionId });
}
function scene() {
  const file = path.join(process.cwd(), 'src', 'cart.js');
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'default', permissionMode: 'default', tools: ['Read'], slash_commands: [], skills: [] });
  out({ type: 'system', subtype: 'session_title_changed', title: 'Reply with a link and a path', session_id: sessionId });
  say([{ type: 'tool_use', id: 'toolu_rp1', name: 'Read', input: { file_path: file, offset: 12 } }], 'm1');
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_rp1', content: 'ok' }] }, session_id: sessionId });
  say([{ type: 'text', text: 'The bug is in \`src/cart.js:12\`, where each line is rounded first. See the *rounding rules* in [the docs](https://example.com/docs/rounding) or at https://example.com/help.\\n\\nRun this to check:\\n\\n\`\`\`sh\\nnpm test -- cart\\n\`\`\`\\n\\nThen read \`README.md\` and \`npm test\`. A very long line without spaces follows: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }], 'm2');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, total_cost_usd: 0.05, duration_ms: 9000, num_turns: 1, usage, modelUsage: { 'sample-model': { inputTokens: 1200, outputTokens: 140, costUSD: 0.05, contextWindow: 200000 } } });
}
let first = true;
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m = null;
  try { m = JSON.parse(l); } catch {}
  if (m && m.type === 'user') {
    const c = m.message && m.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : '';
    const was = first;
    first = false;
    if (was && /^drive: reply/.test(text)) return scene();
  }
  real.stdin.write(l + '\\n');
}).on('close', () => real.stdin.end());
`;

// The drive's own copy of the tree. Chain: this scene's wrapper → the long-state scenes' wrapper → the demo's stand-in.
const TREE = fs.mkdtempSync(path.join(os.tmpdir(), 'app-reply-tree-'));
for (const part of fs.readdirSync(ROOT)) {
  if (['node_modules', '.git', 'site', 'docs', 'test'].includes(part)) continue;
  fs.cpSync(path.join(ROOT, part), path.join(TREE, part), { recursive: true });
}
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(TREE, 'node_modules'));
fs.renameSync(path.join(TREE, 'src/demo/chat.mjs'), path.join(TREE, 'src/demo/chat-base.mjs'));
fs.writeFileSync(path.join(TREE, 'src/demo/chat-real.mjs'), fs.readFileSync(path.join(ROOT, 'tools/app-chat-standin.mjs'), 'utf8').replaceAll('chat-real.mjs', 'chat-base.mjs'));
fs.writeFileSync(path.join(TREE, 'src/demo/chat.mjs'), REPLY_STANDIN);

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
  console.error('app-chat-reply-drive: still running after 5 minutes; stopping');
  await stopAll();
  process.exit(1);
}, 5 * 60_000).unref();

const J = JSON.stringify;
const ev = (e) => chrome.evaluate(e);
const post = (p, body) => ev(`fetch(${J(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${J(J(body))} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
const get = (p) => ev(`fetch(${J(p)}).then((r) => r.json())`);
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
const say = (name, v) => console.log(`says ${name}: ${J(v)}`);
const q = (sel, fn = 'e.innerText.replace(/\\s+/g, " ").trim()') => ev(`[...document.querySelectorAll(${J(sel)})].map((e) => ${fn})`);
const rightClick = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.top + 6 })); return true; })()`);
const click = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); if (e) e.click(); return !!e; })()`);

try {
  await chrome.viewport(W, H, { mobile: MOBILE, theme: THEME });
  await chrome.goto(hooks.info.link, 2500);
  const chats = (await get('api/chats')).chats || [];
  const story = chats[0];
  const projects = path.dirname(story.cwd);
  const make = async (folder, text) => {
    const r = await post('api/chats', { dir: path.join(projects, folder), text });
    if (!r.body || !r.body.id) throw new Error(`no chat in ${folder}: ${J(r)}`);
    return r.body.id;
  };
  fs.mkdirSync(path.join(projects, 'api-server', 'src'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'api-server', 'src', 'cart.js'), '// cart\n'.repeat(20));
  const reply = await make('api-server', 'drive: reply');
  const background = await make('docs-site', 'drive: background');
  const finished = await make('mobile-app', 'Hello, what does this app do?');
  await sleep(4000);

  // 1. The reply: link, italic, code block with Copy, path button.
  await view(`#/chat/${reply}`, 3500);
  await shot('20-reply');
  say('reply', { links: await q('.chat-text a', 'e.href + " " + e.target + " " + e.rel'), em: await q('.chat-text em'), copyBtns: await q('.chat-codecopy', 'e.title + "/" + e.getAttribute("aria-label")'), replyCopy: await q('.chat-copyreply', 'e.getAttribute("aria-label")'), paths: await q('.chat-pathbtn', 'e.innerText + " | " + e.getAttribute("aria-label")'), code: await q('.chat-text code'),
    overflow: await ev(`(() => { const s = document.querySelector('.chat-scroll'); return s.scrollWidth - s.clientWidth; })()`) });
  // Hover over the reply: its Copy shows.
  await ev(`(() => { const e = document.querySelector('.chat-text'); e.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`);
  await click('.chat-codecopy');
  await sleep(500);
  say('after Copy', { toast: await q('.toast') });
  await shot('21-code-copied');
  // 2. The path button's menu (right-click), then a click.
  await rightClick('.chat-text .chat-pathbtn');
  await sleep(500);
  say('path menu', { items: await q('.desk-menu-item') });
  await shot('22-path-menu');
  await ev(`(() => { const b = [...document.querySelectorAll('.desk-menu-item')].find((x) => /^Open in/.test(x.innerText)); if (b) b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`);
  await sleep(300);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await click('.chat-text .chat-pathbtn');
  await sleep(2500);
  say('after path click', { hash: await ev('location.hash'), tab: await q('.tab, .ed-tab, [role=tab]').catch(() => []) });
  await shot('23-editor-opened');

  // 3. The list rows and a long state.
  await view(`#/chat/${background}`, 3000);
  await shot('24-list-rows');
  say('rows', { rows: await q('.chat-side .chat-side-row'), heights: await q('.chat-side .chat-side-row', 'Math.round(e.getBoundingClientRect().height)'), nameWidths: await q('.chat-side .chat-side-name', 'Math.round(e.getBoundingClientRect().width) + "/" + e.scrollWidth') });

  // 4. Archive from a row's menu: no question, a toast with Undo; the row leaves; Undo brings it back.
  if (W >= 900) {
    const rowOf = (id) => `.chat-side-row[href$="/chat/${id}"]`;
    await ev(`(() => { const a = document.querySelector('.chat-side-row[href$="/chat/${finished}"]'); a.parentNode.querySelector('.chat-side-more').click(); })()`);
    await sleep(400);
    say('row menu', { items: await q('.desk-menu-item') });
    await ev(`(() => { const b = [...document.querySelectorAll('.desk-menu-item')].find((x) => /^Archive/.test(x.innerText)); if (b) b.click(); })()`);
    await sleep(1500);
    say('after Archive', { rows: (await q('.chat-side .chat-side-row')).length, sheet: await q('dialog[open]'), toast: await q('.toast'), listed: await ev(`!!document.querySelector(${J(rowOf(finished))})`) });
    await shot('25-archived-toast');
    await ev(`(() => { const b = document.querySelector('.toast .toast-action'); if (b) b.click(); })()`);
    await sleep(2500);
    say('after Undo', { rows: (await q('.chat-side .chat-side-row')).length, listed: await ev(`!!document.querySelector(${J(rowOf(finished))})`) });
    await shot('26-undone');
    // Archive a working session: it asks first.
    await ev(`(() => { const a = document.querySelector('.chat-side-row[href$="/chat/${background}"]'); a.parentNode.querySelector('.chat-side-more').click(); })()`);
    await sleep(300);
    await ev(`(() => { const b = [...document.querySelectorAll('.desk-menu-item')].find((x) => /^Archive/.test(x.innerText)); if (b) b.click(); })()`);
    await sleep(800);
    say('archive of a working one', { sheet: await q('dialog[open]') });
    await shot('27-archive-working-asks');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  } else {
    // 5. Narrower than 900: the list's button opens it over the chat.
    const btn = '.chat-sidebtn';
    say('narrow before', { sidebtn: await ev(`!!document.querySelector(${J(btn)}) && document.querySelector(${J(btn)}).getClientRects().length > 0`), listShown: await ev(`document.querySelector('.chat-side').getClientRects().length > 0`) });
    await click(btn);
    await sleep(600);
    say('narrow open', { listShown: await ev(`document.querySelector('.chat-side').getClientRects().length > 0`), box: await ev(`(() => { const r = document.querySelector('.chat-side').getBoundingClientRect(); return [r.left, r.width, r.height]; })()`), label: await ev(`document.querySelector(${J(btn)}).getAttribute('aria-label')`) });
    await shot('28-list-over-chat');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(400);
    say('narrow Escape', { listShown: await ev(`document.querySelector('.chat-side').getClientRects().length > 0`) });
    await click(btn);
    await sleep(400);
    await click('.chat-side-scrim');
    await sleep(400);
    say('narrow scrim tap', { listShown: await ev(`document.querySelector('.chat-side').getClientRects().length > 0`) });
    await shot('29-list-closed');
  }
  const errs = chrome.errors.filter((e) => !/Failed to load resource|net::ERR_ABORTED/.test(e));
  console.log(`page errors: ${errs.length ? errs.slice(0, 5).join(' | ') : 'none'}`);
} catch (e) {
  console.error(`app-chat-reply-drive: ${e.stack || e}`);
  process.exitCode = 1;
} finally {
  await stopAll();
}
process.exit(process.exitCode || 0);
