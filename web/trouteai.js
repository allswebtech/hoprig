// Providers → TRouteAI: the accounts TRouteAI holds, with their limits, and the few things a person does with them:
// test, turn off, remove, Add (a pasted key, a code with its link, a link and the address pasted back), its combos, the
// keys Hoprig made in it, and its own page opened signed in. Every press goes to this computer's own routes
// (/api/gatewayhost/trouteai/…, src/addons/gatewaymanage.mjs): a key typed here goes to this dashboard once and from it to
// TRouteAI on the same computer, and is never shown again. Shown on this dashboard's own page only, and only once
// TRouteAI is installed. A look happens when the panel opens or a person presses; nothing polls except a sign-in code's
// sheet, while it is open.
import { icon } from './icons.js';
import { ago, api, btn, confirmSheet, fill, h, openSheet, toast, until } from './lib.js';
import { errorBox, field, fold, panel, skeletonRows } from './shell.js';
import { gatewayPageLink } from './gateways.js';

const T = (p) => `~/api/gatewayhost/trouteai${p}`;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];
const STATE_WORDS = { ok: 'Works', off: 'Turned off', limited: 'Limit reached', error: 'Needs attention', new: 'Not tested yet' };

/** A window's name as a person reads it ("window5h" → "5h window"). */
export function windowLabel(name) {
  const n = String(name || '').replace(/[_-]+/g, ' ').trim();
  const m = /^window ?(\d+\s?[a-z]*)$/i.exec(n);
  if (m) return `${m[1].replace(/\s+/g, '')} window`;
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** One quota window: its name, how much is left, and when it starts again. */
export function limitLine(w) {
  const left = w.percentLeft === null || w.percentLeft === undefined ? null : w.percentLeft;
  return h('div.tr-win',
    h('span.tr-win-name', windowLabel(w.name)),
    left === null ? null : h('span.tr-bar', { role: 'img', 'aria-label': `${left}% left` }, h('i', { style: { width: `${left}%` } })),
    h('span.tr-win-text', [left === null ? 'no figure' : `${left}% left`, w.resetsAt ? `starts again ${until(w.resetsAt)}` : null].filter(Boolean).join(' · ')));
}

const say = (e) => toast(e, { kind: 'error', ms: 9000 });

/** Open TRouteAI's own page: its one-time sign-in link where this page is on that computer, else the plain address. */
export async function openGatewayPage(state) {
  const onThatComputer = LOOPBACK.includes(location.hostname);
  if (onThatComputer) {
    try {
      const r = await api(T('/open'), { confirm: state.computer });
      if (r.url) {
        window.open(r.url, '_blank', 'noopener,noreferrer');
        return;
      }
    } catch (e) {
      return say(e);
    }
  }
  const l = gatewayPageLink(`http://localhost:${state.port}/`, { title: 'TRouteAI', pageHost: location.hostname, signedIn: state.signedIn || [] });
  if (l && l.href) window.open(l.href, '_blank', 'noopener,noreferrer');
  else toast(l ? l.text : 'TRouteAI has no page to open here.', { ms: 9000 });
}

// ---------- Add ----------

function waiting(text) {
  return h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));
}

/** The sheet that adds an account. `state`: { computer, port, signedIn }; `done()` draws the list again. */
async function addSheet(state, done) {
  let open = true;
  const body = h('div.wizard', waiting('Asking TRouteAI which providers it knows…'));
  let sheetClose = () => {};
  const sheet = openSheet({ title: 'Add an account to TRouteAI', subtitle: 'A provider\'s key or sign-in, kept by TRouteAI on this computer', wide: true, tall: true }, (close) => {
    sheetClose = close;
    return body;
  });
  sheet.then(() => { open = false; });
  let catalog;
  try {
    catalog = await api(T('/providers'));
  } catch (e) {
    return fill(body, errorBox(e));
  }
  if (!catalog.catalog) {
    return fill(body, h('p.sheet-text', catalog.sentence),
      h('div.sheet-actions', btn('primary', { label: 'Open TRouteAI\'s page', onclick: () => openGatewayPage(state) })));
  }
  const choose = () => {
    const q = h('input.field', { type: 'search', placeholder: 'Search providers', autocomplete: 'off', 'aria-label': 'Search providers' });
    const list = h('div.rows.tr-providers');
    const paint = () => {
      const w = q.value.trim().toLowerCase();
      const hits = catalog.providers.filter((p) => !w || `${p.name} ${p.category || ''}`.toLowerCase().includes(w));
      fill(list, hits.length ? hits.map((p) => h('button.row.tr-provider', { type: 'button', onclick: () => go(p) },
        h('span.row-main', h('span.row-title', p.name), h('span.row-sub', p.category || { 'api-key': 'Sign in with a key', 'device-code': 'Sign in with a code', 'link-and-paste': 'Sign in with a link', 'own-page': 'Added in TRouteAI\'s page' }[p.flow])),
        icon('chevronRight', { size: 18 }))) : h('p.hint', 'No provider by that name.'));
    };
    q.addEventListener('input', paint);
    paint();
    fill(body, field('Provider', q), list);
  };
  const back = btn('secondary', { icon: 'back', label: 'Back', onclick: () => choose() });
  const go = (p) => {
    if (p.flow === 'api-key') return keyStep(p);
    if (p.flow === 'device-code') return codeStep(p);
    if (p.flow === 'link-and-paste') return linkStep(p);
    return fill(body, h('p.sheet-text', `${p.name} is added in TRouteAI's own page.`), h('div.sheet-actions', back, btn('primary', { label: 'Open TRouteAI\'s page', onclick: () => openGatewayPage(state) })));
  };
  const hints = (p) => [p.authHint ? h('p.hint', p.authHint) : null, p.website ? h('p.hint', h('a', { href: p.website, target: '_blank', rel: 'noopener noreferrer' }, `${p.name}'s website`)) : null];

  function keyStep(p) {
    const key = h('input.field.mono', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: p.apiHint || 'Paste the key', 'aria-label': `${p.name} key` });
    const name = h('input.field', { type: 'text', value: p.name, maxlength: '100', 'aria-label': 'Name for this account' });
    const out = h('div');
    const add = btn('primary', { label: 'Add and test', onclick: async () => {
      add.disabled = true;
      fill(out, waiting('Adding it and testing it…'));
      try {
        const r = await api(T('/add/key'), { confirm: state.computer, provider: p.id, name: name.value, apiKey: key.value });
        key.value = '';
        done();
        fill(out, r.valid === false
          ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', `Added, but the test failed: ${r.says} You can remove it and add it again.`))
          : h('div.banner.ok', icon('check', { size: 18 }), h('span', 'Added. It works.')));
        if (r.valid !== false) toast('Account added');
      } catch (e) {
        fill(out, errorBox(e));
        add.disabled = false;
      }
    } });
    fill(body, h('h3', p.name), ...hints(p), field('Key', key, 'It goes to TRouteAI on this computer and is not shown again.'), field('Name', name), out, h('div.sheet-actions', back, add));
    key.focus();
  }

  async function codeStep(p) {
    fill(body, waiting('Asking TRouteAI for a code…'));
    let s;
    try {
      s = await api(T('/add/code'), { confirm: state.computer, provider: p.id });
    } catch (e) {
      return fill(body, errorBox(e), h('div.sheet-actions', back));
    }
    const out = h('p.hint', 'Waiting for you to finish in the browser…');
    fill(body, h('h3', p.name),
      h('p.sheet-text', 'Open the link, sign in, and type this code there:'),
      h('p.tr-code', { 'aria-live': 'polite' }, s.userCode),
      h('p', h('a.btn.secondary', { href: s.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open the sign-in page')),
      out, h('div.sheet-actions', btn('secondary', { label: 'Cancel', onclick: () => { api(T('/add/cancel'), { confirm: state.computer, ticket: s.ticket }).catch(() => {}); choose(); } })));
    // The poll runs only while this sheet is open.
    const ticket = s.ticket;
    for (let waitedS = 0; open && waitedS < s.expiresIn; waitedS += s.interval) {
      await new Promise((r) => setTimeout(r, s.interval * 1000));
      if (!open || !body.isConnected) break;
      try {
        const r = await api(T('/add/poll'), { confirm: state.computer, ticket });
        if (r.done) {
          done();
          toast('Account added');
          return fill(body, h('div.banner.ok', icon('check', { size: 18 }), h('span', 'Signed in. The account is added.')), h('div.sheet-actions', btn('primary', { label: 'Done', onclick: () => sheetClose() })));
        }
      } catch (e) {
        return fill(body, errorBox(e), h('div.sheet-actions', back));
      }
    }
  }

  async function linkStep(p) {
    fill(body, waiting('Asking TRouteAI for a sign-in link…'));
    let s;
    try {
      s = await api(T('/add/link'), { confirm: state.computer, provider: p.id });
    } catch (e) {
      return fill(body, errorBox(e), h('div.sheet-actions', back));
    }
    const address = h('textarea.field.mono', { rows: 3, placeholder: 'http://localhost:8080/callback?code=…', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'The address the browser ended on' });
    const out = h('div');
    const finish = btn('primary', { label: 'Finish', onclick: async () => {
      finish.disabled = true;
      fill(out, waiting('Finishing the sign-in…'));
      try {
        await api(T('/add/finish'), { confirm: state.computer, ticket: s.ticket, address: address.value });
        done();
        toast('Account added');
        fill(body, h('div.banner.ok', icon('check', { size: 18 }), h('span', 'Signed in. The account is added.')), h('div.sheet-actions', btn('primary', { label: 'Done', onclick: () => sheetClose() })));
      } catch (e) {
        fill(out, errorBox(e));
        finish.disabled = false;
      }
    } });
    fill(body, h('h3', p.name),
      h('ol.tr-steps', h('li', 'Open the sign-in page and sign in.'), h('li', 'The browser then ends on a page that does not load (an address starting with localhost). That is expected.'), h('li', 'Copy that whole address from the browser\'s address bar and paste it below.')),
      h('p', h('a.btn.secondary', { href: s.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open the sign-in page')),
      field('The address you ended on', address), out, h('div.sheet-actions', back, finish));
  }
  choose();
}

// ---------- Combos ----------

/**
 * "Make a combo for <model>": the models TRouteAI's accounts offer, those that carry the model's name ticked, and one
 * press makes it. `done()` runs after one is made. Used by the panel and by the provider check's "Make the combo".
 */
export async function makeComboSheet({ computer = null, name, done = () => {} }) {
  let o;
  try {
    if (!computer) computer = (await api('~/api/gatewayhost')).computer;
    o = await api(T(`/combos/options?name=${encodeURIComponent(name || '')}`));
  } catch (e) {
    return say(e);
  }
  const nameField = h('input.field', { type: 'text', value: name || '', maxlength: '100', 'aria-label': 'Name of the combo' });
  const picked = new Set(o.suggested);
  const out = h('div');
  const models = o.providers.length
    ? o.providers.map((p) => h('fieldset.tr-models', h('legend', p.name), p.models.map((m) => h('label.tr-model',
      h('input', { type: 'checkbox', checked: picked.has(m.qualified), onchange: (e) => (e.target.checked ? picked.add(m.qualified) : picked.delete(m.qualified)) }), h('span', m.name || m.id)))))
    : [h('p.hint', 'No account of TRouteAI that is turned on offers a model yet. Add or turn on an account first.')];
  await openSheet({ title: name ? `Make a combo for ${name}` : 'Make a combo', subtitle: 'A name that sends requests to the models you tick', tall: true }, (close) => [
    h('p.sheet-text', o.suggested.length ? 'These carry that name, so they are ticked. Add more to use them as a fallback.' : 'No account offers a model by that name. Tick the models it should send to.'),
    field('Name', nameField), ...models, out,
    h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'),
      btn('primary', { label: 'Make the combo', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try {
          await api(T('/combos/make'), { confirm: computer, name: nameField.value, models: [...picked] });
          toast('Combo made');
          done();
          close(true);
        } catch (e) {
          fill(out, errorBox(e));
          ev.currentTarget.disabled = false;
        }
      } })),
  ]);
}

// ---------- the panel ----------

function accountRow(a, limits, state, reload) {
  const press = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      say(e);
    }
    reload();
    return label;
  };
  const lim = limits && limits[a.id];
  return h('div.row.static.tr-row',
    h('span.row-icon', icon(a.state === 'ok' ? 'check' : a.state === 'off' ? 'power' : 'alert')),
    h('span.row-main',
      h('span.row-title', a.name, h('span.hint', ` · ${a.provider}`)),
      h('span.row-sub', [STATE_WORDS[a.state], a.lastTested ? `tested ${ago(a.lastTested)}` : null, a.limitedUntil ? `back ${until(a.limitedUntil)}` : null].filter(Boolean).join(' · ')),
      a.says ? h('span.row-sub.tr-says', a.says) : null,
      lim && lim.windows && lim.windows.length ? h('span.tr-limits', lim.windows.map(limitLine)) : null,
      lim && lim.message && !(lim.windows && lim.windows.length) ? h('span.row-sub', lim.message) : null),
    h('span.tr-acts',
      btn('small secondary', { label: 'Test', onclick: () => press('test', async () => {
        const r = await api(T(`/accounts/${encodeURIComponent(a.id)}/test`), { confirm: state.computer });
        toast(r.valid ? `${a.name} works` : `${a.name}: ${r.says}`, { kind: r.valid ? 'info' : 'error', ms: 8000 });
      }) }),
      btn('small secondary', { label: a.on ? 'Turn off' : 'Turn on', onclick: () => press('on', () => api(T(`/accounts/${encodeURIComponent(a.id)}/on`), { confirm: state.computer, on: !a.on })) }),
      btn('small secondary', { label: 'Remove', onclick: async () => {
        if (!(await confirmSheet({ title: `Remove ${a.name}?`, text: `TRouteAI on ${state.computer} forgets this account and its key or sign-in. You can add it again later.`, ok: 'Remove', danger: true }))) return;
        press('remove', () => api(T(`/accounts/${encodeURIComponent(a.id)}/remove`), { confirm: state.computer }));
      } })));
}

function combosPart(state) {
  const box = h('div', skeletonRows(1));
  const load = async () => {
    let r;
    try {
      r = await api(T('/combos'));
    } catch (e) {
      return fill(box, errorBox(e, load));
    }
    fill(box,
      r.combos.length ? h('div.rows', r.combos.map((c) => h('div.row.static',
        h('span.row-icon', icon('swap')),
        h('span.row-main', h('span.row-title', c.name), h('span.row-sub', c.models.length ? `Sends to ${c.models.join(', ')}` : 'No model yet')),
        btn('small secondary', { label: 'Remove', onclick: async () => {
          if (!(await confirmSheet({ title: `Remove the combo ${c.name}?`, text: `Requests for the name ${c.name} will no longer be sent anywhere by TRouteAI on ${state.computer}.`, ok: 'Remove', danger: true }))) return;
          try {
            await api(T(`/combos/${encodeURIComponent(c.id)}/remove`), { confirm: state.computer });
          } catch (e) {
            say(e);
          }
          load();
        } })))) : h('p.hint', 'No combo yet.'),
      h('div.savebar.start', btn('secondary', { icon: 'plus', label: 'Make a combo', onclick: () => makeComboSheet({ computer: state.computer, name: '', done: load }) })));
  };
  const f = fold('trouteai-combos', 'Combos', h('p.hint', 'A combo is a name that TRouteAI answers by sending the request to the models you choose, one after the other.'), box);
  let loaded = false;
  const first = () => {
    if (f.open && !loaded) {
      loaded = true;
      load();
    }
  };
  f.addEventListener('toggle', first);
  first();
  return f;
}

function keysPart(state) {
  const box = h('div', skeletonRows(1));
  const load = async () => {
    let r;
    try {
      r = await api(T('/keys'));
    } catch (e) {
      return fill(box, errorBox(e, load));
    }
    fill(box, r.keys.length ? h('div.rows', r.keys.map((k) => h('div.row.static',
      h('span.row-icon', icon('key')),
      h('span.row-main', h('span.row-title', k.name), h('span.row-sub', 'Made by Hoprig')),
      btn('small secondary', { label: 'Remove', onclick: async () => {
        if (!(await confirmSheet({ title: `Remove the key ${k.name}?`, text: 'A program that uses this key stops working until it gets a new one.', ok: 'Remove', danger: true }))) return;
        try {
          await api(T(`/keys/${encodeURIComponent(k.id)}/remove`), { confirm: state.computer });
        } catch (e) {
          say(e);
        }
        load();
      } })))) : h('p.hint', 'Hoprig has made no key in TRouteAI.'));
  };
  const f = fold('trouteai-keys', 'Keys Hoprig made', h('p.hint', 'The keys your coding sessions use to reach TRouteAI. Other keys are kept in TRouteAI\'s own page.'), box);
  let loaded = false;
  const first = () => {
    if (f.open && !loaded) {
      loaded = true;
      load();
    }
  };
  f.addEventListener('toggle', first);
  first();
  return f;
}

/** The panel. Hidden until this computer's own TRouteAI is known; `changed()` runs after the accounts changed. */
export function trouteaiPanel({ changed = () => {} } = {}) {
  const box = h('div');
  const el = panel({ id: 'trouteai', icon: 'swap', title: 'TRouteAI', desc: 'The AI accounts TRouteAI holds for your coding tools, their limits, and the combos that choose between them.' }, box);
  el.hidden = true;
  async function load() {
    let host;
    try {
      host = await api('~/api/gatewayhost');
    } catch {
      return;
    }
    const g = (host.gateways || []).find((x) => x.id === 'trouteai' && !x.defined);
    if (!g || !g.installed) return;
    el.hidden = false;
    const state = { computer: host.computer, port: g.port, signedIn: host.signedIn || [] };
    if (!g.running) {
      return fill(box, h('p.hint', 'TRouteAI is not running, so its accounts cannot be shown.'),
        h('div.savebar.start', btn('primary', { icon: 'power', label: 'Start TRouteAI', onclick: async () => {
          try {
            await api(T('/start'), { confirm: host.computer });
          } catch (e) {
            say(e);
          }
          load();
        } })));
    }
    fill(box, skeletonRows(2));
    let accounts;
    try {
      accounts = await api(T('/accounts'));
    } catch (e) {
      return fill(box, errorBox(e, load));
    }
    state.computer = accounts.computer;
    // The limits come after the list, from what TRouteAI already knows; a press reads them live.
    const list = h('div.rows');
    const paint = (limits) => fill(list, ...(accounts.accounts.length
      ? accounts.accounts.map((a) => accountRow(a, limits, state, load))
      : [h('p.hint', 'No account yet. Add the provider your coding tools should use through TRouteAI.')]));
    paint(null);
    const reread = async (live) => {
      try {
        if (!live) return paint((await api(T('/limits'))).limits);
        const all = {};
        for (const a of accounts.accounts.filter((x) => x.on)) Object.assign(all, (await api(T(`/limits?account=${encodeURIComponent(a.id)}`))).limits);
        paint(all);
        toast('Limits read');
      } catch (e) {
        if (live) say(e);
      }
    };
    fill(box, list,
      h('div.savebar.start',
        btn('primary', { icon: 'plus', label: 'Add account', onclick: () => addSheet(state, () => { load(); changed(); }) }),
        accounts.accounts.length ? btn('secondary', { icon: 'refresh', label: 'Read limits now', onclick: () => reread(true) }) : null,
        btn('secondary', { icon: 'swap', label: 'Open TRouteAI', onclick: () => openGatewayPage(state) })),
      combosPart(state), keysPart(state));
    reread(false);
  }
  load();
  return el;
}
