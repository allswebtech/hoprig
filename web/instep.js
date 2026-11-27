// "Not in step": the block on the Projects page (and a computer's page) that lists what is NOT in step between this
// computer and its git servers, and shows nothing at all when everything is. One row and one button each (src/workspace/
// instep.mjs, GET /api/workspace/instep): Show opens the project, Get it brings what the git server has.
//   instepList()                       the list from the server (the last look; no network on the computer)
//   instepBlock(list, { reload })      the block, or null when the list is empty (nothing is drawn)
import { api, btn, h, link, toast } from './lib.js';

/** The list from this computer (or the open one), or an empty one when it cannot be read: a look that fails shows nothing. */
export const instepList = () => api('/api/workspace/instep').catch(() => ({ at: 0, items: [] }));

/** One row per item: { id, text, action: 'get' | 'show' | 'credentials', project }. Nothing for an empty list. */
export function instepRows(list) {
  return ((list && list.items) || []).map((i) => ({
    id: i.id,
    text: i.state === 'credentials' ? i.why : `${i.label}: ${i.why}`,
    action: i.state === 'credentials' ? 'credentials' : i.button === 'Get it' ? 'get' : 'show',
    button: i.button || 'Show',
    project: i.project || '',
  }));
}

/** Wait for the background job of a sync (the same one the project's own Sync starts) to end. */
async function waitJob() {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const j = await api('/api/pcsetup/job?from=0').catch(() => null);
    if (j && !j.running) return j.result || { ok: false };
  }
  return { ok: false };
}

async function press(row, reload) {
  if (row.action === 'credentials') await api('/api/workspace/instep/credentials', {});
  else {
    await api('/api/pcsetup/project/sync', { name: row.project });
    await waitJob();
    await api('/api/workspace/instep/look', { project: row.project });
  }
  await reload();
}

/** The button's name for a screen reader and for the one-door rule: its words and its project, so rows do not repeat. */
const named = (r) => (r.project ? `${r.button} ${r.project}` : r.button);

/** The block, or null when everything is in step. `reload()` draws the page again after a press. */
export function instepBlock(list, { reload = async () => {} } = {}) {
  const rows = instepRows(list);
  if (!rows.length) return null;
  return h('section.instep', { 'aria-label': 'Not in step' },
    h('div.instep-head', h('strong', 'Not in step'),
      btn('ghost small', { label: 'Look now', onclick: async () => {
        await api('/api/workspace/instep/look', {}).catch((e) => toast(e.message));
        await reload();
      } })),
    h('ul.instep-list', rows.map((r) => h('li.instep-row', { dataset: { id: r.id } },
      h('span.instep-text', r.text),
      r.action === 'show'
        ? h('a.btn.small', { href: link(`#/workspace/project/${encodeURIComponent(r.project)}`), 'aria-label': named(r) }, r.button)
        : btn('small', { label: r.button, 'aria-label': named(r), onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await press(r, reload);
          } catch (err) {
            toast(err.message);
            e.currentTarget.disabled = false;
          }
        } })))));
}
