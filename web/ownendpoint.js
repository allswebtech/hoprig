// Providers: an address in Claude Code's own settings file wins over every provider (src/codetools/ownsettings.mjs).
// One panel says so, shows the exact lines a press takes out (a key's value never), and offers the two ways out: take
// the address out (a backup is kept beside the file), or make that gateway a provider of its own first.
import { api, confirmSheet, copyText, h, openSheet, toast } from './lib.js';
import { listRow } from './shell.js';
import { icon } from './icons.js';

/** The short words under a provider row: the whole sentence is in the sheet of the warning row. */
export const ownShort = 'Not used by Claude Code now';

/** The words a provider's row gets when the settings file decides instead of it (Claude Code only). */
export const ownNote = (o) => (o ? `Not used by Claude Code now: ${o.words.replace(/; your providers cannot change that$/, '')}` : null);

function linesBox(o) {
  return h('div.own-lines',
    h('p.field-label', `What is taken out of ${o.file}`),
    h('pre.mono.own-pre', `"env": {\n${o.lines.map((l) => `  ${l}`).join(',\n')}\n}`),
    h('p.hint', 'Only these lines. Everything else in the file stays as it is, and a copy of the whole file is kept beside it first.'));
}

/** The panel, or null when the file names no address. `done()` reloads the page. */
export function ownEndpointPanel(o, done) {
  if (!o) return null;
  const busy = (on, ...btns) => btns.forEach((b) => (b.disabled = on));
  const press = async (way) => {
    const take = way === 'takeover';
    const ok = await confirmSheet({
      title: take ? 'Make this gateway a provider?' : 'Take the address out?',
      text: take
        ? `Hoprig adds a provider "Gateway on this computer" with the address and key from Claude Code's settings (the key is kept where provider keys are kept, and never shown), then takes these lines out of the file. A copy of the file is kept beside it.`
        : `Hoprig takes these lines out of Claude Code's settings file. Your providers then decide again where each session goes. A copy of the file is kept beside it, so you can put it back.`,
      ok: take ? 'Make it a provider' : 'Take it out',
    });
    if (!ok) return;
    busy(true, out, take2);
    try {
      const r = await api(`/api/accounts/own-endpoint/${way}`, { stamp: o.stamp });
      toast(take ? `Added the provider "${r.name}". A copy of the old file is kept: see below to put it back.` : 'Done. A copy of the old file is kept: see below to put it back.', { ms: 6000 });
      done();
    } catch (e) {
      toast(e, { kind: 'error', ms: 8000 });
      busy(false, out, take2);
    }
  };
  const out = h('button.btn.primary', { type: 'button', onclick: () => press('remove') }, h('span', 'Take the address out'));
  const take2 = o.hasKey && o.local ? h('button.btn.secondary', { type: 'button', onclick: () => press('takeover') }, h('span', 'Make it a provider')) : null;
  return h('section.panel.own-endpoint', { 'aria-label': "Claude Code's own settings" },
    h('div.banner.warn', icon('alert', { size: 18 }), h('div',
      h('strong', 'Your providers are not the ones Claude Code uses'),
      h('p', `${o.words}. If nothing answers there, chats only say the provider did not answer.`))),
    linesBox(o),
    h('div.btnrow', out, take2),
    take2 ? h('p.hint', '"Make it a provider" keeps that gateway as one of your providers, so you can still choose it.') : null);
}

/**
 * After a press: where the copy of the file as it was is kept, with a copy button and one press to put it back, so the
 * way back does not live only in a toast. null when there is no recent backup (src/codetools/ownsettings.mjs).
 */
export function ownBackupPanel(b, done) {
  if (!b) return null;
  const back = async () => {
    const ok = await confirmSheet({
      title: 'Put the old settings back?',
      text: "Hoprig puts the copy back as Claude Code's settings file. The address in it then decides again where every Claude Code session goes. The file as it is now is kept beside it.",
      ok: 'Put it back',
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await api('/api/accounts/own-endpoint/restore', { name: b.name, stamp: b.stamp });
      toast('The old settings file is back.', { ms: 5000 });
      done();
    } catch (e) {
      toast(e, { kind: 'error', ms: 8000 });
      btn.disabled = false;
    }
  };
  const copy = h('button.btn.secondary', { type: 'button', onclick: async () => toast((await copyText(b.folder)) ? 'Folder copied' : 'Could not copy', { ms: 2500 }) }, h('span', 'Copy the folder'));
  const btn = h('button.btn.secondary', { type: 'button', onclick: back }, h('span', 'Put it back'));
  return h('section.panel.own-backup', { 'aria-label': "Copy of Claude Code's settings" },
    h('p', h('strong', "A copy of Claude Code's old settings file is kept")),
    h('p.hint', `In the folder ${b.folder}, named ${b.name}. To put it back by hand, rename it to settings.json there.`),
    h('div.btnrow', btn, copy));
}

/** The warning as one row: the lines and the two ways out are in its sheet. null when the file names no address. */
export function ownEndpointRow(o, done) {
  if (!o) return null;
  return listRow({ icon: 'alert', title: 'Claude Code uses its own address', sub: 'Your providers are not used', onclick: () => openSheet({ title: 'Claude Code uses its own address' }, (close) => ownEndpointPanel(o, () => { close(); done(); })) });
}

/** The copy that was kept, as one row with its sheet. null when there is none. */
export function ownBackupRow(b, done) {
  if (!b) return null;
  return listRow({ icon: 'info', title: 'A copy of the old settings is kept', onclick: () => openSheet({ title: 'A copy of the old settings is kept' }, (close) => ownBackupPanel(b, () => { close(); done(); })) });
}
