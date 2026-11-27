#!/usr/bin/env node
// Dev-only (not in the published package): the first run as a newcomer meets it, written down as pictures, words and
// checks. It types the real install line of this system into a real terminal (node-pty; ConPTY on Windows), answers
// nothing (the first run asks nothing: a question that appears is counted and fails the check), checks that the window
// is still there afterwards, then opens the one-time link the installer printed in headless Chrome at 1280 by 800, light,
// and walks the card: Home, then (with a stand-in for a signed-in Claude Code) the first chat and its first answer.
// Run by .github/workflows/firstrun-look.yml.
//
//   node tools/firstrun-walk.mjs --tgz <hoprig-X.tgz> --out <folder> [--policy Restricted|RemoteSigned] [--leg normal|admin-stop|git-hidden]
//
// Legs (Windows only): normal = the installer as a person runs it (HOPRIG_ALLOW_ADMIN=1 only because a runner is an
// administrator and a person is not); admin-stop = no such variable: the installer must stop with its one line before it
// installs anything; git-hidden = Git is taken off PATH, so Git for Windows must be installed before Claude Code.
//
// It installs Hoprig, its service and Claude Code for the real user of the computer it runs on, so it runs only on a CI
// runner (GITHUB_ACTIONS and RUNNER_TEMP set) and refuses anywhere else.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pty from 'node-pty';
import { launchChrome } from './chrome.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
  console.error('firstrun-walk: runs only on a CI runner (it installs Hoprig, its service and Claude Code for this computer\'s user)');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const TGZ = opt('--tgz');
const OUT = path.resolve(opt('--out', path.join(process.env.RUNNER_TEMP, 'firstrun')));
const POLICY = opt('--policy', 'Restricted');
const LEG = opt('--leg', 'normal');
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const SCREENS = path.join(OUT, 'screens');
fs.mkdirSync(SCREENS, { recursive: true });
if (!TGZ || !fs.existsSync(TGZ)) throw new Error(`--tgz: no packed build at ${TGZ}`);
if (!['normal', 'admin-stop', 'git-hidden'].includes(LEG)) throw new Error(`--leg: ${LEG}`);

let chrome = null; // the page walk's browser (finish() reuses it for the terminal pictures)
const pageErrors = [];
const T0 = Date.now();
const secs = () => Math.round((Date.now() - T0) / 100) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = { system: `${os.type()} ${os.release()} ${os.arch()}`, policy: WIN ? POLICY : null, leg: LEG, steps: [], questions: [], checks: [], moments: [], pages: [] };
const note = (what, extra = {}) => {
  summary.steps.push({ at: secs(), what, ...extra });
  console.log(`FIRSTRUN ${secs()}s ${what}${extra.detail ? `: ${extra.detail}` : ''}`);
};
// A check is a claim of the design with its result; the job's summary lists them all, and the job fails on a failed one.
const check = (name, ok, detail = '') => {
  summary.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  note(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail ? { detail: String(detail).slice(0, 200) } : {});
  return !!ok;
};

// ---- the words: escape codes out, one-time links masked --------------------------------------------------------------
const mask = (s) => s.replace(/#link=[A-Za-z0-9_-]{43}/g, '#link=<one-time link, masked>');
const plain = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[@-Z\\-_]/g, '')
  .replace(/\r(?!\n)/g, '\n')
  .replace(/\r/g, '');

// ---- the install scripts, served as the real line fetches them ------------------------------------------------------
const server = http.createServer((req, res) => {
  const name = { '/install.ps1': 'install.ps1', '/install.sh': 'install.sh' }[req.url];
  if (!name) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(fs.readFileSync(path.join(ROOT, name)));
});
await new Promise((r) => server.listen(8099, '127.0.0.1', r));
// The line of each system as the README gives it, with the address of this run in place of GitHub's.
const LINE = WIN ? 'irm http://127.0.0.1:8099/install.ps1 | iex' : MAC ? 'curl -fsSL http://127.0.0.1:8099/install.sh | sh' : 'wget -qO- http://127.0.0.1:8099/install.sh | sh';

// ---- shims: what a person's computer has that a runner lacks, or the other way round -------------------------------------
const SHIMS = path.join(process.env.RUNNER_TEMP, 'firstrun-shims');
fs.mkdirSync(SHIMS, { recursive: true });
const OPENED = path.join(process.env.RUNNER_TEMP, 'firstrun-opened.txt');
if (!WIN) {
  // The opener the installer calls (open on macOS, xdg-open on Linux) writes the address it was given: no browser here.
  for (const name of MAC ? ['open'] : ['xdg-open']) {
    fs.writeFileSync(path.join(SHIMS, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${OPENED}'\n`, { mode: 0o755 });
  }
  // Apple's git before the Command Line Tools is a stub that opens a window and fails: nvm must not need it.
  if (MAC) fs.writeFileSync(path.join(SHIMS, 'git'), '#!/bin/sh\necho "xcode-select: note: no developer tools were found" >&2\nexit 1\n', { mode: 0o755 });
}

// ---- Windows: the saved PATH, as a new window of a person reads it ---------------------------------------------------------
// A window opened by the Explorer gets the PATH saved in the registry (all users, then the person's own). The runner's
// own process has a longer one (the tool cache), so this reads the saved one, and hides what a fresh PC does not have:
// Node.js always; Git too on the leg without Git (its folder is renamed, so winget has something to install).
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim();
const savedPath = () => ps("[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')");
if (WIN) {
  const drop = LEG === 'git-hidden' ? 'nodejs|\\\\Git\\\\' : 'nodejs';
  ps(`$m = [Environment]::GetEnvironmentVariable('Path','Machine') -split ';' | Where-Object { $_ -and $_ -notmatch '${drop}' }; [Environment]::SetEnvironmentVariable('Path', ($m -join ';'), 'Machine')`);
  if (LEG === 'git-hidden' && fs.existsSync('C:\\Program Files\\Git')) {
    try { fs.renameSync('C:\\Program Files\\Git', 'C:\\Program Files\\Git.hidden'); note('Git for Windows folder renamed away: this PC has no Git'); } catch (e) { note('could not hide Git', { detail: e.message }); }
  }
  note('saved PATH as a new window reads it', { detail: savedPath().split(';').filter(Boolean).join(' ; ').slice(0, 400) });
}

// ---- the terminal's environment: the computer's own, not the runner's -----------------------------------------------
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CI|GITHUB_|RUNNER_|ACTIONS_|INPUT_|NODE_OPTIONS$|npm_)/i.test(k)) delete env[k];
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const toolCache = (process.env.RUNNER_TOOL_CACHE || '').toLowerCase();
const hidden = (p) => (toolCache && p.toLowerCase().startsWith(toolCache)) || (WIN && /[\\/]nodejs([\\/]|$)/i.test(p)) || (WIN && LEG === 'git-hidden' && /[\\/]git[\\/]/i.test(p));
const envPath = () => [...(WIN ? [] : [SHIMS]), ...String(WIN ? savedPath() : env[pathKey] || '').split(path.delimiter).filter((p) => p && !hidden(p))].join(path.delimiter);
env[pathKey] = envPath();
env.HOPRIG_SOURCE = TGZ;
env.TERM = 'xterm-256color';
if (WIN && LEG !== 'admin-stop') env.HOPRIG_ALLOW_ADMIN = '1'; // a runner is an administrator; a person's window is not
if (!WIN) env.DISPLAY = env.DISPLAY || ':0'; // a desktop: the installer opens the browser (the shim answers)

// ---- one terminal window ------------------------------------------------------------------------------------------
const cast = [];
let raw = '';
function openWindow(label) {
  const shell = WIN ? 'powershell.exe' : MAC ? '/bin/zsh' : '/bin/bash';
  const args = WIN ? ['-NoLogo', '-ExecutionPolicy', POLICY] : ['-il'];
  const w = { label, buf: '', last: Date.now(), exited: null };
  if (WIN) env[pathKey] = envPath(); // a window opened now reads the PATH saved now
  w.p = pty.spawn(shell, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: os.homedir(), env });
  w.p.onData((d) => {
    w.buf += d;
    raw += d;
    w.last = Date.now();
    cast.push([(Date.now() - T0) / 1000, 'o', d]);
  });
  w.p.onExit((e) => { w.exited = { code: e.exitCode, at: secs() }; });
  w.type = (s) => { cast.push([(Date.now() - T0) / 1000, 'i', s]); w.p.write(s); };
  w.tail = () => plain(w.buf).split('\n').slice(-1)[0];
  note(`window opened: ${label}`);
  return w;
}
const SHELL_PROMPT = WIN ? /PS [A-Za-z]:[^\n]*> $/ : /[$%#] $/;
async function waitPrompt(w, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until && !w.exited) {
    if (Date.now() - w.last > 1500 && SHELL_PROMPT.test(w.tail())) return true;
    await sleep(300);
  }
  return false;
}
// A moment: the window as it is now, kept as text; made into a picture at the end.
const moments = [];
function moment(name, w) {
  moments.push({ name, at: secs(), stream: w.buf });
  summary.moments.push({ name, at: secs() });
}

// ---- 1. the install line ---------------------------------------------------------------------------------------------
// A question is a last line that waits: setup's yes/no ends with "(Y/n) " or "(y/N) ", a choice with "  > ", a typed
// answer with ": " or "password for". The first run has none; one that appears is counted, shown, and answered with Enter
// so the walk goes on and shows what comes after.
const QUESTION = /(\((?:Y\/n|y\/N)\) |^ {2}> |: |password for [^:]*:\s*)$/;
const install = openWindow('the install line');
await waitPrompt(install, 30_000);
moment('01-before-the-install-line', install);
install.type(`${LINE}\r`);
note('install line typed', { detail: LINE });
let n = 0;
const LIMIT = Date.now() + 25 * 60_000;
for (;;) {
  await sleep(500);
  const text = plain(install.buf);
  if (install.exited) { note('the window closed', { detail: `exit code ${install.exited.code}` }); break; }
  const idle = Date.now() - install.last;
  const last = install.tail();
  if (idle > 3000 && QUESTION.test(last) && !SHELL_PROMPT.test(last)) {
    n += 1;
    const q = text.split('\n').filter((l) => l.trim()).slice(-3).join(' / ').trim();
    moment(`${String(n + 1).padStart(2, '0')}-question-${n}`, install);
    summary.questions.push({ n, at: secs(), question: mask(q), answer: '(Enter)' });
    install.type('\r');
    install.last = Date.now();
    continue;
  }
  const finished = /You can close this window|Paste the same line again|Close this window, open PowerShell/.test(text);
  if (idle > 4000 && SHELL_PROMPT.test(last) && (finished || /cannot be loaded|is not recognized|command not found/i.test(text))) { note('the shell prompt is back'); break; }
  if (idle > 90_000 && SHELL_PROMPT.test(last)) { note('the shell prompt is back, no end text'); break; }
  if (idle > 8 * 60_000) { note('no output for 8 minutes: stopped here'); break; }
  if (Date.now() > LIMIT) { note('25 minutes: stopped here'); break; }
}
moment('90-the-end-of-the-installer', install);
summary.installMinutes = Math.round(secs() / 6) / 10;
const text = plain(raw);

// ---- 2. what the terminal showed ------------------------------------------------------------------------------------
check('the first run asked no question', summary.questions.length === 0, summary.questions.map((q) => q.question).join(' | '));
if (WIN && LEG === 'admin-stop') {
  // An administrator window is stopped before anything is installed, with one line.
  const stopped = /Close this window, open PowerShell the normal way \(not as administrator\) and paste the line again\./.test(text);
  check('an administrator window is stopped with the one line (when this session is elevated)', stopped, stopped ? '' : 'the line did not appear: this runner session may not be elevated');
  check('nothing was installed by the stopped run', !fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'hoprig', 'node')) && !/✓ /.test(text), '');
  await finish();
}
const ticks = ['Node.js', 'Hoprig', 'Claude Code'];
for (const t of ticks) check(`a tick line: ${t}`, new RegExp(`✓ ${t.replace('.', '\\.')}`).test(text), '');
check('a tick line says Hoprig starts by itself', /✓ Hoprig starts by itself when you (sign in to Windows|log in)/.test(text), '');
check('the browser is being opened (the words)', /Opening Hoprig in your browser/.test(text), '');
const link = /(http:\/\/127\.0\.0\.1:\d+\/login#link=[A-Za-z0-9_-]{43})/.exec(text);
check('the fallback link is on the last screen', !!link, '');
if (!WIN) {
  const opened = fs.existsSync(OPENED) ? fs.readFileSync(OPENED, 'utf8') : '';
  check(`${MAC ? 'open' : 'xdg-open'} was called with the one-time link`, /#link=[A-Za-z0-9_-]{43}/.test(opened), '');
}
if (WIN && LEG === 'git-hidden') {
  const g = text.search(/Windows asks to allow a change|✓ Git/);
  const c = text.search(/✓ Claude Code/);
  check('Git was installed before Claude Code', g >= 0 && c > g, `git at ${g}, claude at ${c}`);
}
if (WIN) {
  check('Node.js is in the person\'s own folder, not installed for all users', fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'hoprig', 'node', 'node.exe')), '');
  check('no .ps1 shim of hoprig is left', !fs.existsSync(path.join(process.env.APPDATA || '', 'npm', 'hoprig.ps1')) && !fs.existsSync(path.join(process.env.APPDATA || '', 'npm', 'hop.ps1')), '');
}

// ---- 3. is the window still there? a new window runs hoprig under the leg's policy -----------------------------------------
let w = install;
if (!w.exited) {
  w.type(WIN ? "'FIRSTRUN-' + 'ALIVE'\r" : 'echo FIRSTRUN-"ALIVE"\r');
  const until = Date.now() + 10_000;
  while (Date.now() < until && !plain(w.buf).includes('FIRSTRUN-ALIVE') && !w.exited) await sleep(300);
}
summary.windowStayed = !w.exited && plain(w.buf).includes('FIRSTRUN-ALIVE');
check('the window is still there after the installer (a marker typed and answered)', summary.windowStayed, '');
const fresh = openWindow('a new window, as the person opens one');
await waitPrompt(fresh, 30_000);
fresh.type('hoprig --version\r');
await sleep(4000);
await waitPrompt(fresh, 60_000);
moment('91-hoprig-version-typed', fresh);
const ver = plain(fresh.buf).split('\n').slice(1).join('\n');
check(`hoprig --version answers in a new window${WIN ? ` (execution policy ${POLICY})` : ''}`, /\b\d+\.\d+\.\d+\b/.test(ver) && !/cannot be loaded|not recognized|not found/i.test(ver), ver.trim().split('\n').slice(0, 2).join(' | '));
fresh.type(WIN ? 'hoprig service status\r' : 'hoprig service status\r');
await sleep(5000);
await waitPrompt(fresh, 60_000);
moment('92-service-status', fresh);
check('the background service is set up (hoprig service status)', /running|active|loaded|ready/i.test(plain(fresh.buf).split('\n').slice(2).join('\n')), plain(fresh.buf).split('\n').filter((l) => l.trim()).slice(-4).join(' | '));

// ---- 4. the dashboard: this computer only, answering ----------------------------------------------------------------------
const PORT = Number((link && /:(\d+)\//.exec(link[1])[1]) || 7433);
const BASE = `http://127.0.0.1:${PORT}`;
async function answers(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (r.status === 200) return true; } catch { /* not yet */ }
    await sleep(1000);
  }
  return false;
}
const up = await answers(`${BASE}/login`, 90_000);
check('the dashboard answers on 127.0.0.1', up, '');
const connects = (host) => new Promise((resolve) => {
  const s = net.connect({ host, port: PORT, timeout: 3000 });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('timeout', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(false));
});
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
if (lan) check('the dashboard does not answer on this computer\'s network address (no firewall alert can come)', !(await connects(lan.address)), `tried ${lan.address.replace(/\d+$/, 'x')}`);
else note('no network address to try');

// ---- 5. the pages, in headless Chrome at 1280 by 800, light --------------------------------------------------------------
if (up && link) {
  chrome = await launchChrome();
  await chrome.viewport(1280, 800, { theme: 'light' });
  const shot = async (name, wait = 2000) => {
    await sleep(wait);
    fs.writeFileSync(path.join(SCREENS, `${name}.png`), await chrome.shot());
    const words = await chrome.evaluate('document.body.innerText.slice(0, 2500)').catch(() => '');
    summary.pages.push({ name, words: mask(String(words)) });
    note(`page ${name}`);
    return String(words);
  };
  const press = (re) => chrome.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});
    const el = [...document.querySelectorAll('button, a, [role=button]')].find((e) => e.offsetParent && re.test(e.innerText.trim()));
    if (!el) return false;
    el.click();
    return true;
  })()`).catch(() => false);
  let signIn = link[1];
  let home = '';
  await chrome.goto(signIn, 7000);
  home = await shot('19-printed-link', 1500);
  const printedUsed = /used already|too old/.test(home);
  if (printedUsed) {
    // Something opened the printed link before this walker did: on Windows and the Mac that is the default browser the
    // installer started, which is the proof it was opened signed in. A second one proves a link still signs in.
    note('the printed link was already used: the default browser took it');
    try {
      const out = execSync(WIN ? 'hoprig link' : 'hoprig link', { env, encoding: 'utf8', timeout: 60_000, shell: WIN ? 'powershell.exe' : '/bin/bash' });
      const again = /(http:\/\/127\.0\.0\.1:\d+\/login#link=[A-Za-z0-9_-]{43})/.exec(out);
      if (again) signIn = again[1];
    } catch (e) { note('hoprig link failed', { detail: String(e.message).slice(0, 200) }); }
    await chrome.goto(signIn, 7000);
  }
  summary.printedLinkUsedByBrowser = printedUsed;
  home = await shot('20-home-first-run', 1500);
  check('the printed link signs in: Home shows the card', /Welcome to Hoprig/.test(home), home.slice(0, 120));
  check('the card has two steps and no New session button, no providers line, no badge', /Sign in to Claude|Signed in to Claude/.test(home) && /Start your first chat/.test(home) && !/New session/.test(home) && !/provider.*(available|not signed)/.test(home) && !/No sessions yet/.test(home) && !(await chrome.evaluate("!!document.querySelector('.nav-badge') && document.querySelector('.nav-badge').offsetParent !== null").catch(() => false)), home.slice(0, 200));

  // A stand-in for a signed-in Claude Code (a made-up account): auth status says signed in; the chat is the demo's, which
  // talks to no model. Hoprig's own settings point at it, and after the page's one-minute cache the card ticks step 1.
  const unpack = path.join(process.env.RUNNER_TEMP, 'firstrun-pkg');
  fs.mkdirSync(unpack, { recursive: true });
  execFileSync('tar', ['-xzf', path.basename(TGZ), '-C', path.relative(path.dirname(TGZ), unpack) || '.', 'package/src', 'package/package.json'], { stdio: 'ignore', cwd: path.dirname(TGZ) }); // by a relative name: GNU tar reads D: as a host
  const chat = path.join(unpack, 'package', 'src', 'demo', 'chat.mjs');
  const standin = path.join(SHIMS, 'standin-claude.mjs');
  fs.writeFileSync(standin, `import { spawn } from 'node:child_process';
const a = process.argv.slice(2);
if (a[0] === 'auth' && a[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.invalid', subscriptionType: 'pro' })); process.exit(0); }
if (a[0] === '--version') { console.log('2.1.332 (Claude Code)'); process.exit(0); }
process.env.CLAUDE_CONFIG_DIR ||= ${JSON.stringify(path.join(os.homedir(), '.claude'))};
spawn(process.execPath, [${JSON.stringify(chat)}, ...a], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
`);
  let bin = path.join(SHIMS, WIN ? 'claude.cmd' : 'claude');
  fs.writeFileSync(bin, WIN ? `@echo off\r\n"${process.execPath}" "${standin}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${standin}" "$@"\n`, { mode: 0o755 });
  const cfgFile = WIN ? path.join(process.env.APPDATA || '', 'hoprig', 'config.json') : path.join(os.homedir(), '.config', 'hoprig', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.claudeBin = bin;
    fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    note('settings point at the stand-in Claude Code');
  } catch (e) {
    note('could not point the settings at the stand-in', { detail: e.message });
  }
  await sleep(65_000);
  await chrome.goto(`${BASE}/#/`, 5000);
  const signed = await shot('21-home-signed-in', 1000);
  check('with Claude Code signed in, step 1 is ticked by itself', /Signed in to Claude/.test(signed), signed.slice(0, 120));
  check('New project opens a chat', await press(/^New project$/), '');
  await sleep(7000);
  const typed = await chrome.evaluate(`(() => { const t = document.querySelector('textarea'); return t ? t.placeholder : null; })()`).catch(() => null);
  await shot('22-first-chat', 500);
  check('the first chat\'s box says what to make', typed === 'Tell Claude what to make, for example: a web page with a clock', String(typed));
  await chrome.evaluate(`(() => { const t = document.querySelector('textarea'); t.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'a web page with a clock'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`).catch(() => {});
  await chrome.evaluate("(() => { const b = document.querySelector('.chat-send'); if (b) b.click(); })()").catch(() => {});
  const answer = await shot('23-first-answer', 12_000);
  check('Claude answers in the chat', /This chat talks to no model/.test(answer) && !/stopped/i.test(answer), answer.slice(0, 160));
  await chrome.goto(`${BASE}/#/`, 4000);
  const after = await shot('24-home-after', 500);
  check('after the first chat the card is gone for good', !/Welcome to Hoprig/.test(after), '');
  pageErrors.push(...chrome.errors.map(mask));
}
await finish();

// ---- the end: pictures of the terminal, the words, the checks --------------------------------------------------------------
async function finish() {
  try { if (WIN) fs.copyFileSync(path.join(process.env.LOCALAPPDATA || '', 'hoprig', 'install.log'), path.join(OUT, 'install.log')); } catch { /* none written */ }
  fs.writeFileSync(path.join(OUT, 'page-errors.txt'), `${pageErrors.join('\n')}\n`);
  const own = chrome || await launchChrome();
  const xdir = path.join(ROOT, 'node_modules', '@xterm', 'xterm');
  const html = path.join(OUT, 'terminal.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(xdir, 'css', 'xterm.css')).href}">
<style>html,body{margin:0;background:#0c0c0c}#t{padding:12px}</style><div id="t"></div>
<script src="${pathToFileURL(path.join(xdir, 'lib', 'xterm.js')).href}"></script>
<script>const term = new Terminal({ cols: 120, rows: 40, fontSize: 14, fontFamily: 'Consolas, Menlo, monospace', convertEol: false, theme: { background: '#0c0c0c' } });
term.open(document.getElementById('t')); window.feed = (s) => new Promise((r) => term.write(s, r));</script>`);
  const htmlUrl = pathToFileURL(html).href;
  await own.viewport(1280, 800, { theme: 'light' });
  for (const m of moments) {
    await own.goto(htmlUrl, 800);
    await own.evaluate(`feed(${JSON.stringify(mask(m.stream))})`).catch(() => {});
    await sleep(300);
    fs.writeFileSync(path.join(SCREENS, `${m.name}.png`), await own.shot());
  }
  await own.close();
  server.close();
  fs.writeFileSync(path.join(OUT, 'transcript.txt'), mask(plain(raw)));
  fs.writeFileSync(path.join(OUT, 'terminal.cast'), [JSON.stringify({ version: 2, width: 120, height: 40, timestamp: Math.floor(T0 / 1000) }), ...cast.map(([t, k, d]) => JSON.stringify([t, k, mask(d)]))].join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'questions.txt'), `${summary.questions.map((q) => `${q.n}. at ${q.at}s: ${q.question}`).join('\n')}\n`);
  summary.minutes = Math.round(secs() / 6) / 10;
  fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const failed = summary.checks.filter((c) => !c.ok);
  const md = [
    `### First run: ${summary.system}${WIN ? `, execution policy ${POLICY}, leg ${LEG}` : ''}`,
    `- questions asked: ${summary.questions.length}; the window stayed after the installer: ${summary.windowStayed ? 'yes' : 'NO'}; the installer took ${summary.installMinutes} min; the whole walk ${summary.minutes} min`,
    `- checks: ${summary.checks.length - failed.length} passed, ${failed.length} failed`,
    ...summary.checks.map((c) => `- ${c.ok ? 'PASS' : '**FAIL**'} ${c.name}${c.detail ? ` (${mask(c.detail).replace(/\|/g, '/')})` : ''}`),
    '',
    'Pictures, words and answers: the artifact of this job.',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), `${md}\n`);
  console.log(md);
  // Green means every claim of the design held on this system; a failed check fails the job (the pictures are kept).
  process.exit(failed.length || !summary.moments.length ? 1 : 0);
}
