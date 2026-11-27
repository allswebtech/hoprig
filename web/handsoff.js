// What waits for the owner, as the coding tool said it (src/askcard.mjs), and Hands-off on the page: its switch, its
// stop, and the line for each answer it gave ("Answered by Hoprig: …, because the tool recommended it").
import { icon } from './icons.js';
import { ago, api, h, openSheet, prefs, toast } from './lib.js';

/** Why an answer was given for him, in his words (src/handsoff.mjs BECAUSE). */
export const BECAUSE = {
  recommended: 'because the tool recommended it',
  note: 'from your note for this project',
  plan: '', // the plan's line says the mode itself
};

/** One answer in a line: "Which runner? → npm (Recommended), because the tool recommended it". */
export const answerLine = (d) => `${d.question ? `${d.question} → ` : ''}${d.text}${BECAUSE[d.because] ? `, ${BECAUSE[d.because]}` : ''}`;

/** Why Hands-off left an ask to him (handsWait), in a sentence, or ''. */
export function waitWords(why) {
  if (!why) return '';
  if (why.startsWith('owner:')) return `Hands-off leaves this to you: it is about ${why.slice(6).replace('wider mode', 'widening what the session may do').replace('push or merge', 'a push or a merge').replace('send out', 'sending something out').replace('delete outside', 'a delete outside the folder').replace('safety off', 'switching a safety rule off')}.`;
  return {
    'no-mark': 'Hands-off leaves this to you: the tool marked no option as recommended and the project has no note.',
    'no-free-text': 'Hands-off leaves this to you: the tool takes no written answer here, so your note cannot be given.',
    secret: 'Hands-off leaves this to you: its words hold something that looks like a secret.',
    'too-long': 'Hands-off leaves this to you: it is longer than the card shows, so Hoprig did not read all of it.',
    'plan-terminal': 'Hands-off leaves this to you: in a terminal the plan is approved on the screen.',
    loop: 'Hands-off stopped: it answered three times in a row with no work between. Turn it on again when you want it back.',
    hour: 'Hands-off stopped: it answered ten times within an hour. Turn it on again when you want it back.',
    notice: '',
    permission: '',
  }[why] || '';
}

/**
 * The exact card of a question or a plan (askCard of the session or chat): every question with its options in the
 * tool's order, each with its description, the one the tool marked, one answer or several, and where it came from.
 * Answers stay where the tool takes them (the terminal below); this shows what is asked.
 */
export function exactCard(card) {
  if (!card || typeof card !== 'object') return null;
  const from = h('p.ho-from', card.source === 'screen' ? 'Read from the screen' : card.source === 'hook' ? 'As Claude Code asked it' : 'As the coding tool asked it');
  if (card.kind === 'question') {
    return h('div.ho-card', card.questions.map((q) => h('div.ho-q',
      h('p.ho-q-text', q.header ? h('span.badge', q.header) : null, ' ', h('span', q.question)),
      h('p.ho-q-how', q.multiSelect ? 'Choose any' : 'Choose one', q.freeText ? ', or write your own answer' : ''),
      h('ol.ho-opts', q.options.map((o, i) => h(`li.ho-opt${q.recommended === i ? '.ho-rec' : ''}`,
        h('span.ho-opt-label', o.label), q.recommended === i ? h('span.badge.soft', 'Marked by the tool') : null,
        o.description ? h('span.ho-opt-sub', o.description) : null))))),
    card.less ? h('p.ho-from', card.less) : null, from);
  }
  if (card.kind === 'plan') return h('div.ho-card', h('pre.ho-plan', card.plan || '(no plan text)'), from);
  if (card.kind === 'notice') {
    // The tool's own lines as drawn: the folder, the question, what it will be able to do, the answers in their order.
    const n = card.notice || {};
    return h('div.ho-card',
      n.folder ? h('p.ho-q-text', h('span.badge', 'Folder'), ' ', h('code', n.folder)) : null,
      h('p', n.text || ''), n.detail ? h('p.ho-opt-sub', n.detail) : null,
      // Not a numbered list of the page's own: a number is shown only where the screen gave the answer one (notice.keys),
      // so the card never names a key the terminal does not have.
      Array.isArray(n.answers) && n.answers.length ? h('ul.ho-opts', { style: { listStyle: 'none', paddingLeft: '0' } }, n.answers.map((a, i) => {
        const k = Array.isArray(n.keys) && /^\d$/.test(String(n.keys[i] || '')) ? n.keys[i] : '';
        return h('li.ho-opt', k ? h('span.ho-opt-key', `${k}. `) : null, h('span.ho-opt-label', a));
      })) : null, from);
  }
  return null;
}

/**
 * The card of an act the wall held (the session card's `held`, src/askcard.mjs heldCard), for a reader who is not a
 * programmer: which of his acts it is, what the session wanted to run (the held part, whole or plainly cut, and "part
 * of a longer command" when it is one), why it is his, and what each answer does.
 */
export function heldActCard(held) {
  if (!held || typeof held !== 'object' || typeof held.what !== 'string') return null;
  // One Allow runs the whole command, so a line with more than one of his acts lists them all: the owner sees each
  // before deciding, and no act is hidden behind the one shown first.
  if (Array.isArray(held.acts) && held.acts.length > 1) {
    // The list scrolls inside its own box (page-session.css .ho-held-acts), so however many acts there are, the answers
    // below it and the buttons stay inside the window: the session page itself does not scroll.
    return h('div.ho-card.ho-held',
      h('p.ho-held-title', h('strong', `This command does ${Number.isInteger(held.count) ? held.count : held.acts.length} things that are yours:`)),
      h('div.ho-held-acts', { tabindex: '0', role: 'region', 'aria-label': 'The acts that are yours' },
        ...held.acts.map((a) => h('div.ho-held-act',
          h('p.ho-held-label', h('strong', a.title || 'An act that is yours')),
          h('pre.ho-held-what', a.what, a.more > 0 ? h('span.ho-held-more', ` … (${a.more} more characters)`) : null),
          h('p.ho-held-why', a.reason || ''))),
        held.notListed > 0 ? h('p.ho-held-label', `And ${held.notListed} more that are yours, not listed here. Look at the whole command in the terminal before you allow it.`) : null),
      h('ul.ho-held-answers', h('li', held.yes || ''), h('li', held.no || '')),
      h('p.ho-from', 'Held by Hoprig before it ran'));
  }
  const asked = held.file ? 'The session wants to create or change this file:' : held.partOf ? 'The session wants to run this, as part of a longer command:' : 'The session wants to run this:';
  return h('div.ho-card.ho-held',
    h('p.ho-held-title', h('strong', held.title || 'An act that is yours')),
    h('p.ho-held-label', asked),
    h('pre.ho-held-what', held.what, held.more > 0 ? h('span.ho-held-more', ` … (${held.more} more characters)`) : null),
    h('p.ho-held-why', held.reason || ''),
    h('ul.ho-held-answers', h('li', held.yes || ''), h('li', held.no || '')),
    h('p.ho-from', 'Held by Hoprig before it ran'));
}

/**
 * The line about the sessions a project's switch cannot cover (the view's `uncovered`, src/server/handsoff.mjs): it
 * stays on the page while they run, read again with the project. null when there are none.
 */
export function uncoveredLine(names, { linked = true } = {}) {
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n) : [];
  if (!list.length) return null;
  const one = list.length === 1;
  // Each name leads to its session page, where the owner can start it again (linked off on that page itself).
  const parts = [];
  list.forEach((n, i) => {
    if (i) parts.push(', ');
    parts.push(linked ? h('a', { href: `#/s/${encodeURIComponent(n)}` }, n) : n);
  });
  return h('p.ho-uncovered', { role: 'status' }, icon('alert', { size: 16 }),
    h('span',
      `${one ? 'This session started' : 'These sessions started'} before Hands-off could hold commands: `, ...parts,
      `. Hands-off answers ${one ? 'its' : 'their'} questions, but commands such as a push or a release are not held for ${one ? 'it' : 'them'}. Start ${one ? 'it' : 'them'} again to have them held.`));
}

/**
 * The answers Hands-off gave: the newest in one line with its time ("Answered by Hoprig 12 min ago: …"), the earlier
 * ones (the record keeps five) when the line is opened. o: { askAt (when the ask that waits now came: an answer
 * older than it is about something else, so the line is dimmed and says so), onToggle }.
 */
export function answeredLines(done, { askAt = 0, onToggle = null } = {}) {
  const list = Array.isArray(done) ? done.filter((d) => d && d.text) : [];
  if (!list.length) return null;
  const newest = list[list.length - 1];
  const when = (d) => (Number(d.at) > 0 ? ` ${ago(Number(d.at))}` : '');
  const older = Number(askAt) > 0 && Number(newest.at) > 0 && Number(askAt) > Number(newest.at);
  const head = h('span', h('strong', `Answered by Hoprig${when(newest)}: `), answerLine(newest), older ? h('span.ho-older-why', ' (before the question above, which waits for you)') : null);
  const cls = `ho-done${older ? '.ho-older' : ''}`;
  const earlier = list.slice(0, -1).reverse();
  if (!earlier.length) return h(`p.${cls}`, { role: 'status' }, icon('check', { size: 14 }), head);
  return h(`details.${cls}`, { role: 'status', ontoggle: () => onToggle?.() },
    h('summary', icon('check', { size: 14 }), head),
    h('ul', earlier.map((d) => h('li', `${answerLine(d)}${when(d) ? ` ·${when(d)}` : ''}`))));
}

// After a press the page draws the bar anew (its state changed): the keyboard focus goes to the new bar's button, not
// to the page's body, so "Turn on" again is one Enter away. Only for a bar drawn soon after the press.
let focusUntil = 0;

/**
 * The switch for one session: "Hands-off: on · Stop" or "Hands-off: off · Turn on". `state`: { on, stale, loop, own };
 * `post(on)` sends it. One press stops it at once.
 */
export function handsOffBar(state, post, after, { app = false } = {}) {
  const st = state || {};
  // In the App it also approves a plan, keeping the mode; in a terminal a plan waits (src/hook.mjs handsOffFor).
  // While the wall still holds (the switch is on; a stop only ends the answers — hook.mjs preToolHold), say so: what
  // is his keeps waiting for him until he turns the switch off.
  const stillWaits = st.holding ? ' A push, a release or a delete it tries still waits for your OK.' : '';
  const words = st.on ? `Hands-off is on: Hoprig answers questions the tool marked as recommended, or with your note${app ? ', and approves plans, keeping the mode' : ''}.`
    : st.stopped === 'reset' ? `This session was continued from another, so Hands-off is off for it until you turn it on.${stillWaits}`
      : st.loop ? `${st.stopped === 'hour' ? 'Hands-off stopped answering after ten answers within an hour.' : 'Hands-off stopped answering after three answers in a row with no work between them.'} Turn it on again when you want it back.${stillWaits}`
        : st.stale ? 'Hands-off was turned off by the update; turn it on again.'
          : 'Hands-off is off.';
  const press = async (on) => {
    try {
      await post(on);
      focusUntil = Date.now() + 5000;
      toast(on ? 'Hands-off is on for this session' : 'Hands-off stopped for this session');
      after?.();
    } catch (e) {
      toast(e, { kind: 'error' });
    }
  };
  const button = st.on ? h('button.btn.small.secondary.danger-text', { type: 'button', onclick: () => press(false) }, icon('stop', { size: 14 }), h('span', 'Stop Hands-off'))
    : h('button.btn.small.ghost', { type: 'button', onclick: () => press(true) }, h('span', 'Turn on for this session'));
  if (focusUntil > Date.now()) {
    focusUntil = 0;
    setTimeout(() => button.isConnected !== false && button.focus(), 0); // once it is in the page
  }
  return h(`div.ho-bar${st.on ? '.ho-on' : ''}`, { role: 'group', 'aria-label': 'Hands-off' }, h('span.ho-bar-text', words), button);
}

// ---------- the first-time sheet (shown once per browser the first time a switch is turned on) ----------

// What stays the owner's in every case: `title` is the exact card title (src/wall.mjs WALL_TITLE), `plain` a short
// line for a non-programmer under it, since the titles alone are jargon. Every WALL_TITLE kind is listed, in its
// order, so nothing the wall holds is left off the sheet. A node test keeps the titles matching the code and every
// kind glossed (web-wallcard), so a new wall kind cannot go missing here or be shown without its plain line.
export const OWNER_ACTS = [
  { title: 'Administrator rights', plain: 'Anything that asks for your computer\'s administrator rights.' },
  { title: 'Publishing or a release', plain: 'Publishing your code or putting out a release for other people to install, or changing one that is already out.' },
  { title: 'A pull request', plain: 'Opening or merging a pull request — a request to add changes to a project\'s shared online copy.' },
  { title: 'A direct call to GitHub or GitLab', plain: 'Asking GitHub or GitLab directly to change something there, such as opening a pull request or deleting a branch, where Hoprig cannot tell what would change.' },
  { title: 'A push to the main branch or a tag', plain: 'Sending changes to the main line of a project\'s shared online copy, or marking a release there.' },
  { title: 'A push that deletes branches', plain: 'A send to the shared online copy that would delete branches from it.' },
  { title: 'A push Hoprig cannot place', plain: 'A send online where Hoprig cannot tell which project or branch it would change.' },
  { title: 'A push Hoprig cannot check', plain: 'A send online where Hoprig cannot tell the project\'s main line, so it checks with you.' },
  { title: 'A merge into the main branch', plain: 'Combining changes into a project\'s main line of work.' },
  { title: 'A merge Hoprig cannot place', plain: 'A merge where Hoprig cannot tell which project it would change.' },
  { title: 'A delete outside the session\'s folder', plain: 'Deleting files outside the folder the session is working in.' },
  { title: 'A deploy', plain: 'Running a script that deploys, releases or publishes.' },
  { title: 'A change to project.json', plain: 'Creating or changing the project\'s own settings file (project.json).' },
  { title: 'Hoprig\'s own files', plain: 'Changing Hoprig\'s own settings or the rules it runs the session under.' },
  { title: 'A command Hoprig cannot read', plain: 'A command Hoprig cannot read with certainty, so it asks you rather than guess.' },
];

/**
 * The content of the first-time sheet, for a person who is not a programmer: what Hands-off does, what stays theirs in
 * every case (OWNER_ACTS), what it costs, and how to stop it. `close` is the sheet's own close. Pure, so a test reads
 * its words. The one "Got it" button has the focus, so the sheet is read and dismissed with the keyboard alone.
 */
export function consentSheetBody(close) {
  return [
    h('p.sheet-text', 'Hands-off answers the questions your coding tool would put to you, picking the option the tool marks as recommended, so the work carries on instead of waiting for you. If the tool has not marked a recommended answer, it gives your note for the project (Settings → New sessions → Hands-off) as a written answer where the tool takes one; without a note that question still waits for you. A plan in the App is approved, and the session keeps the mode it had. A plan in a terminal waits for you.'),
    h('p.ho-consent-head', h('strong', 'These always stay yours. When Hoprig sees the session about to do one of these, it stops and asks you first:')),
    h('ul.ho-consent-acts', OWNER_ACTS.map((a) => h('li', h('strong.ho-consent-act', a.title), h('span.ho-consent-why', a.plain)))),
    h('p.sheet-text', 'Hoprig reads each command before it runs to catch these. It is careful, not perfect: a session that deliberately disguises a command could still slip one past it.'),
    h('p.sheet-text', 'It costs nothing by itself: the work goes on and spends what it would have spent if you had answered each question yourself.'),
    h('p.sheet-text', 'To stop it, use the same switch again. A single session also has its own Off on its page.'),
    h('div.sheet-actions', h('button.btn.primary', { type: 'button', autofocus: true, onclick: () => close?.() }, 'Got it')),
  ];
}

// Shown once per browser. The flag lives in this browser's own storage (prefs), which the brief allowed and which
// keeps the server out of it. So it is per browser on this computer, not per computer: a second browser or device
// shows the sheet again (harmless), and a browser where storage is blocked shows it on each turn-on (fail-safe: more
// consent, never less). A server-side per-computer flag would need config and a route, more than the gain. Take the
// flag and say whether this is the first time — a reload will not show the sheet again.
const CONSENT_SEEN = 'handsoff.firstSeen';
export const consentPending = (store = prefs) => !store.get(CONSENT_SEEN);
export function takeFirstConsent(store = prefs) {
  if (store.get(CONSENT_SEEN)) return false;
  store.set(CONSENT_SEEN, 1);
  return true;
}

/**
 * Open the first-time sheet. On turning a switch on it is shown once per browser (the switch's own press is the
 * consent; this only explains what it did, so it never blocks or undoes the press). `always`: open it again from
 * Settings' Hands-off page, without touching the flag. Returns the sheet's promise, or null when it is not shown.
 */
export function openConsentSheet({ always = false, store = prefs } = {}) {
  if (!always && !takeFirstConsent(store)) return null;
  return openSheet({ title: 'What Hands-off does', subtitle: 'What stays yours, and how to stop it' }, (close) => consentSheetBody(close));
}

