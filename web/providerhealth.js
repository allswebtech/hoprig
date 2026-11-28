// A provider's page (#/providers/<name>), the part that keeps it from stopping the work: "Check this provider" with the
// number of small requests said on the button, the last result and its time, each gap with the line that mends it;
// the model map, what a session gets or would get, with its switch; and what is left, each line with its basis. Reads GET /api/providers/<name>/health
// (it sends nothing to the provider); only the button sends, through POST …/check.
import { icon } from './icons.js';
import { ago, api, at, btn, copyText, fill, h, machine, openSheet, toast } from './lib.js';
import { panel, toggle } from './shell.js';
import { makeComboSheet } from './trouteai.js';

const P = (name, p) => at(machine.current, `/api/providers/${encodeURIComponent(name)}${p}`);
const WHY = { served: 'served', refused: 'not served', key: 'the key was refused', untold: 'no answer to tell' };
// The switch, in the words the terminal command uses too (src/providers/mapcli.mjs MAP_CHANGES).
const SWITCH = 'Use these names for every session on this provider';
const CHANGES = 'New sessions and chats on this provider, and the agents inside them, send these names instead. Sessions already open keep what they have, and Auto mode is not changed by it.';

function copyLine(text) {
  return h('div.ph-mend',
    h('code.ph-code', text),
    btn('small secondary', { icon: 'copy', title: 'Copy', onclick: async () => toast((await copyText(text)) ? 'Copied' : 'Could not copy') }));
}

function resultBlock(last, name = null, reload = null, on = false) {
  if (!last) return h('p.hint', 'Not checked yet.');
  // Every request refused the same way: the endpoint itself (an address with a wrong path, a gateway's own rule), told once.
  if (last.endpoint) {
    return h('div.ph-result',
      h('p.ph-sum.ph-bad', { role: 'status' }, icon('alert', { size: 15 }), h('span', `Checked ${ago(Date.parse(last.at))}: every request was refused the same way`)),
      h('p.ph-said', `It said: ${last.endpoint.said || `HTTP ${last.endpoint.status}`}`),
      h('p.hint', 'This is about the provider\'s address, not about a model name: look at that address and at the gateway\'s own settings, then check again.'));
  }
  const rows = [...(last.rows || []), ...(last.picture ? [{ ...last.picture, why: 'a picture' }] : [])];
  const gaps = rows.filter((r) => r.verdict !== 'served');
  const served = rows.length - gaps.length;
  return h('div.ph-result',
    h(`p.ph-sum.${gaps.some((r) => r.verdict === 'refused' || r.verdict === 'key') ? 'ph-bad' : 'ph-ok'}`, { role: 'status' },
      icon(gaps.length ? 'alert' : 'check', { size: 15 }),
      h('span', `Checked ${ago(Date.parse(last.at))}: ${served} of ${rows.length} served`, h('span.hint', ` · names of Claude Code ${last.tool}`))),
    gaps.length ? h('ul.ph-list', gaps.map((r) => h('li.ph-row',
      h('div.ph-name', h('code', r.sends), h(`span.ph-tag.ph-${r.verdict}`, WHY[r.verdict] || r.verdict)),
      h('p.hint', r.why === 'a picture' ? 'A request with a picture' : `Asked as ${r.why}`),
      r.said ? h('p.ph-said', `It said: ${r.said}`) : null,
      r.mend ? h('div.ph-mends', h('p.ph-do', 'To mend it:'), comboMend(r, reload),
        r.why !== 'a picture' ? h('p.hint', 'A combo is a name you make at the gateway that sends requests to a model it serves.') : null, r.mend.models ? [h('p.ph-or', 'or, in this provider:'), useLine(name, r, reload, on)] : null,
        // A name the owner's own settings send: changed in his settings file, not by a line in this provider.
        r.mend.yours ? [h('p.ph-or', 'or, in your own settings:'), h('p.hint', r.mend.yours)] : null) : null))) : null);
}

// The combo that mends a refused name: a press where the gateway is this computer's own and managed in Hoprig (the check
// says so in mend.make), else the sentence to copy. The press opens the sheet that makes it; the check is read again after.
function comboMend(r, reload) {
  if (!r.mend.make || machine.current || !reload) return copyLine(r.mend.combo);
  return h('div.ph-mend', btn('primary small', { icon: 'plus', label: 'Make the combo', onclick: () => makeComboSheet({ name: r.mend.make.name, done: reload }) }),
    h('span.hint', `Makes "${r.mend.make.name}" in the gateway on this computer.`));
}

// While the map is off for sessions, "Use this" asks in one sheet: put the line in and turn the map on, or only put
// the line in (it then mends nothing for a session). Resolves 'on', 'line' or null (cancelled). Never on in silence.
function askSwitch() {
  return openSheet({ title: 'Use this line for sessions too?' }, (close) => [
    h('p.sheet-text', `The model map is off for sessions on this provider: this line mends nothing for a session until "${SWITCH}" is on. Only Auto mode uses the map now.`),
    h('p.sheet-text', CHANGES),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', autofocus: true, onclick: () => close(null) }, 'Cancel'),
      h('button.btn.secondary', { type: 'button', onclick: () => close('line') }, 'Only put the line in'),
      h('button.btn.primary', { type: 'button', onclick: () => close('on') }, 'Put it in and turn it on')),
  ]).then((v) => (v === 'on' || v === 'line' ? v : null));
}

// The MODELS line with one tap that puts it into this provider (POST …/mend; the server writes only its own line).
function useLine(name, r, reload, on = false) {
  if (!reload) return copyLine(r.mend.models); // another computer's provider: changed on its own page
  const use = btn('small primary', { icon: 'check', label: 'Use this', onclick: async () => {
    const how = on ? 'line' : await askSwitch();
    if (!how) return;
    use.disabled = true;
    try {
      const done = await api(P(name, '/mend'), { sends: r.sends, on: how === 'on' });
      toast(done.on ? 'The model map of this provider changed, and new sessions and chats on it send the new names. Check it again to see the result.' : 'The model map of this provider changed. It mends nothing for a session until the map is on for sessions.');
    } catch (e) {
      toast(e, { kind: 'error', ms: 8000 });
    }
    reload();
  } });
  return h('div', copyLine(r.mend.models), r.mend.note ? h('p.hint', r.mend.note) : null,
    h('div.ph-use', use, h('span.hint', on ? ' New sessions and chats on this provider send the new names.' : ` It mends a session only with "${SWITCH}" on.`)));
}

function checkBlock(name, d, reload) {
  const c = d.check;
  if (!c.applies) return h('p.hint', 'There is nothing to check for a sign-in.');
  // Another computer's provider: a press from here is refused there (only its own page sends to its providers).
  if (c.press === false) return h('div.ph-check', h('p.hint', 'This provider is on another computer: its check is pressed on that computer\'s own page.'), h('div', resultBlock(c.last)));
  const out = h('div', resultBlock(c.last, name, reload, d.map?.on === true));
  const press = btn('primary', { icon: 'check', label: `Check this provider: ${c.count} small requests`, onclick: async () => {
    press.disabled = true;
    fill(out, h('p.hint', `Sending ${c.count} small requests, one word each…`));
    try {
      await api(P(name, '/check'), {});
    } catch (e) {
      toast(e, { kind: 'error', ms: 8000 });
    }
    reload();
  } });
  return h('div.ph-check', h('p.hint', 'Asks this provider once for every model name Claude Code can send through it, and once with a tiny picture. Each request asks for one word.'), press, out);
}

// The switch for every session and chat on this provider (POST …/map), only on the owner's own page.
function mapSwitch(name, d, reload) {
  if (!d.map.models) return null;
  if (!d.map.change || !reload) return h('p.hint', d.map.on ? 'On for every session and chat on this provider; it is changed on that computer\'s own page.' : 'Off for sessions and chats; it is changed on that computer\'s own page.');
  return toggle(SWITCH, d.map.on, async (on) => {
    try {
      await api(P(name, '/map'), { on });
      reload();
    } catch (e) {
      toast(e, { kind: 'error', ms: 8000 });
      reload();
      return false;
    }
  }, CHANGES);
}

function mapBlock(d, name = null, reload = null) {
  const rules = d.map.rules || [];
  const on = d.map.on === true;
  // An older or unknown Claude Code takes no map of names: only the small model is renamed (the server leaves the rest out).
  const untaken = d.map.untaken ? h('p.hint', `${d.map.version ? `Claude Code ${d.map.version}` : 'The Claude Code on this computer (its version is not known)'} does not take this map: only the small model is renamed.`) : null;
  if (!d.map.models && !rules.length) return h('p.hint', 'No model map: sessions send the names Claude Code chooses.');
  // What it says the sessions do: what they send now (on), or what they would send (off; Auto mode uses the map anyway).
  const state = on ? h('p.hint', 'On: every new session and chat on this provider sends these names instead. Your own settings file is never changed.')
    : h('p.hint', 'Off: sessions and chats on this provider send the names Claude Code chooses; only Auto mode uses this map. With it on, they would send:');
  const by = { profile: 'this provider', yours: 'your Claude Code settings', small: 'this provider' };
  const list = rules.length ? h('ul.ph-map', rules.map((r) => h('li', h('code', r.from), icon('chevronRight', { size: 14 }), h('code', r.to), untaken ? null : h('span.hint.ph-by', `from ${by[r.by] || r.by}`))))
    : h('p.hint', 'Its rules rename no name Claude Code sends.');
  return h('div', untaken, state, list, mapSwitch(name, d, reload));
}

function leftBlock(d) {
  const l = d.left;
  // The windows themselves are the usage bars above (accounts.js usageBars): said once, in their words. Here only what
  // the bars do not say: the pace, the day's stops and the advice.
  const lines = [...l.paces.map((p) => p.line), l.stops.line, l.advice].filter(Boolean);
  if (!lines.length) return h('p.hint', 'Nothing measured yet: a pace needs two readings of a limit half an hour apart, and a stop is counted when it happens.');
  return h('ul.ph-left', lines.map((t) => h('li', t)));
}

/** The panels of provider `name`, filled once its data is read. */
export function providerHealth(name) {
  const box = h('div.ph', h('p.hint', 'Loading…'));
  const load = async () => {
    let d;
    try {
      d = await api(P(name, '/health'));
    } catch (e) {
      // An older computer has no such route: the page stays as it was.
      fill(box);
      return;
    }
    fill(box,
      panel({ icon: 'check', title: 'Check this provider', desc: 'Finds a model name it does not serve before it stops a session.' }, checkBlock(name, d, load)),
      panel({ icon: 'swap', title: 'Model map', desc: 'The names this provider needs instead, for Auto mode and, where you turn it on, every session.' }, mapBlock(d, name, load)),
      panel({ icon: 'clock', title: 'What is left', desc: 'Only what was measured.' }, leftBlock(d)));
  };
  load();
  // The page asks again after a press: the panels stay where they are until the new answer is there (no waiting line in
  // between, which shortened the page and threw it back to the top).
  box.reload = load;
  return box;
}
