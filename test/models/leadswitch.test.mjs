// The page's "Lead model" switch (web/leadswitch.js): a short label, one line of help, off unless saved on; on, one
// more line from the server; another coding tool shows it off with one line why. And every place that sets up a
// session has it and sends it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byClass, texts } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const asked = [];
globalThis.fetch = async (u) => {
  asked.push(String(u));
  const body = /\/api\/models\/others/.test(String(u))
    ? { providers: [{ name: 'alpha', label: 'Alpha', tools: ['claude'], paid: false, limited: null }, { name: 'paid', label: 'Paid key', tools: ['claude'], paid: true, limited: { until: null } }] }
    : { can: true, line: 'Uses running and recording on haiku.' };
  return { ok: true, status: 200, json: async () => body };
};
const { LEAD_HELP, LEAD_LABEL, OTHERS_LABEL, leadSwitch } = await import('../../web/leadswitch.js');
const settle = () => new Promise((r) => setTimeout(r, 20));
// The stand-in DOM keeps a boolean given to h() as an attribute (a browser has the property): read either.
// The line under the switch is set as its textContent (a plain property in the stand-in).
const lineOf = (n) => byClass(n, 'lead-line')[0].textContent || '';
const flag = (el, k) => el[k] === true || (el[k] === undefined && el.getAttribute(k) !== null);

test('off: the label and one line of help, nothing asked; on: the line of the provider', async () => {
  let now = null;
  const n = leadSwitch({ value: false, provider: 'team', onchange: (on) => (now = on) });
  await settle();
  const all = texts(n).join(' ');
  assert.ok(all.includes(LEAD_LABEL) && all.includes(LEAD_HELP));
  assert.equal(asked.length, 0, 'off asks nothing');
  const box = n.querySelector('input');
  assert.equal(flag(box, 'checked'), false, 'off unless saved on');
  box.checked = true;
  box.listeners.change({ target: box });
  await settle();
  assert.equal(now, true);
  assert.match(asked.at(-1), /\/api\/models\/lead\?provider=team&tool=claude$/);
  assert.equal(lineOf(n), 'Uses running and recording on haiku.');
  assert.doesNotMatch(all, /agent|subagent|flag|endpoint|token/i, 'no tool\'s inside word');
});

test('another coding tool: shown off, with one line why', () => {
  const n = leadSwitch({ value: false, provider: 'team', tool: 'opencode', onchange: () => {} });
  assert.equal(flag(n.querySelector('input'), 'disabled'), true);
  assert.equal(lineOf(n), 'Only Claude Code can do this.');
});

test('Settings, Settings → Tia, the new-session sheet and Plan with AI have the switch and send it', () => {
  const sends = {
    'sessiondefaults.js': /sessionDefaults: \{[^}]*lead: cur\.lead === true/,
    'tia.js': /lead: st\.lead === true, others: st\.lead === true/,
    'newsession-start.js': /lead: st\.lead/,
    'workpropose.js': /lead: v\.lead/,
  };
  for (const [f, re] of Object.entries(sends)) assert.match(fs.readFileSync(path.join(WEB, f), 'utf8'), re, `${f} sends it`);
  for (const f of ['sessiondefaults.js', 'tia.js', 'newsession-options.js', 'workpropose.js']) assert.match(fs.readFileSync(path.join(WEB, f), 'utf8'), /leadSwitch\(\{/, `${f} draws it`);
  assert.match(fs.readFileSync(path.join(WEB, 'chat', 'start.js'), 'utf8'), /typeof o\.lead === 'boolean'/, 'the App start passes a choice, true or false');
});

test('"Use other providers": shown only while Lead is on; its ticks right under it, with billing and limit', async () => {
  asked.length = 0;
  let ticks = null;
  const n = leadSwitch({ value: false, provider: 'team', others: [], onchange: () => {}, onothers: (l) => (ticks = l) });
  await settle();
  assert.ok(!texts(n).includes(OTHERS_LABEL), 'not shown while Lead is off');
  assert.ok(!asked.some((u) => u.includes('/others')), 'nothing asked');
  const lead = n.querySelector('input');
  lead.checked = true;
  lead.listeners.change({ target: lead });
  await settle();
  const all = texts(n).join(' ');
  assert.ok(all.includes(OTHERS_LABEL));
  assert.doesNotMatch(all, /Advanced/, 'the ticks are not folded away');
  assert.match(all, /Paid key/);
  assert.match(all, /billed by use/);
  assert.match(all, /at its limit/);
  const sw = n.querySelectorAll('input').find((x) => x.getAttribute('data-key') === 'lead-others');
  // The ticks sit right under the switch, in no fold to open (the stand-in DOM keeps no class toggle: the tree is read).
  const tags = (x) => [x.tag, ...(x.children || []).flatMap((c) => (c && c.tag ? tags(c) : []))];
  // The only fold is Lead model's "More" of its help: the ticks are in none.
  const folds = [n, ...n.querySelectorAll('details')].filter((x) => x.tag === 'details');
  assert.ok(folds.every((f) => f.className.includes('help-more') && !byClass(f, 'lead-ticks').length && !tags(f).includes('input')), 'no fold');
  assert.equal(byClass(n, 'lead-ticks').length, 1);
  sw.checked = true;
  sw.listeners.change({ target: sw });
  assert.match(byClass(n, 'lead-none')[0].textContent, /Tick at least one provider/, 'on with none ticked: said');
  const alpha = n.querySelectorAll('input').find((x) => x.getAttribute('data-key') === 'tick-alpha');
  alpha.checked = true;
  alpha.listeners.change({ target: alpha });
  assert.deepEqual(ticks, ['alpha']);
  assert.equal(byClass(n, 'lead-none')[0].textContent, '');
  sw.checked = false;
  sw.listeners.change({ target: sw });
  assert.deepEqual(ticks, [], 'off: no ticks are sent');
  assert.doesNotMatch(all, /agent|subagent|flag|endpoint|token/i);
});

test('both are the product\'s switches (role=switch), and Enter turns them as Space does', async () => {
  let now = null;
  const n = leadSwitch({ value: false, provider: 'team', onchange: (on) => (now = on) });
  const box = n.querySelector('input');
  assert.equal(box.getAttribute('role'), 'switch');
  let stopped = false;
  box.listeners.keydown({ key: 'Enter', preventDefault: () => (stopped = true) });
  assert.equal(now, true);
  assert.equal(stopped, true);
  box.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(now, false);
});

test('a tick on the session\'s own provider, or on one that may not be ticked here, is dropped and never sent', async () => {
  let ticks = null;
  leadSwitch({ value: true, provider: 'alpha', others: ['alpha', 'relay'], onchange: () => {}, onothers: (l) => (ticks = l) });
  assert.deepEqual(ticks, ['relay'], 'the own provider is not another one');
  ticks = null;
  const n = leadSwitch({ value: true, provider: null, others: ['alpha', 'paid'], only: ['alpha'], billed: () => true, onchange: () => {}, onothers: (l) => (ticks = l) });
  assert.deepEqual(ticks, ['alpha'], 'only the names that may be ticked (Tia: her allowed providers)');
  await settle();
  const all = texts(n).join(' ');
  assert.match(all, /Alpha/);
  assert.doesNotMatch(all, /Paid key/, 'one she may not use is not offered');
  assert.match(all, /Alpha\s+· Claude Code · billed by use/, 'billed by the caller\'s rule');
});


test('Settings → Tia: her ticks only of the providers she may use, redrawn when those change; no one provider\'s tiers named', () => {
  const tia = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.match(tia, /only: allowed\.filter/, 'her allowed providers only');
  assert.match(tia, /drawLead\(\); \/\/ her ticks/, 'redrawn when her allowed providers change');
  assert.match(tia, /provider: null, noProvider: 'Which models it uses depends on the provider she starts each chat on\.'/);
  assert.match(tia, /billed: \(p\) => p\.kind === 'api' \|\| p\.paid === true/, 'billed by use as her own rule says');
});

test('the new-session sheet seeds Lead from Settings and sends what it shows; another coding tool shows it off with why', () => {
  const popup = fs.readFileSync(path.join(WEB, 'newsession-popup.js'), 'utf8');
  assert.match(popup, /st\.lead = d\.lead === true/, 'drawn as Settings has it, not off');
  assert.match(popup, /st\.others = Array\.isArray\(d\.others\)/, 'with Settings\' ticks');
  const opts = fs.readFileSync(path.join(WEB, 'newsession-options.js'), 'utf8');
  assert.match(opts, /app \? leadSwitch\(\{ value: false, tool,/, 'another coding tool: the switch, off');
});

test('a tick on a provider that is no longer one (removed, or another computer\'s) is dropped once the list arrives', async () => {
  let ticks = null;
  const n = leadSwitch({ value: true, provider: 'team', others: ['alpha', 'gone'], onchange: () => {}, onothers: (l) => (ticks = l) });
  assert.equal(ticks, null, 'nothing known to drop before the list arrives');
  await settle();
  assert.deepEqual(ticks, ['alpha'], 'what is sent is what is shown');
  assert.doesNotMatch(texts(n).join(' '), /gone/);
  ticks = null;
  leadSwitch({ value: true, provider: 'team', others: ['gone'], onchange: () => {}, onothers: (l) => (ticks = l) });
  await settle();
  assert.deepEqual(ticks, [], 'none left: none sent');
});

test('under Lead: one line of what it costs, true to what was measured; under Use other providers: the mode parts run in', async () => {
  const L = await import('../../web/leadswitch.js');
  assert.match(L.LEAD_COST, /costs more/);
  assert.match(L.LEAD_COST, /three to six times/);
  assert.doesNotMatch(L.LEAD_COST, /sav/i, 'no promise of saving');
  const n = L.leadSwitch({ value: true, provider: 'team', onchange: () => {}, others: ['alpha'], onothers: () => {}, partMode: 'bypassPermissions', modes: ['manual', 'bypassPermissions'] });
  await settle();
  const all = texts(n).join(' ');
  assert.ok(all.includes(L.LEAD_COST), 'the cost line is shown where he switches it on');
  // One line under the switch (the cost in it, never folded away); how it works under a closed "More".
  const row = byClass(n, 'switchrow')[0];
  const visibleHints = byClass(row, 'hint').filter((x) => !byClass(row, 'help-more').some((f) => byClass(f, 'hint').includes(x)));
  assert.deepEqual(visibleHints.map((x) => texts(x).join('')), [L.LEAD_HELP], 'one line of help');
  assert.ok(L.LEAD_HELP.includes(L.LEAD_COST) && !/[.!?]\s+\S/.test(L.LEAD_HELP), 'one sentence, with the cost');
  const fold = byClass(row, 'help-more')[0];
  assert.ok(fold && fold.open !== true, 'a closed More');
  assert.deepEqual(texts(byClass(fold, 'help-more-body')[0]), [L.LEAD_MORE]);
  assert.match(L.LEAD_MORE, /plans the work/);
  // Use other providers: one line, and the mode parts run in as a line of its own, never folded.
  const others = byClass(n, 'switchrow')[1];
  assert.deepEqual(byClass(others, 'hint').map((x) => texts(x).join('')), [L.OTHERS_HELP]);
  assert.equal(byClass(others, 'help-more').length, 0);
  assert.equal(byClass(n, 'lead-mode').length, 1);
  assert.ok(all.includes('Parts run in this session\'s mode: now bypass permissions.'), all);
  // Bypass not offered on that computer now: the line says what a part really gets.
  assert.equal(L.partModeLine('bypassPermissions', ['manual', 'acceptEdits']), 'Parts run in this session\'s mode: now manual.');
  assert.equal(L.partModeLine('acceptEdits', null), 'Parts run in this session\'s mode: now accept edits.');
  assert.match(L.partModeLine(null), /never in bypass permissions unless you allow it/);
});
