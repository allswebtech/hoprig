#!/usr/bin/env node
// Dev-only (not in the published package): the README's screenshots, made again after any UI change with
//
//   node tools/screenshots.mjs [--out docs/screenshots] [--only name,name] [--port N]
//
// It starts `hoprig demo` in this process (sample data in a temp folder, nothing real), drives the local Chrome
// headless over the DevTools protocol (tools/chrome.mjs), and writes WebP images (each kept under ~300 KB) and the
// GitHub social preview (assets/social-preview.png, 1280×640). Needs Chrome or Chromium; nothing to install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const OUT = path.resolve(ROOT, opt('--out', 'docs/screenshots'));
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',')) : null;
const MAX_BYTES = 300 * 1024;
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1280, height: 800, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };
// The pictures added for the pages of 0.3.3 (the Operator, Work's Today, the Workspace page, Tia with a card).
const WIDE = { width: 1440, height: 900, mobile: false };


// ---------- the demo ----------
const { main } = await import(path.join(ROOT, 'src/demo/index.mjs'));
const hooks = { onReady: (i) => (hooks.info = i) };
if ((await main(['--no-open', '--quiet', ...(opt('--port') ? ['--port', opt('--port')] : [])], hooks)) !== null) throw new Error('the demo did not start');
process.stdout.write('demo started; waiting for its sample data…');
await hooks.background;
console.log(' ready');
const { url } = hooks.info;

// The real home folder: the demo points HOME at its temp folder, and Chrome started with that home folder cannot
// reach the network the site's pages load their fonts from.
const chrome = await launchChrome({ realHome: true });
// A whole run takes about two minutes; past ten something is stuck: stop the demo and Chrome, and say so.
setTimeout(async () => {
  console.error('screenshots: still running after 10 minutes; stopping');
  await chrome.close().catch(() => {});
  await hooks.stop();
  process.exit(1);
}, 10 * 60_000).unref();
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await chrome.viewport(DESKTOP.width, DESKTOP.height, { theme: 'light' });
  await chrome.goto(hooks.info.link, 2500); // the one-time sign-in link; the cookie stays for the whole run

  let loads = 0;
  async function view(hash, size, theme, wait = 1800) {
    await chrome.viewport(size.width, size.height, { mobile: size.mobile, theme });
    // A real reload each time (a different query string; a hash change alone would keep the page and any open sheet).
    // A fresh trail each time: a reload by address would otherwise show "‹ <the shot before>" in the page head.
    await chrome.evaluate('try { sessionStorage.clear(); } catch {} true').catch(() => {});
    await chrome.goto(`${url}/?shot=${++loads}${hash}`, wait);
  }
  // The viewport made as tall as `bottom` (a page expression: the y where the picture ends, at most `max`), so a list
  // is in the picture whole and nothing in it is cut off.
  async function tallTo(size, bottom, max = 3000) {
    const tall = Math.ceil(Number(await chrome.evaluate(bottom)) || size.height);
    await chrome.viewport(size.width, Math.min(max, Math.max(size.height, tall)), { mobile: size.mobile, theme: 'light' });
    await sleep(1200);
  }
  const click = (text, sel = 'button, a, [role=link]') =>
    chrome.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.getClientRects().length && getComputedStyle(b).display !== 'none' && b.textContent.replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);

  /** Capture the viewport as WebP under the size budget. */
  async function save(name, { format = 'webp' } = {}) {
    let q = 82;
    let buf = await chrome.shot({ format, quality: q });
    while (format === 'webp' && buf.length > MAX_BYTES && q > 40) {
      q -= 10;
      buf = await chrome.shot({ format, quality: q });
    }
    const file = path.join(OUT, `${name}.${format}`);
    fs.writeFileSync(file, buf);
    results.push({ file: path.relative(ROOT, file), kb: Math.round(buf.length / 1024) });
    return buf;
  }
  const want = (name) => !ONLY || ONLY.has(name);

  // ---------- the screens ----------
  const setting = (patch) => chrome.evaluate(`fetch('api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(patch)}) }).then((r) => r.status)`);
  const post = (to, body) => chrome.evaluate(`fetch(${JSON.stringify(to)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
  const getJson = (from) => chrome.evaluate(`fetch(${JSON.stringify(from)}).then((r) => r.json())`);
  async function until(test, ms, why = 'the demo') {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await test()) return true;
    throw new Error(`screenshots: ${typeof why === 'function' ? await why() : why} did not get there in time`);
  }
  // Tia in a new conversation of her own. The demo's Tia runs on Auto, whose order holds a provider billed by use, and
  // with no daily spending cap she does not think there (src/assistant/spend.mjs): she runs on the subscription
  // "max" for the pictures, as a person chooses under Settings -> Tia. Each message waits for her answer; a
  // message that asks to move a session waits for its card. Returns the conversation's id.
  async function tiaSays(texts) {
    const set = await post('api/assistant/settings', { runsOn: 'max' });
    if (set.status !== 200) throw new Error(`Tia's provider was not set: ${set.status} ${JSON.stringify(set.body)}`);
    let conv = null;
    for (const text of texts) {
      const before = new Set(((await getJson('api/assistant/cards')).cards || []).map((c) => c.id));
      const newCard = async () => ((await getJson('api/assistant/cards')).cards || []).find((c) => !before.has(c.id)) || null;
      const r = await post('api/assistant/chat', { text, ...(conv ? { conversation: conv } : {}) });
      if (r.status !== 200) throw new Error(`Tia did not take the message: ${r.status} ${JSON.stringify(r.body)}`);
      conv = r.body.conversation;
      const said = async () => `Tia (${text.slice(0, 30)}…; she said: ${JSON.stringify(((await getJson(`api/assistant/chat/${conv}?from=0`)).events || []).slice(-4)).slice(0, 900)})`;
      if (/^start /i.test(text)) {
        // A start waits for his OK on a card: Confirm is tapped, as a person does.
        let card = null;
        await until(async () => (card = await newCard()) || ((await getJson('api/assistant/jobs')).jobs || []).some((j) => j.state === 'done'), 20_000, said);
        if (card) {
          const ok = await post(`api/assistant/cards/${card.id}/confirm`, {});
          if (ok.status !== 200) throw new Error(`Tia's start card was not confirmed: ${ok.status} ${JSON.stringify(ok.body)}`);
        }
        // Her job: the demo's session waits at its end, and she is woken for it and answers (src/demo/tia.mjs).
        await until(async () => ((await getJson(`api/assistant/chat/${conv}?from=0`)).events || []).some((e) => e.kind === 'wake'), 60_000, said);
        await until(async () => !(await getJson(`api/assistant/chat/${conv}?from=0`)).busy, 20_000, said);
      }
      else if (/^move /i.test(text)) await until(newCard, 20_000, said);
      else await until(async () => !(await getJson(`api/assistant/chat/${conv}?from=0`)).busy, 20_000, said);
      await sleep(1500);
    }
    return conv;
  }
  // Tia's page on a conversation (the one the page opens is the one it keeps in its preferences, web/tia.js).
  async function openTia(conv, size) {
    await chrome.evaluate(`try { localStorage.setItem('pref:tia.conversation', ${JSON.stringify(JSON.stringify(conv))}); } catch {} true`);
    await view('#/tia', size, 'light', 3500);
    await tallTo(size, `(() => { let s = document.querySelector('.tia-chat'); while (s && s !== document.scrollingElement && s.scrollHeight <= s.clientHeight + 1) s = s.parentElement;
      return document.scrollingElement.scrollHeight + (s && s !== document.scrollingElement ? s.scrollHeight - s.clientHeight : 0); })()`);
  }
  // The demo's chat (src/demo/chat.mjs) and the folder it changed: the chat and the editor shots open them.
  const chatId = await chrome.evaluate(`fetch('api/chats').then((r) => r.json()).then((j) => (j.chats || [])[0]?.chatId || '')`);
  const shopDir = await chrome.evaluate(`fetch('api/chats').then((r) => r.json()).then((j) => (j.chats || [])[0]?.cwd || '')`);
  const shots = {
    // Home → Get started first, while it is open; then it is closed so the other Home shots show the sessions.
    'get-started-desktop-light': async () => view('#/', DESKTOP, 'light', 3000),
    // Closed only now, after the shot above was taken (the open page would hide it on its next poll).
    'home-desktop-light': async () => {
      await setting({ server: { getStartedDismissed: true } });
      await view('#/', DESKTOP, 'light');
    },
    // The chat: thinking, the to-do list, a file read, an edit with its diff, and a test run waiting for the OK.
    'chat-desktop-light': async () => view(`#/chat/${chatId}`, DESKTOP, 'light', 3500),
    'chat-phone-light': async () => view(`#/chat/${chatId}`, PHONE, 'light', 3500),
    'session-phone-light': async () => view('#/s/api-server', PHONE, 'light', 3000),
    // One tap on a project starts it. The picture is the phone's height, made as tall as the bottom of the row that
    // height would cut in two (any group of the sheet), so no row in it is cut.
    'new-session-phone-light': async () => {
      await view('#/new', PHONE, 'light', 2500);
      await tallTo(PHONE, `(() => { const cut = [...document.querySelectorAll('.ns-projects .rows > *')].map((r) => r.getBoundingClientRect()).find((b) => b.top < ${PHONE.height} && b.bottom > ${PHONE.height}); return cut ? cut.bottom + 1 : 0; })()`, 1000);
    },
    // The editor on the chat's folder, Source Control, the changed file side by side.
    'editor-desktop-light': async () => {
      await view(`#/code?dir=${encodeURIComponent(shopDir)}&view=changes`, DESKTOP, 'light', 3000);
      await chrome.evaluate(`document.querySelector('.ed-change-name')?.closest('[tabindex]')?.click(); true`);
      await sleep(3000);
    },
    // The desktop: Sessions snapped to the left half, the Task manager to the right (Alt+Shift+arrow snaps the window
    // in front, as a person would).
    'desktop-desktop-light': async () => {
      const snap = (code) => chrome.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', altKey: true, shiftKey: true, bubbles: true })); true`);
      await chrome.evaluate(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('desktop.')) localStorage.removeItem(k); } catch {} true`);
      await view('#/desktop', DESKTOP, 'light', 2500);
      await chrome.evaluate(`document.querySelector('.desk-icon[data-app="sessions"]')?.click(); true`);
      await sleep(1500);
      await snap('ArrowLeft');
      await chrome.evaluate(`document.querySelector('.desk-start')?.click(); true`);
      await sleep(500);
      await click('Task manager', '.desk-app');
      await sleep(1000);
      await snap('ArrowRight');
      await sleep(3000);
    },
    'limit-reached-desktop-light': async () => view('#/s/docs-site', DESKTOP, 'light', 3500),
    // Providers with "Carry on with the next provider" chosen (Auto mode) and how it works opened.
    'auto-mode-desktop-light': async () => {
      await view('#/providers', DESKTOP, 'light', 2500);
      await click('How it works', 'summary');
      await sleep(500);
    },
    // The list of providers itself (the shot above shows the choice at the top of the same page).
    'accounts-desktop-light': async () => {
      await view('#/providers', DESKTOP, 'light', 2500);
      // Without its Gateways part: the demo hands the gateway feature no stand-in, so that part knocks on the shipped
      // gateway's own port of the computer the pictures are taken on and would show that gateway's real state. A style
      // in the page's head stays through the page's redraws. Room below the list, so the page still scrolls to it and
      // no cut part of the card above shows under the header.
      await chrome.evaluate(`(() => { const st = document.createElement('style'); st.textContent = 'section.panel:has(.gw-row), section.panel:has(.gw-act) { display: none !important; } .page { padding-bottom: 600px !important; }'; document.head.append(st); return true; })()`);
      await sleep(300);
      await chrome.evaluate(`(() => { const heads = [...document.querySelectorAll('h2, h3, .group-head')]; const el = heads.find((x) => /^providers/i.test(x.textContent.trim())); if (el) window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 90); })()`);
      await sleep(500);
    },
    'computers-desktop-light': async () => view('#/computers', DESKTOP, 'light', 2500),
    'computer-overview-desktop-light': async () => view('#/computer', DESKTOP, 'light', 3500),
    'computer-setup-desktop-light': async () => view('#/computer/setup', DESKTOP, 'light', 4000),
    'settings-desktop-light': async () => view('#/settings', DESKTOP, 'light', 2500),
    'work-schedules-desktop-light': async () => view('#/work/schedules', DESKTOP, 'light', 3000),
    'coding-tools-desktop-light': async () => view('#/settings/new-sessions?show=coding-tools', DESKTOP, 'light', 2500),
    'updates-desktop-light': async () => view('#/settings/updates', DESKTOP, 'light', 3000),
    'public-link-desktop-light': async () => view('#/settings/public-link', DESKTOP, 'light', 2500),
    'projects-desktop-light': async () => view('#/workspace', DESKTOP, 'light', 4000),
    'project-page-desktop-light': async () => view('#/workspace/project/shop-frontend', DESKTOP, 'light', 4000),
    // The Operator: what needs you now, ranked, each item with the one recommended button.
    'operator-desktop-light': async () => {
      await view('#/operator', WIDE, 'light', 4000);
      // The whole "Needs you" list; the side column (its switches, one below the other, run on far longer) ends at
      // the first line between two of its parts under the list's end, so no part of it is cut in two.
      await tallTo(WIDE, `(() => { const end = document.querySelector('.op-list').getBoundingClientRect().bottom + scrollY;
        const lines = [...document.querySelectorAll('.op-side li, .op-side .op-decide, .op-side > section')].map((e) => e.getBoundingClientRect().bottom + scrollY).filter((b) => b >= end);
        return Math.min(end + 400, ...lines) + 16; })()`);
    },
    // The Workspace page: the projects of this computer, each with its sessions; the picture ends under the second
    // project, so no project in it is cut in two.
    'workspace-desktop-light': async () => {
      await view('#/workspace', WIDE, 'light', 4000);
      await tallTo(WIDE, `(() => { const p = [...document.querySelectorAll('.ws-project')]; return p.length > 1 ? p[1].getBoundingClientRect().bottom + scrollY + 12 : 0; })()`);
    },
    // Work's Today with three tasks added the way a person adds them (Add task): what needs you, the week, the progress.
    'work-today-desktop-light': async () => {
      const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
      for (const item of [
        { title: 'Renew the test certificate', date: day(0), priority: 'high' },
        { title: 'Check the checkout on small phones', date: day(2), project: 'shop-frontend' },
        { title: 'Write the release notes', date: day(4), project: 'docs-site' },
      ]) {
        const r = await post('api/work/items', item);
        if (r.status !== 200) throw new Error(`a Work task was not added: ${r.status} ${JSON.stringify(r.body)}`);
      }
      await view('#/work', WIDE, 'light', 3500);
      await tallTo(WIDE, `document.scrollingElement.scrollHeight`);
    },
    // Tia last of the pages, so the card she leaves waiting is in no other picture. Her conversation is in the picture
    // whole: the window is made as tall as the page plus what its chat would scroll.
    // Tia: the demo's conversation (a question, a session she started and saw finish, a card that waits for the OK).
    'tia-desktop-light': async () => {
      // The demo's own conversation as its seed leaves it (src/demo/index.mjs): her answer, the landing-page session she
      // started and saw finish, and the move of docs-site that waits for the OK. The same messages sent again here would
      // start a second landing-page session.
      const convs = (await getJson('api/assistant')).conversations || [];
      const seed = convs[convs.length - 1];
      if (!seed) throw new Error('screenshots: the demo has no Tia conversation');
      await openTia(seed.id, DESKTOP);
    },
    // Tia with one card that waits for your OK: one message, her answer, the card. A card still waiting from the shot
    // above is declined first, so this conversation shows only its own.
    'tia-card-desktop-light': async () => {
      for (const c of (await getJson('api/assistant/cards')).cards || []) await post(`api/assistant/cards/${c.id}/reject`, {});
      const conv = await tiaSays(['Move docs-site to the API provider so it can go on']);
      await openTia(conv, WIDE);
    },
    // The same card on a phone: a card needs a glance and one tap, so a phone is where it is answered.
    'tia-card-phone-light': async () => {
      for (const c of (await getJson('api/assistant/cards')).cards || []) await post(`api/assistant/cards/${c.id}/reject`, {});
      const conv = await tiaSays(['Move docs-site to the API provider so it can go on']);
      await openTia(conv, PHONE);
    },
  };
  const images = {};
  for (const [name, go] of Object.entries(shots)) {
    if (!want(name) && !(name === 'home-desktop-light' || name === 'chat-phone-light')) continue;
    await go();
    images[name] = await save(name);
    console.log(`  ${name}`);
  }

  // ---------- the hero: desktop Home next to the chat on a phone ----------
  const dataUrl = (b) => `data:image/webp;base64,${b.toString('base64')}`;
  async function compose(name, width, height, html, format = 'webp') {
    await chrome.viewport(width, height, { theme: 'light', scale: 1 });
    await chrome.goto(`data:text/html;base64,${Buffer.from(html).toString('base64')}`, 1200);
    return save(name, { format });
  }
  const mark = fs.readFileSync(path.join(ROOT, 'assets/logo-mark.svg')).toString('base64');
  if (want('hero')) {
    await compose('hero', 1600, 900, `<!doctype html><body style="margin:0;width:1600px;height:900px;overflow:hidden;background:linear-gradient(135deg,#eef0ff 0%,#f5f6f8 55%,#e3f6ec 100%);font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
      <img src="${dataUrl(images['home-desktop-light'])}" style="position:absolute;left:70px;top:70px;width:1100px;border-radius:14px;box-shadow:0 30px 80px rgba(20,24,60,.28)">
      <img src="${dataUrl(images['chat-phone-light'])}" style="position:absolute;right:90px;top:120px;width:330px;border-radius:38px;border:10px solid #15171c;box-shadow:0 30px 80px rgba(20,24,60,.35)">
    </body>`);
    console.log('  hero');
  }

  // ---------- GitHub's social preview, 1280×640 ----------
  if (want('social')) {
    const buf = await compose('social-preview-tmp', 1280, 640, `<!doctype html><body style="margin:0;width:1280px;height:640px;overflow:hidden;background:#0e1014;color:#e9ebf0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
      <div style="position:absolute;left:72px;top:130px;width:500px">
        <div style="display:flex;align-items:center;gap:22px"><img src="data:image/svg+xml;base64,${mark}" width="96" height="96"><span style="font-size:64px;font-weight:750;letter-spacing:-1.5px"><span style="color:#8b92a0">hop</span>rig</span></div>
        <p style="font-size:34px;line-height:1.3;margin:40px 0 0;font-weight:600">Your coding chats, on every computer.</p>
        <p style="font-size:24px;line-height:1.45;margin:18px 0 0;color:#b8bdc8">Claude Code and OpenCode in one dashboard. At a usage limit the same session goes on with the next provider. From your phone, too.</p>
      </div>
      <img src="${dataUrl(images['home-desktop-light'])}" style="position:absolute;left:616px;top:125px;width:624px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6)">
    </body>`, 'png');
    fs.copyFileSync(path.join(OUT, 'social-preview-tmp.png'), path.join(ROOT, 'assets/social-preview.png')); // --out may be on another disk
    fs.rmSync(path.join(OUT, 'social-preview-tmp.png'));
    results.find((r) => r.file.endsWith('social-preview-tmp.png')).file = 'assets/social-preview.png';
    console.log(`  social preview (${Math.round(buf.length / 1024)} KB)`);
  }

} finally {
  await chrome.close();
  await hooks.stop();
}
console.log('\nWritten:');
for (const r of results) console.log(`  ${r.file}  ${r.kb} KB${r.kb > 300 ? '  (over 300 KB)' : ''}`);
process.exit(0);
