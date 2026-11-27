// Setup jobs in the page (POST /api/pcsetup/setup | fix | recipe, GET /api/pcsetup/job, src/pcsetup/feature.mjs):
// Set up this computer, a check's Fix and a recipe run on the server as a background job, and Setup shows it in a
// card: each step with ✓ or ✗, the output as it comes, the result and "Check again". The job goes on when the owner
// leaves the page; the card finds it again when Setup is opened.
// The administrator password: asked for in a sheet only when sudo needs one, "used once for these installs, not
// saved" (the server hands it to sudo and keeps it for that one job only: src/pcsetup/admin.mjs). On a plain-http
// page that is not this computer it would cross the network unencrypted: the sheet says so and offers the terminal.
// For another computer reached over a plain leg (http, ws) the sheet has no password field at all: it says the
// password is asked only on that computer's own page, and links to it when the address is known.
// The terminal stays as that fallback, and for a step that needs a person at the computer (macOS's install window).
import { icon } from './icons.js';
import { ApiError, add, api, btn, confirmSheet, fill, h, insecure, link, machine, openSheet, toast } from './lib.js';
import { errorBox, okBox } from './shell.js';

export const SETUP_KINDS = ['setup', 'fix', 'recipe', 'tool'];
const MARK = { waiting: '·', running: '…', ok: '✓', fail: '✗', skipped: '–' };
const MARK_CLASS = { waiting: 'info', running: 'info', ok: 'ok', fail: 'fail', skipped: 'info' };
const MARK_LABEL = { waiting: 'Waiting', running: 'Running', ok: 'Done', fail: 'Failed', skipped: 'Skipped' };
const TITLE = { setup: 'Setting up this computer', fix: 'Installing the fix', recipe: 'Setting up from the recipe', tool: 'Installing a coding tool' };
const RECENT_MS = 30 * 60_000; // a finished job is shown again for this long

/** The password sheet. Resolves the password, "terminal" (the fallback) or null (cancelled). */
export function passwordSheet({ wrong = false } = {}) {
  const plain = insecure();
  return openSheet({ title: 'The computer\'s password', subtitle: 'Some steps need administrator rights (sudo).' }, (close) => {
    const input = h('input.field', { type: 'password', autofocus: true, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Password' });
    const err = h('p.form-error', { role: 'alert' }, wrong ? 'That password was not accepted. Try again.' : '');
    const terminal = btn(plain ? 'primary' : 'ghost', { icon: 'terminal', label: 'Use the terminal instead', onclick: () => close('terminal') });
    return h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        if (!input.value) err.textContent = 'Type the password, or use the terminal instead.';
        else close(input.value);
      },
    },
    plain ? h('div.banner.warn', icon('lock', { size: 18 }), h('span', 'This page is not encrypted (http): the password would cross the network readable by anyone on the way. Use the terminal instead, or open the dashboard over HTTPS.')) : null,
    h('label.fieldrow', h('span.field-label', 'The password of your account on this computer'), input,
      h('span.hint', 'Used once for these installs, not saved.')),
    err,
    h('div.sheet-actions',
      terminal,
      h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'),
      h(`button.btn.${plain ? 'secondary' : 'primary'}`, { type: 'submit' }, plain ? 'Send it anyway' : 'Install')));
  });
}

/**
 * Another computer reached over a plain leg (src/machines/legs.mjs): its password is never typed here. The sheet says
 * so in one sentence, with that computer's own page as a link when the address is known. Resolves when closed.
 */
/** `v` as a link target: only an http: or https: address, else null (the sentence is shown without a link). */
export function pageHref(v) {
  if (typeof v !== 'string' || !v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function plainLegSheet({ label = 'that computer', page = null } = {}) {
  const href = pageHref(page);
  return openSheet({ title: 'The computer\'s password', subtitle: 'Some steps need administrator rights (sudo).' }, (close) => [
    h('p.sheet-text', `The password is asked only on ${label}'s own page, because the connection from this dashboard to ${label} is not encrypted.`),
    href ? h('p.sheet-text', h('a', { href, target: '_blank', rel: 'noopener' }, `Open ${label}'s own page`)) : null,
    h('div.sheet-actions', h('button.btn.primary', { type: 'button', onclick: () => close(null) }, 'OK')),
  ]);
}

/** The computer whose screen is open, as this dashboard knows it: { label, url, encrypted }, or null for this one. */
async function openComputer() {
  if (!machine.current) return null;
  try {
    const r = await api('~/api/machines');
    const m = (r.machines || []).find((x) => x.name === machine.current);
    return m ? { label: m.label || m.name, url: m.url || null, encrypted: m.encrypted !== false } : { label: machine.current, url: null, encrypted: false };
  } catch {
    return { label: machine.current, url: null, encrypted: false };
  }
}

/**
 * Start a setup job with POST `path` (`body`: { kits } | { id } | { text | url }). Asks for the password when the
 * server says sudo needs it (again after a wrong one), offers the terminal when a step needs a person. `started()`
 * is called once the job runs. Resolves true when something started (a job or a terminal session).
 */
export async function startSetup(path, body, { started = () => {} } = {}) {
  let extra = {};
  for (;;) {
    let r;
    try {
      r = await api(path, { ...body, ...extra });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'plain-leg') {
        const c = await openComputer();
        await plainLegSheet({ label: c ? c.label : undefined, page: e.data.page || (c && c.url) });
        return false;
      }
      toast(e, { kind: 'error', ms: 7000 });
      return false;
    }
    if (r.started) {
      started();
      return true;
    }
    if (r.session) {
      location.hash = link(`#/s/${encodeURIComponent(r.session)}`);
      return true;
    }
    if (r.needsTerminal) {
      const ok = await confirmSheet({ title: 'This needs you at the computer', text: `${r.why}. It runs in a terminal session, where you can follow it and answer.`, ok: 'Open the terminal' });
      if (!ok) return false;
      extra = { terminal: true };
      continue;
    }
    if (r.needsPassword && r.notAllowed) {
      toast('This account may not use administrator rights (sudo) on this computer. Ask whoever runs it, or install as root.', { kind: 'error', ms: 9000 });
      return false;
    }
    if (r.needsPassword) {
      // Another computer over a plain leg: no password field, only where to type it (its own page).
      const c = await openComputer();
      if (r.plainLeg || (c && !c.encrypted)) {
        await plainLegSheet({ label: c ? c.label : undefined, page: c && c.url });
        return false;
      }
      const pw = await passwordSheet({ wrong: r.wrong === true });
      if (pw === null) return false;
      extra = pw === 'terminal' ? { terminal: true } : { password: pw };
      continue;
    }
    return false;
  }
}

/**
 * A download's progress from the job's output: the newest line pc setup writes for a step Hoprig runs itself
 * ("    <step>: 150 MB of about 1.5 GB", src/pcsetup/devinstall.mjs progressWords) → "150 MB of about 1.5 GB", or null.
 */
export function progressOf(lines, label) {
  if (!label) return null;
  let got = null;
  for (const l of lines) {
    if (!l.startsWith(`    ${label}: `)) continue;
    const rest = l.slice(label.length + 6);
    if (/^\d[\d.]* (bytes|kB|MB|GB)( of about \d[\d.]* (bytes|kB|MB|GB))?$/.test(rest)) got = rest;
  }
  return got;
}

/** A failed step Hoprig ran itself (a checked download): what went wrong and what to do, in one plain sentence. */
export function stepFailWords(s) {
  if (!s || s.state !== 'fail' || !s.why) return null;
  const why = String(s.why).replace(/[.\s]+$/, '');
  return `${s.label[0].toUpperCase()}${s.label.slice(1)} did not work: ${why}. ${s.todo ? s.todo : 'Nothing was put in its place; run it again later.'}`;
}

/** One step row: its mark, what it does, the command; a download's progress while it runs, why it failed after. */
const stepRow = (s, progress = null) => h('div.row.static.sj-step',
  h(`span.sj-mark.${MARK_CLASS[s.state] || 'info'}`, { 'aria-label': MARK_LABEL[s.state] || s.state }, MARK[s.state] || '·'),
  h('span.row-main', h('span.row-title', s.label), h('span.row-sub.mono.sj-cmd', s.command),
    s.inside && s.state === 'running' && progress ? h('span.row-sub.sj-progress', { role: 'status' }, `Downloaded ${progress}`) : null,
    stepFailWords(s) ? h('span.row-sub.sj-why', { style: { whiteSpace: 'normal', color: 'var(--danger)' } }, stepFailWords(s)) : null));

/**
 * The job's card on Setup. Finds a running (or just finished) setup job by itself, so it shows again when the owner
 * comes back. `onEnd(result)`: the job ended while the card watched it (Setup checks again). Returns { el, start }.
 */
export function setupJobCard({ onEnd = () => {} } = {}) {
  const el = h('section.card.panel.sj-card', { hidden: true, 'aria-label': 'Setup job' });
  const title = h('h2.panel-title');
  const state = h('div.sj-state', { role: 'status' });
  const steps = h('div.rows.sj-steps');
  const out = h('pre.output.sj-out', { 'aria-live': 'off' });
  const actions = h('div.savebar.start');
  fill(el, h('div.panel-head', h('span.panel-icon', icon('download')), h('div', title)), state, steps, out, actions);
  let from = 0;
  let id = null; // the job's startedAt: a new job starts the output again
  let watched = false; // seen running here: its end checks again
  let timer = null;
  let polls = 0;
  let inFlight = false; // one request at a time: start() during a poll asks again after it, never a second loop
  let again = false;
  const progress = new Map(); // a step's label → its download's newest progress ("150 MB of about 1.5 GB")

  const hide = () => {
    el.hidden = true;
    clearTimeout(timer);
  };

  function draw(j) {
    el.hidden = false;
    const tool = j.kind === 'tool' && j.data && j.data.name ? j.data : null; // a coding tool: named, not "a coding tool"
    fill(title, tool ? `Installing ${tool.name}` : TITLE[j.kind] || 'Setup');
    // The running step Hoprig runs itself shows how far its download is, from the newest output line that says so.
    fill(steps, (j.steps || []).filter(Boolean).map((s) => stepRow(s, s.inside && s.state === 'running' ? progress.get(s.label) || null : null)));
    if (j.running) fill(state, h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Running. You can leave this page: it goes on, and shows here again.')));
    else if (j.result && j.result.ok && j.result.data && j.result.data.missing && j.result.data.missing.length) {
      fill(state, h('div.banner.warn', icon('alert', { size: 18 }), h('span', `Finished. Still to do: ${j.result.data.missing.join(', ')}. Check again shows what each needs.`)));
    } else if (j.result && j.result.ok && tool) {
      fill(state, okBox(`${tool.name}${tool.version ? ` ${tool.version}` : ''} is installed and turned on. `, h('a', { href: link('#/settings/new-sessions?show=coding-tools') }, 'Settings → New sessions → Coding tools'), ' says how to start a session.'));
    } else if (j.result && j.result.ok) fill(state, okBox('Done. Everything chosen is installed.'));
    else fill(state, errorBox((j.result && j.result.error) || 'Something did not work: see the steps and the output below.'));
    fill(actions, j.running ? null : [
      btn('primary', { icon: 'refresh', label: 'Check again', onclick: () => { hide(); onEnd(j.result); } }),
      btn('ghost', { label: 'Close', onclick: hide }),
    ]);
  }

  async function poll() {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    try {
      await pollOnce();
    } finally {
      inFlight = false;
      if (again) {
        again = false;
        poll();
      }
    }
  }

  async function pollOnce() {
    clearTimeout(timer);
    // Setup was drawn again or left: this card stops (a new one follows the job).
    if (polls++ > 0 && !el.isConnected) return;
    let j;
    try {
      j = await api(`/api/pcsetup/job?from=${from}`);
    } catch {
      timer = setTimeout(poll, 3000);
      return;
    }
    if (!SETUP_KINDS.includes(j.kind) || (!j.running && !watched && !(j.endedAgo !== null && j.endedAgo < RECENT_MS))) return hide();
    if (j.startedAt !== id) {
      // Another job than the one shown: from its first line.
      id = j.startedAt;
      from = 0;
      progress.clear();
      fill(out);
      if (j.lines.length && j.next !== j.lines.length) {
        again = true;
        return;
      }
    }
    for (const st of (j.steps || []).filter((x) => x && x.inside)) {
      const p = progressOf(j.lines, st.label);
      if (p) progress.set(st.label, p);
    }
    if (j.lines.length) {
      const end = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
      add(out, `${j.lines.join('\n')}\n`);
      if (end) out.scrollTop = out.scrollHeight;
    }
    from = j.next;
    draw(j);
    if (j.running) {
      watched = true;
      timer = setTimeout(poll, 800);
    } else if (watched) {
      watched = false;
      onEnd(j.result);
    }
  }

  poll();
  return {
    el,
    /** A job was just started from this page: follow it from its first line. */
    start() {
      watched = true;
      id = null;
      poll().then(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    },
  };
}
