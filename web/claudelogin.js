// Sign Claude Code in from the page (src/server/claudelogin.mjs): Setup's "Claude login" row, Home → Get started and
// Providers (a provider that uses Claude Code's stored login). The computer runs `claude auth login`; this page only
// opens the sign-in link in this browser and, when the browser is on another computer, passes the code back.
//
// The tab is opened inside the click, before the server has the link, so a popup blocker lets it through; its
// address is set once the link is known. Where it was blocked anyway, the sheet shows the link as a big button.
import { icon } from './icons.js';
import { api, btn, copyText, fill, h, machine, openSheet, toast } from './lib.js';
import { errorBox, okBox, steps } from './shell.js';
import { store } from './store.js';

const R = (p = '') => `~/api/accounts/claude-login${p}`; // always this dashboard's own computer
const busy = (text) => h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));

// The sign-in page of Anthropic signs in whoever the browser is signed in as: for another account that has to change.
const otherAccountHint = () => h('p.hint', 'If the sign-in page shows the account you are on now, switch the account there first, or copy the link into a private window.');

/** Run the command in a terminal session instead (Get started's old way), for when the page way does not work. */
async function terminalWay(close) {
  try {
    const r = await api('~/api/onboarding/run', { run: 'claude-login' });
    close();
    location.hash = `#/s/${encodeURIComponent(r.session)}`;
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

/** Open a tab now (inside the click) and point it at the sign-in page later. null when the browser refused. */
function blankTab() {
  try {
    const w = window.open('about:blank', '_blank');
    if (w) w.opener = null; // the sign-in page must not reach back into this one
    return w;
  } catch {
    return null;
  }
}

/**
 * The sign-in sheet. Resolves true when Claude Code is signed in. `done()` runs after a sign-in, so the part that
 * opened it can draw itself again (the store is refreshed here: Providers and the rest follow).
 *
 * `another` (claudeaccount.js): the sign-in is for another account than the one signed in now. The account signed
 * in so far stays until the new sign-in is complete; when the same account comes back, the sheet says so and
 * offers to try again. `email` pre-fills the sign-in page. `after(result, body, close)` may draw what comes next
 * into the sheet (the sessions that go on); it returns true when it did, and the sheet then stays open.
 */
export function claudeSignIn({ done = () => {}, another = false, email = '', after = null } = {}) {
  let tab = blankTab();
  let finished = false;
  let poll = null;
  const head = another
    ? { title: 'Sign in with another Claude account', subtitle: 'The account signed in now stays until the new sign-in is complete.' }
    : { title: 'Sign in to Claude Code', subtitle: 'With your Claude account. Claude Code keeps the sign-in on this computer; it never comes to this page.' };
  return openSheet(head, (close) => {
    const body = h('div.wizard', busy('Starting Claude Code on the computer…'));
    const terminal = () => h('p.hint', 'Not working? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); terminalWay(close); } }, 'Use the terminal instead'), '.');
    const success = (r) => {
      if (finished) return; // the look and the code's answer may both bring it
      clearInterval(poll);
      const plan = r.plan ? ` (${r.plan.charAt(0).toUpperCase()}${r.plan.slice(1)})` : '';
      if (another && r.changed !== true) {
        // The sign-in page signed in the account the browser already had: nothing is different, and its limit is
        // the same. Said plainly, with the way to another account.
        finished = true;
        store.refresh();
        done();
        return fill(body,
          h('div.banner.warn', icon('alert', { size: 18 }), h('span', `Claude Code is signed in with the same account as before${plan}. Its limits are unchanged.`)),
          h('p.sheet-text', 'The sign-in page uses the account your browser is signed in to at claude.ai. Switch the account there first, or copy the sign-in link into a private window, then try again.'),
          h('div.sheet-actions',
            h('button.btn.secondary', { type: 'button', onclick: () => close(true) }, 'Close'),
            btn('primary', { icon: 'refresh', label: 'Try again', onclick: () => { finished = false; tab = blankTab(); start(); } })));
      }
      finished = true;
      fill(body, okBox(another ? `Claude Code is signed in with another account${plan}.` : `Claude Code is signed in${plan}.`));
      toast(another ? 'Signed in with another account' : 'Claude Code is signed in');
      store.refresh();
      done();
      if (after && after(r, body, close)) return;
      setTimeout(() => close(true), 1200);
    };
    const failed = (message) => {
      if (finished) return;
      clearInterval(poll);
      fill(body, errorBox(message), h('div.savebar', btn('secondary', { icon: 'refresh', label: 'Start again', onclick: () => { tab = blankTab(); start(); } })), terminal());
    };
    // The sign-in on this computer ends by itself (or a code typed elsewhere): look every 1.5 s.
    const watch = () => {
      clearInterval(poll);
      poll = setInterval(async () => {
        try {
          const s = await api(R());
          if (s.state === 'done') success(s);
          else if (s.state === 'error') failed(s.error);
          else if (s.state === 'none') failed('The sign-in was stopped. Start again.');
        } catch {
          /* a missed look; the next one tries again */
        }
      }, 1500);
    };
    const openButton = (url, label) => h('div.btnrow',
      h('a.btn.primary', { href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', { size: 18 }), h('span', label)),
      btn('secondary', { icon: 'copy', label: 'Copy link', onclick: async () => toast((await copyText(url)) ? 'Link copied' : 'Copy did not work') }));

    function codeStep(r, opened) {
      const code = h('input.field.mono', { placeholder: 'Paste the code here', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
      const go = h('button.btn.primary', { type: 'submit' }, 'Sign in');
      const out = h('div');
      const form = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        if (!code.value.trim()) return code.focus();
        go.disabled = true;
        fill(out, busy('Claude Code is checking the code…'));
        try {
          success(await api(R('/code'), { code: code.value }));
        } catch (err) {
          go.disabled = false;
          // Not even the shape of a code: Claude Code still waits, so the same link stays. Anything else: start again.
          const now = await api(R()).catch(() => null);
          if (now && now.state === 'link') fill(out, errorBox(err.message));
          else failed(err.message);
        }
      } },
      steps(
        [h('p', opened ? 'Sign in and allow access in the tab that opened.' : 'Open the sign-in page and allow access.'), openButton(r.codeUrl, opened ? 'Open it again' : 'Open the sign-in page')],
        [h('p', 'The page then shows a code. Copy it and paste it here.'), code]),
      out,
      another ? otherAccountHint() : null,
      h('p.hint', 'The sign-in stays open for 10 minutes.'), terminal(),
      // The sticky action bar is the sheet's last part (style.css .sheet-actions): nothing may sit under it.
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), go));
      fill(body, form);
      code.focus();
    }

    function localStep(r, opened) {
      fill(body,
        opened ? h('p.sheet-text', 'Sign in and allow access in the tab that opened. This page notices by itself when it is done.')
          : h('div', h('p.sheet-text', 'Open the sign-in page and allow access. This page notices by itself when it is done.'), openButton(r.url, 'Open the sign-in page')),
        busy('Waiting for the sign-in…'),
        another ? otherAccountHint() : null,
        h('p.hint', 'Ended on a page with a code? ', h('a', { href: '#', onclick: (e) => {
          e.preventDefault();
          const w = blankTab();
          if (w) w.location.href = r.codeUrl;
          codeStep(r, Boolean(w));
        } }, 'Use the code instead'), '.'),
        terminal(),
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel')));
    }

    async function start() {
      fill(body, busy('Starting Claude Code on the computer…'));
      let r;
      try {
        r = await api(R('/start'), email ? { email } : {});
      } catch (e) {
        if (tab) tab.close();
        tab = null;
        // One left open (another tab, another device): end it here, then this one starts.
        const open = e.status === 409 && /in progress/i.test(e.message);
        return fill(body, errorBox(e.message),
          open ? h('div.savebar', btn('secondary', { icon: 'x', label: 'Cancel that sign-in and start again', onclick: async () => { await api(R('/cancel'), {}).catch(() => {}); tab = blankTab(); start(); } })) : null,
          terminal());
      }
      const opened = Boolean(tab && !tab.closed);
      if (opened) tab.location.href = r.url;
      tab = null;
      watch();
      if (r.way === 'local') localStep(r, opened);
      else codeStep(r, opened);
    }
    start();
    return body;
  }).then((ok) => {
    clearInterval(poll);
    if (tab) tab.close(); // closed before the link came
    if (!finished) api(R('/cancel'), {}).catch(() => {});
    return ok === true;
  });
}

/** The "Sign in" button of Setup's "Claude login" row. Only on this dashboard's own computer: a sign-in never goes
 * through another computer's page. `after()` draws the checks again. */
export function claudeLoginButton(after) {
  if (machine.current) return null;
  return btn('small primary', { icon: 'user', label: 'Sign in', title: 'Sign in to Claude Code with your Claude account', onclick: () => claudeSignIn({ done: after }) });
}
