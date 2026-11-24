// New project's brief, kind, scope and "Start with AI" (projects.js draws the steps; src/pcsetup/newproject.mjs and
// newprojectstart.mjs do the work). The brief is the owner's own words: the server keeps it unchanged as docs/brief.md
// and sends it to the session as he wrote it; one with characters nobody can see is refused, and "Take them out" puts
// the brief without them back in the box. The kind is his hint (the AI's fit decides it from the brief); the scope is
// the whole product or the set-up only. Both show once there is a brief: without one they mean nothing. The session's
// choices are Work's "Do it" ones: the coding tool (when there is a choice), the provider, the model and the effort.
import { api, btn, fill, h, link } from './lib.js';
import { radioCards } from './shell.js';

const enc = encodeURIComponent;
const BRIEF_MAX = 24 * 1024; // bytes, as the server counts them
// The kinds of the skill, as the server has them (src/pcsetup/newproject.mjs KINDS; a test holds the two together):
// [id, label, what it means in plain words].
export const KINDS = [
  ['', 'Not sure, or a mix', 'The AI works the kind out from your brief and tells you what it read.'],
  ['website', 'A website', 'Pages anyone can open; nobody logs in.'],
  ['web-app', 'A web app with accounts', 'People log in and work with their own data.'],
  ['multi-tenant', 'A product for many businesses, or a marketplace', 'Each business or seller has its own data and users, like a booking site for many salons.'],
  ['internal', 'An internal tool', 'Only your own staff use it; nothing is public.'],
  ['api', 'An API or backend only', 'Other apps call it; it has no screens.'],
  ['mobile-first', 'A phone app first', 'The apps are the product; the web is their server, the admin area and a few pages.'],
  ['cli', 'A command-line tool', 'Used in a terminal.'],
  ['library', 'A library', 'A package other code uses.'],
  ['extension', 'A browser extension', 'It adds to the browser.'],
  ['desktop', 'A desktop app', 'Installed on a computer.'],
];
export const kindLabel = (id) => (KINDS.find(([k]) => k === id) || KINDS[0])[1];
export const SCOPES = [
  ['product', 'The whole product', 'It sets the project up, then builds everything your brief describes.'],
  ['setup', 'The set-up only', 'The structure, the documents and a foundation that builds and passes its checks. The features wait for a later session.'],
];

/**
 * Mark the chosen one of radioCards' cards in place (shell.js draws the mark once). Drawing the cards again on every
 * choice would take the keyboard's focus off the radio just chosen, to the top of the page.
 */
export const markCards = (cards, options, value) => [...cards.children].forEach((card, i) => card.classList.toggle('on', options[i].value === value));

const select = (label, value, options, onchange, cls = '') => h(`label.fieldrow${cls}`, h('span.field-label', label),
  h('select.field', { onchange: (e) => onchange(e.target.value) }, options.map(([val, text]) => h('option', { value: val, selected: val === (value ?? '') }, text))));

/**
 * The brief, the kind and the scope, for the first step. st: the page's state ({ brief, kind, scope }); it is kept as
 * typed. → { el, problem(message, clean), focus() } (problem: the server's refusal of the brief, said under it with
 * "Take them out"; focus: to the brief, the field to change after a refusal).
 */
export function briefFields(st) {
  const count = h('span.np-count');
  const box = h('textarea.field.np-brief', { rows: 7, placeholder: 'For example: A booking site for hair salons. Customers pick a time and pay online; each salon manages its own staff and calendar.', oninput: (e) => {
    st.brief = e.target.value;
    paintCount();
    more.hidden = !st.brief.trim();
  } });
  box.value = st.brief || '';
  const err = h('p.form-error', { role: 'alert' });
  const fix = h('div');
  function paintCount() {
    const n = new TextEncoder().encode(box.value).length;
    count.textContent = n > BRIEF_MAX * 0.8 ? `${Math.ceil(n / 1024)} of ${BRIEF_MAX / 1024} KiB` : '';
    count.classList.toggle('over', n > BRIEF_MAX);
  }
  paintCount();
  const problem = (message, clean) => {
    const offer = typeof clean === 'string' && clean.trim();
    // The server's sentence starts small (the command line prints it after a mark); here it starts a sentence.
    err.textContent = message ? `${message.replace(/^./, (ch) => ch.toUpperCase())}${offer ? '. "Take them out" does it for you.' : ''}` : '';
    fill(fix, offer ? btn('secondary', { label: 'Take them out', onclick: () => {
      box.value = clean;
      st.brief = clean;
      problem('', null);
      box.focus();
    } }) : null);
  };
  const kindSay = h('span.hint');
  const paintKind = () => (kindSay.textContent = (KINDS.find(([k]) => k === (st.kind || '')) || KINDS[0])[2]);
  paintKind();
  const scopeOpts = SCOPES.map(([value, title, sub]) => ({ value, title, sub }));
  const scopeBox = radioCards('np-scope', scopeOpts, st.scope || 'product', (v) => {
    st.scope = v;
    markCards(scopeBox, scopeOpts, v);
  });
  scopeBox.setAttribute('aria-labelledby', 'np-scope-label'); // the radio group's own name, read out with it
  // The kind and the scope belong to a brief: hidden until one is typed.
  const more = h('div.np-more', { hidden: !String(st.brief || '').trim() },
    h('label.fieldrow', h('span.field-label', 'What kind of project is it?'),
      h('select.field', { onchange: (e) => { st.kind = e.target.value; paintKind(); } }, KINDS.map(([val, text]) => h('option', { value: val, selected: val === (st.kind || '') }, text))),
      kindSay),
    h('div.fieldrow', h('span.field-label', { id: 'np-scope-label' }, 'What should the AI build?'), scopeBox));
  const el = h('div.np-fields',
    h('label.fieldrow', h('span.field-label', 'Brief (optional)'), box,
      h('span.hint.np-hint', h('span', 'What it is, who uses it, the main features. With a brief, the project keeps it as docs/brief.md, and an AI session can set the project up from it.'), count)),
    err, fix, more);
  return { el, problem, focus: () => box.focus(), tooBig: () => new TextEncoder().encode(box.value).length > BRIEF_MAX };
}

/**
 * "Start with AI" in the check step: a switch (on when there is a brief) and the session's choices, loaded from the
 * server for this project name. st: { name, start, choices, v }; changed(): a choice changed (the step's button says
 * what it will do). The switch stays where it is while the choices under it are drawn: drawing it again would take the
 * keyboard's focus off it.
 */
export function startPart(st, changed = () => {}) {
  const choices = h('div.np-start-choices');
  const toggle = h('input', { type: 'checkbox', checked: st.start, onchange: (e) => {
    st.start = e.target.checked;
    paint();
    changed();
  } });
  const box = h('div.np-start',
    h('label.np-switch', toggle, h('span', h('strong', 'Start with AI'), h('span.hint', ' — a session opens in the App. The AI reads your brief, works out what the project needs and sends you one message with its questions, each with a suggested answer. Reply there; "ok" takes its suggestions. Then it builds on its own, but it may still ask for your OK before it changes a file or runs a command (the session\'s settings decide; "Allow all edits in this session" stops it asking for edits).'))),
    choices);
  const paint = () => {
    const c = st.choices;
    const v = st.v;
    fill(choices,
      st.start && c ? h('div.wk-trio.np-choices',
        c.tools.length > 1 ? select('Coding tool', v.tool || c.tool, c.tools.map((x) => [x.id, x.name]), (x) => {
          st.v = { tool: x };
          load(x);
        }) : null,
        select('Provider', v.provider || c.provider || '', [...(c.provider ? [] : [['', 'Choose one']]), ...c.providers.map((x) => [x.name, x.label])], (x) => {
          v.provider = x;
          changed();
        }),
        select('Model', v.model || c.model || '', [['', c.model ? `Default (${c.model})` : 'Default'], ...c.models.filter((m) => m !== c.model).map((m) => [m, m])], (x) => (v.model = x || null)),
        select('Effort', v.effort || c.effort || '', [['', c.effort ? `Default (${c.effort})` : 'Default'], ...c.efforts.filter((x) => x !== c.effort).map((x) => [x, x])], (x) => (v.effort = x || null))) : null,
      st.start && st.choicesError ? h('p.form-error', { role: 'alert' }, st.choicesError) : null,
      st.start && c && !c.provider && !c.providers.length ? h('p.form-error', { role: 'alert' }, 'There is no provider for this coding tool yet: add one under ', providersLink(), ' first. The project can be made now and started later.') : null,
      st.start && c && !v.provider && !c.provider && c.providers.length ? h('p.hint', 'Choose a provider to start the session with the project.') : null);
  };
  async function load(tool) {
    try {
      st.choices = await api(`/api/pcsetup/project/start?${new URLSearchParams({ name: st.name, ...(tool ? { tool } : {}) })}`);
      st.choicesError = '';
    } catch (e) {
      st.choicesError = `The session's choices could not be loaded: ${e.message}`;
    }
    paint();
    changed();
  }
  paint();
  if (!st.choices) load(st.v.tool);
  return box;
}

/** Focus what `sel` finds once the page that was gone to has drawn it (within a few seconds). */
function focusOnArrival(sel, ms = 4000) {
  const end = Date.now() + ms;
  const look = () => {
    const el = typeof document.querySelector === 'function' ? document.querySelector(sel) : null;
    if (el) el.focus();
    else if (Date.now() < end) setTimeout(look, 100);
  };
  setTimeout(look, 0);
}

const providersLink = () => h('a', { href: link('#/providers') }, 'Providers');

/**
 * Whether "Start with AI" can start: its choices are not loaded yet (the server decides), or a provider is chosen or
 * is the folder's default. Without one the step's button only makes the project.
 */
export const aiReady = (st) => !st.choices || Boolean((st.v && st.v.provider) || st.choices.provider);

/** Open the session for the project just made, and go to it. → resolves when it is open (throws with the reason). */
export async function startSession(st, m) {
  const v = st.v || {};
  const c = st.choices || {};
  const body = { name: st.name, ...(st.kind ? { kind: st.kind } : {}), scope: st.scope || 'product', ...(v.tool ? { tool: v.tool } : {}),
    ...(v.provider || c.provider ? { provider: v.provider || c.provider } : {}), ...(v.model ? { model: v.model } : {}), ...(v.effort ? { effort: v.effort } : {}) };
  let r;
  try {
    r = await api('/api/pcsetup/project/start', body);
  } catch (e) {
    // A session for it is open already (a second press, or one whose first message did not go): go to that one, never
    // a second session setting up the same folder.
    if (!['started', 'not-sent'].includes(e.code) || !e.data || typeof e.data.chat !== 'string') throw e;
    r = { chat: e.data.chat };
  }
  location.hash = link(`#/chat/${enc(r.chat)}`, m);
  focusOnArrival('textarea.chat-input'); // where he answers the session's one message
  return r;
}

/**
 * The done step when the session could not start: the reason (the server's sentence, which the page's request made
 * start with a capital, goes on the sentence here), a link to Providers when one is missing, and the button to try
 * again: the step's one main button.
 */
export const startFailed = (err, retry) => h('div.np-failed',
  h('p.form-error', { role: 'alert' }, 'The project is ready, but the session did not start: ', err.code === 'no-provider'
    ? ['there is no provider for this coding tool yet. Add one under ', providersLink(), ', then try again.']
    : `${String(err.message || err).replace(/^./, (ch) => ch.toLowerCase())}.`.replace(/\.\.$/, '.')),
  btn('primary', { icon: 'play', label: 'Start with AI', onclick: retry }));

/**
 * What the done step shows under a project made with a brief whose session did not start: the reason when a start
 * failed (err), else that it has not started (he switched "Start with AI" off, or no provider was ready), with the
 * button that starts it now. → the element; the button goes to the session, or shows why it could not.
 */
export function startLater(st, m, err = null) {
  const holder = h('div.np-later');
  const go = async () => {
    try {
      await startSession(st, m);
    } catch (x) {
      show(x);
    }
  };
  const show = (e) => fill(holder, e ? startFailed(e, go) : [
    h('p.hint', 'The project keeps your brief and the new-project skill. Its AI session has not started yet: start it now, or later with ', h('code', `hoprig project start ${st.name}`), '.'),
    btn('primary', { icon: 'play', label: 'Start with AI', onclick: go }),
  ]);
  show(err);
  return holder;
}

/** The lines "What it creates" adds for a brief: the skill and the brief (a project without a brief gets neither). */
export const willLines = (st) => (!st.brief || !st.brief.trim() ? [] : [
  h('li', 'The new-project skill (in .claude/skills), which every coding tool that opens the project finds: how to set a project up from a brief.'),
  h('li', 'Your brief, kept exactly as you wrote it, as ', h('strong', 'docs/brief.md'), ', and in decisions.md ', st.kind ? `your hint for the kind ("${kindLabel(st.kind)}") and ` : '', `what the AI builds (${(SCOPES.find(([k]) => k === (st.scope || 'product')) || SCOPES[0])[1].replace(/^The /, '')}).`),
]);

