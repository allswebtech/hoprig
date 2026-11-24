// Settings → Work → "Another program" (src/work/accessfeature.mjs): Work tokens a script or another product uses to add
// tasks and read their results, webhooks that tell it when such a task is done, has a result or needs you, and the
// limits per token. Making a token or a webhook asks first (the server's question, then `confirmed: true`, as
// gatewaydefine.js does); the token and a webhook's secret are shown once, in a sheet of their own.
import { api, btn, confirmSheet, copyText, fill, h, openSheet, toast } from './lib.js';
import { errorBox, field, panel, saveBar } from './shell.js';

const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

/**
 * The one showing of a token or a secret: copy it now, it is not shown again. It closes only with "I have copied it"
 * (no X, no Escape, no tap beside it): one stray key or tap must not lose it without a word.
 */
export function shownOnce({ title, what, value, after }) {
  return openSheet({ title, keep: true }, (close) => [
    h('p.sheet-text', `Copy ${what} now. It is shown only this once: Hoprig keeps no copy it could show again. This closes with "I have copied it".`),
    h('pre.output.wk-secret', { tabindex: '0', 'aria-label': what }, value),
    after ? h('p.sheet-text', after) : null,
    h('div.sheet-actions',
      btn('secondary', { icon: 'copy', label: 'Copy', onclick: async () => toast((await copyText(value)) ? 'Copied' : 'Select it and copy it by hand') }),
      h('button.btn.primary', { type: 'button', onclick: () => close(true) }, 'I have copied it')),
  ]);
}

/** The server's question in a sheet: → true on the owner's yes. */
const ask = (title, text, ok) => confirmSheet({ title, text, ok });

function tokenSheet(done) {
  return openSheet({ title: 'New Work token' }, (close) => {
    const name = h('input.field', { maxlength: 60, placeholder: 'Shop script', autocomplete: 'off' });
    const msg = h('p.form-error', { role: 'alert' });
    const go = h('button.btn.primary', { type: 'submit' }, 'Next');
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      go.disabled = true;
      try {
        const q = await api('/api/work/access/tokens', { name: name.value.trim() });
        close(null);
        if (!(await ask(`Make the token "${name.value.trim()}"?`, q.confirm, 'Make it'))) return;
        const r = await api('/api/work/access/tokens', { name: name.value.trim(), confirmed: true });
        await shownOnce({ title: `The token ${r.token.name}`, what: 'this token', value: r.secret, after: 'The program sends it as the header "Authorization: Bearer <token>". Revoke it here when the program no longer needs it.' });
        done();
      } catch (err) {
        msg.textContent = err.message;
        go.disabled = false;
      }
    } },
    field('Name', name, 'What the program is, so you know the token again: its tasks carry this name.'),
    msg,
    h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), go));
    setTimeout(() => name.focus(), 0);
    return [form];
  });
}

function webhookSheet(data, done) {
  return openSheet({ title: 'New webhook' }, (close) => {
    const token = h('select.field', data.tokens.map((t) => h('option', { value: t.id }, t.name)));
    const url = h('input.field.mono', { type: 'url', placeholder: 'https://hooks.example.com/hoprig', autocapitalize: 'off', spellcheck: 'false' });
    // Inside the legend's sentence: "Tell it when a task … is done".
    const PHRASE = { done: 'is done', result: 'has its result ready', 'needs-you': 'needs you (it waits for you, or its session stopped)' };
    const events = data.events.map((e) => ({ id: e.id, box: h('input', { type: 'checkbox', checked: e.id === 'result' }), words: PHRASE[e.id] || e.words }));
    const own = h('input', { type: 'checkbox' });
    const answer = h('input', { type: 'checkbox' });
    const check = (box, label, hint) => h('label.wk-check-row', box, h('span', h('span', label), hint ? h('span.hint', hint) : null));
    const msg = h('p.form-error', { role: 'alert' });
    const go = h('button.btn.primary', { type: 'submit' }, 'Next');
    const body = () => ({ token: token.value, url: url.value.trim(), events: events.filter((e) => e.box.checked).map((e) => e.id), ownNetwork: own.checked, answer: answer.checked });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      go.disabled = true;
      try {
        const b = body();
        const q = await api('/api/work/access/webhooks', b);
        close(null);
        if (!(await ask(`Send to ${q.url}?`, q.confirm, 'Add the webhook'))) return;
        const r = await api('/api/work/access/webhooks', { ...b, confirmed: true });
        await shownOnce({ title: 'The webhook\'s secret', what: 'this secret', value: r.secret, after: 'Each delivery is signed with it: X-Hoprig-Signature is sha256= and the HMAC-SHA256 of the X-Hoprig-Timestamp, a dot and the body. Docs: docs/WORK.md, "Another program".' });
        done();
      } catch (err) {
        msg.textContent = err.message;
        go.disabled = false;
      }
    } },
    field('For the tasks of', token, 'A webhook is told only about the tasks this token added.'),
    field('Address', url, 'https. Plain http only to this computer itself.'),
    h('fieldset.wk-events', h('legend.field-label', 'Tell it when a task of that token'), events.map((e) => check(e.box, e.words))),
    check(own, 'On my own network', 'Lets it go to this computer or a private network address (a NAS, a box at home). Off: only public addresses.'),
    check(answer, 'Send the answer too', 'Puts the session\'s answer in "result ready". Off: the program reads it with its token.'),
    msg,
    h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), go));
    setTimeout(() => url.focus(), 0);
    return [form];
  });
}

/** The panel itself; it reloads its own list after each change. */
export function accessPanel() {
  const slot = h('div.wk-access', h('p.hint', 'Loading…'));
  // `focusOn` ("token" or "webhook"): the New button that gets the focus back after a change (the one that had it is
  // gone with the list it was in).
  const load = (focusOn = null) => api('/api/work/access').then((d) => {
    fill(slot, ...parts(d));
    const lost = !document.activeElement || document.activeElement === document.body;
    if (focusOn && lost) slot.querySelector(`[data-focus="${focusOn}"]`)?.focus();
  }, (e) => fill(slot, errorBox(e, () => load())));
  function parts(d) {
    const tokens = d.tokens.length
      ? h('div.rows', d.tokens.map((t) => h('div.row.static.wk-token',
        h('div.wk-main', h('strong', t.name), h('div.wk-sub', h('span', `Made ${when(t.created)}`), h('span', `Last used ${when(t.lastUsed)}`))),
        btn('secondary small', { label: 'Revoke', title: `Revoke the token ${t.name}`, onclick: async () => {
          if (!(await confirmSheet({ title: `Revoke ${t.name}?`, text: `A program that has this token is refused from now on, and its webhooks are removed. This cannot be undone: a new token is a new one to copy. Its tasks stay in your list, with its name.`, ok: 'Revoke', danger: true }))) return;
          try {
            await api('/api/work/access/tokens/revoke', { id: t.id });
            toast(`Revoked ${t.name}`);
          } catch (e) {
            toast(e, { kind: 'error' });
          }
          load('token');
        } }))))
      : h('p.hint', 'No tokens yet.');
    const hooks = d.webhooks.length
      ? h('div.rows', d.webhooks.map((w) => h('div.row.static.wk-token',
        h('div.wk-main', h('strong.mono.wk-url', w.url), h('div.wk-sub',
          h('span', `For ${w.tokenName}`), h('span', w.events.map((e) => (d.events.find((x) => x.id === e) || {}).words || e).join(', ')),
          w.ownNetwork ? h('span', 'On my own network') : null, w.answer ? h('span', 'Sends the answer') : null)),
        btn('secondary small', { label: 'Remove', title: `Remove the webhook to ${w.url}`, onclick: async () => {
          if (!(await confirmSheet({ title: 'Remove this webhook?', text: `Nothing more is sent to ${w.url}.`, ok: 'Remove', danger: true }))) return;
          await api('/api/work/access/webhooks/remove', { id: w.id }).catch((e) => toast(e, { kind: 'error' }));
          load('webhook');
        } }))))
      : h('p.hint', d.tokens.length ? 'No webhooks yet.' : 'A webhook goes with a token (the other program\'s key): make a token first.');
    const lim = { ...d.limits };
    const num = (k, max) => h('input.field.wk-num', { type: 'number', min: 1, max, step: 1, value: lim[k], oninput: (e) => (lim[k] = Number(e.target.value)) });
    return [
      h('h3.wk-sub-head', 'Tokens'),
      tokens,
      h('div.btnrow', btn('primary', { icon: 'plus', label: 'New token', dataset: { focus: 'token' }, onclick: () => tokenSheet(() => load('token')) })),
      h('h3.wk-sub-head', 'Webhooks'),
      h('p.hint', 'A webhook is a web address of another program: Hoprig sends it a message when one of its tasks is done, has its result or needs you. A token is the key that program uses to reach Hoprig.'),
      hooks,
      h('div.btnrow', btn('secondary', { icon: 'plus', label: 'New webhook', disabled: !d.tokens.length, dataset: { focus: 'webhook' }, onclick: () => webhookSheet(d, () => load('webhook')) })),
      h('h3.wk-sub-head', 'Limits per token'),
      h('div.wk-limits',
        field('Requests a minute', num('perMinute', 10000), 'Past it a request is refused for the rest of that minute.'),
        field('Tasks a day', num('perDay', 100000), 'Past it no more tasks are added until midnight.')),
      saveBar('Save the limits', () => api('/api/work/access/limits', { perMinute: lim.perMinute, perDay: lim.perDay })),
    ];
  }
  load();
  return panel({ icon: 'key', title: 'Another program', desc: 'A token lets a script or another product add tasks and read the tasks it added and their results, nothing else. Its tasks start only when you start them.' }, slot);
}
