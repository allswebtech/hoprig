#!/usr/bin/env node
// Dev-only (not in the published package): the pull request line, Create PR and a background task's output in a real
// browser, as pictures to look at. Like tools/app-chat-drive.mjs it runs `hoprig demo` from a copy of the tree, with
// tools/pr-tasks-standin.mjs in place of the demo's coding tool, plus a git folder with a remote and a stand-in `gh`.
//
//   TMPDIR=/tmp node tools/pr-tasks-drive.mjs [--port 7905] [--out <folder>] [--theme light|dark] [--width 1440]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(opt('--port', '7905'));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'pr-tasks-drive')));
const THEME = opt('--theme', 'light');
const W = Number(opt('--width', '1440'));
const H = W < 600 ? 844 : 900;
const MOBILE = W < 600;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TREE = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-drive-tree-'));
for (const part of fs.readdirSync(ROOT)) {
  if (['node_modules', '.git', 'site', 'docs', 'test'].includes(part)) continue;
  fs.cpSync(path.join(ROOT, part), path.join(TREE, part), { recursive: true });
}
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(TREE, 'node_modules'));
fs.renameSync(path.join(TREE, 'src/demo/chat.mjs'), path.join(TREE, 'src/demo/chat-real.mjs'));
fs.copyFileSync(path.join(ROOT, 'tools/pr-tasks-standin.mjs'), path.join(TREE, 'src/demo/chat.mjs'));

// A stand-in gh: `gh pr view` answers what the state file says (none: no pull request), `gh pr merge` writes a mark.
const BIN = path.join(TREE, 'gh-bin');
const STATE = path.join(TREE, 'gh-state.json');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then
  if [ -f "${STATE}" ]; then cat "${STATE}"; exit 0; fi
  echo 'no pull requests found for branch "main"' >&2; exit 1
fi
if [ "$1 $2" = "pr merge" ]; then echo "$@" > "${TREE}/merged"; exit 0; fi
exit 1
`, { mode: 0o755 });
const TASKS = path.join(TREE, 'proj', 'tasks');
fs.mkdirSync(TASKS, { recursive: true });
const TASK_FILE = path.join(TASKS, 'tk-sh.output');
fs.writeFileSync(TASK_FILE, ['> shop@1.0.0 dev', '> vite', '', '  VITE v5.2.0  ready in 412 ms', '', '  Local:   http://localhost:5173/', `  ${'A long line of output that a narrow sheet must wrap and never push out of its column. '.repeat(3)}`].join('\n') + '\n');

const chrome = await launchChrome({ realHome: true });
const { main } = await import(path.join(TREE, 'src/demo/index.mjs'));
const hooks = { onReady: (i) => (hooks.info = i) };
if ((await main(['--no-open', '--quiet', '--port', String(PORT)], hooks)) !== null) throw new Error('the demo did not start');
await hooks.background;
// The demo sets its own PATH (its own bin folder first): the stand-in gh goes in there.
fs.copyFileSync(path.join(BIN, 'gh'), path.join(process.env.PATH.split(path.delimiter)[0], 'gh'));
fs.chmodSync(path.join(process.env.PATH.split(path.delimiter)[0], 'gh'), 0o755);
const { url } = hooks.info;
const stopAll = async () => {
  await chrome.close().catch(() => {});
  await hooks.stop();
  fs.rmSync(TREE, { recursive: true, force: true });
};
setTimeout(async () => {
  console.error('pr-tasks-drive: still running after 5 minutes; stopping');
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
const click = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${J(sel)})].find((x) => !${J(text || '')} || x.innerText.includes(${J(text || '')})); return b ? (b.click(), true) : false; })()`);
const words = (sel) => ev(`[...document.querySelectorAll(${J(sel)})].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Drive', '-c', 'user.email=drive@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });

try {
  await chrome.viewport(W, H, { mobile: MOBILE, theme: THEME });
  await chrome.goto(hooks.info.link, 2500);
  const chats = (await get('api/chats')).chats || [];
  const projects = path.dirname(chats[0].cwd);
  // A git folder with a remote and two changed files.
  const repo = path.join(projects, 'refund-shop');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'feature-refunds');
  fs.writeFileSync(path.join(repo, 'cart.js'), 'export const total = (a) => a.reduce((s, x) => s + x, 0);\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', 'https://example.com/shop/refunds.git');
  fs.writeFileSync(path.join(repo, 'cart.js'), 'export const total = (a) => a.reduce((s, x) => s + x, 0) * 1.2;\n');
  fs.writeFileSync(path.join(repo, 'refund.js'), 'export const refund = (o) => o.paid;\n');
  const mk = async (dir, text) => (await post('api/chats', { dir, text })).body.id;
  const shop = await mk(repo, 'Hello, what is in this folder?');
  const tasks = await mk(path.join(projects, 'docs-site'), 'drive: tasks');
  await sleep(4000);

  // 1. Create PR: a remote, changes, no pull request yet.
  await view(`#/chat/${shop}`, 4000);
  console.log(`pr route: ${J(await get(`api/chats/${shop}/pr`))}`);
  console.log(`changes card: ${J(await words('.chat-rcard'))}`);
  await shot('20-create-pr');
  await click('.chat-rail-create');
  await sleep(1200);
  console.log(`after Create PR, the chat says: ${J((await words('.chat-user, .chat-msg-user, [data-role=user]')).slice(-1))}`);
  await shot('21-create-pr-sent');

  // 2. A pull request with failing checks, then its menu and the merge confirmation.
  fs.writeFileSync(STATE, J({ number: 12, title: 'Refunds: pay back the full order and mail the customer when it is done', url: 'https://example.com/shop/refunds/pull/12', state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }] }));
  await view(`#/chat/${shop}`, 4000);
  console.log(`changes card with a PR: ${J(await words('.chat-rcard'))}`);
  console.log(`Create PR with a PR: ${await ev(`document.querySelectorAll('.chat-rail-create').length`)}`);
  await shot('22-pr-line-failing');
  if (W >= 1100) {
    await click('.chat-rail-prtitle');
    await sleep(600);
    await shot('23-pr-menu');
    console.log(`menu: ${J(await words('dialog .choice'))}`);
    await click('dialog .choice', 'Merge when ready');
    await sleep(600);
    await shot('24-merge-confirm');
    await click('dialog button', 'Merge when ready');
    await sleep(1500);
    console.log(`merge toast: ${J(await words('.toast'))}; gh got: ${fs.existsSync(path.join(TREE, 'merged')) ? fs.readFileSync(path.join(TREE, 'merged'), 'utf8').trim() : 'nothing'}`);
    await shot('25-merged-toast');
  }
  fs.writeFileSync(STATE, J({ number: 12, title: 'Refunds', url: 'https://example.com/pull/12', state: 'OPEN', statusCheckRollup: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
  await view(`#/chat/${shop}`, 4000);
  await shot('26-pr-line-running');

  // 3. A background shell opened to its output, then the agent, with the file growing and Stop.
  await view(`#/chat/${tasks}`, 3500);
  await shot('30-tasks-part');
  await click('.chat-bg-title', 'npm run dev');
  await sleep(1200);
  await shot('31-task-output');
  console.log(`output sheet: ${J(await words('dialog .chat-task-out'))}; buttons: ${J(await words('dialog .chat-task-links button'))}`);
  fs.appendFileSync(TASK_FILE, '  press h + enter to show help\n');
  await sleep(4500);
  console.log(`output refreshed: ${J((await words('dialog .chat-task-out'))[0].slice(-40))}`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await ev(`document.querySelector('dialog[open]') && document.querySelector('dialog[open]').close()`);
  await sleep(400);
  await click('.chat-bg-title', 'Check the refund tests');
  await sleep(1000);
  await shot('32-agent-output');
  await ev(`document.querySelector('dialog[open]') && document.querySelector('dialog[open]').close()`);
  await click('.chat-bg-all');
  await sleep(800);
  await shot('33-tasks-sheet-with-output');
  const errs = chrome.errors.filter((e) => !/Failed to load resource|net::ERR_ABORTED/.test(e));
  console.log(`page errors: ${errs.length ? errs.slice(0, 5).join(' | ') : 'none'}`);
} catch (e) {
  console.error(`pr-tasks-drive: ${e.stack || e}`);
  process.exitCode = 1;
} finally {
  await stopAll();
}
process.exit(process.exitCode || 0);
