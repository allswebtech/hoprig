// Updates: look for new versions of everything Settings → Updates lists (./updateitems.mjs) every 6 hours (never
// while a session is working: it waits for the next quiet tick), and
//   manual (the default)  tell the owner once per new version when "notify" is on; nothing is ever installed by
//                         itself. With notify off nothing looks in the background: the page looks when it is opened
//   auto                  also install them, each one only at a safe moment (its item says when: ./updateitems.mjs)
//                         and never one that is not installed
// An update that has to wait is tried again 10 minutes later, and the wait is written to the log once per version.
//
// config.json "updates": { mode: 'manual' | 'auto', notify: true | false, itemModes?: { <id>: 'manual' | 'auto' } }.
// `itemModes` lets one item go its own way. It exists for the Claude-only automation setting this replaced
// (automation.updates.claude: off | notify | auto), read once into it (migrateUpdates): an owner who let Claude Code
// update itself keeps exactly that (itemModes.claude 'auto'), and nothing else starts installing by itself without
// a new choice.
//
// Stored (automation store "updates"): { lastCheckAt, retryAt, told: { id: version }, waiting: { id: version } }.
import { busy } from './cards.mjs';

export const CHECK_EVERY_MS = 6 * 3600_000;
export const RETRY_MS = 10 * 60_000;
export const UPDATE_MODES = ['manual', 'auto'];
/** What Settings → Updates lists (./updateitems.mjs realItems). */
export const UPDATE_ITEMS = ['hoprig', 'claude', 'codex', 'opencode', 'cloudflared'];
const LEGACY = ['off', 'notify', 'auto'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanItemModes(v) {
  const out = {};
  if (isObj(v)) for (const id of UPDATE_ITEMS) if (UPDATE_MODES.includes(v[id])) out[id] = v[id];
  return out;
}

/** The settings with `itemModes` only when an item goes its own way (the plain shape otherwise). */
const shaped = (mode, notify, itemModes) => ({ mode, notify, ...(Object.keys(itemModes).length ? { itemModes } : {}) });

/** The update settings from config.json; until they exist, from the old Claude-only setting. Never throws. */
export function readUpdateSettings(cfg) {
  const u = cfg && cfg.updates;
  if (isObj(u) && UPDATE_MODES.includes(u.mode)) return shaped(u.mode, u.notify === true, cleanItemModes(u.itemModes));
  const old = cfg && isObj(cfg.automation) && isObj(cfg.automation.updates) ? cfg.automation.updates.claude : undefined;
  // Old "auto" meant Claude Code updates itself, nothing more: only that item does.
  return shaped('manual', old === 'notify', old === 'auto' ? { claude: 'auto' } : {});
}

/** How `id` is updated: its own mode when it has one, else the one for everything. */
export const modeOf = (s, id) => (s.itemModes && s.itemModes[id]) || s.mode;

/** Does anything look by itself in the background? Only to install (Automatic, for all or one item) or to tell. */
export const looksInBackground = (s) => s.mode === 'auto' || s.notify || Object.values(s.itemModes || {}).includes('auto');

/**
 * A change from the page: { mode?, notify?, itemModes? } (itemModes: { <id>: 'manual' | 'auto' | null }, null: the
 * item follows the mode for everything again). Unknown keys and values are refused with a plain sentence.
 */
export function cleanUpdateSettings(patch, current) {
  if (!isObj(patch)) throw new Error('send the update settings as an object');
  let { mode, notify } = current;
  const itemModes = { ...(current.itemModes || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'mode') {
      if (!UPDATE_MODES.includes(v)) throw new Error('updates are "manual" or "auto"');
      mode = v;
    } else if (k === 'notify') {
      if (typeof v !== 'boolean') throw new Error('notify must be on or off (true or false)');
      notify = v;
    } else if (k === 'itemModes') {
      if (!isObj(v)) throw new Error('itemModes is an object of item and mode');
      for (const [id, m] of Object.entries(v)) {
        if (!UPDATE_ITEMS.includes(id)) throw new Error(`"${String(id).slice(0, 40)}" is not updated here`);
        if (m === null) delete itemModes[id];
        else if (UPDATE_MODES.includes(m)) itemModes[id] = m;
        else throw new Error('an item\'s updates are "manual", "auto" or null');
      }
    } else throw new Error(`"${String(k).slice(0, 40)}" is not an update setting`);
  }
  return shaped(mode, notify, itemModes);
}

/** The old setting's value from the new settings, for pages and helpers that still ask for it. */
export const legacyValue = (s) => (modeOf(s, 'claude') === 'auto' ? 'auto' : s.notify ? 'notify' : 'off');

/**
 * The old setting's value sent by an older page (or Tia), as a change of the new settings (`current`), such that
 * legacyValue() then reads back what was sent. It was about Claude Code only:
 *   auto           Claude Code updates itself (its own mode)
 *   notify / off   telling on / off; Claude Code no longer goes its own way, unless everything is Automatic, where it
 *                  must be held back by its own 'manual' (the old setting never installed anything in these two)
 * Throws for anything else.
 */
export function fromLegacy(v, current = { mode: 'manual' }) {
  if (!LEGACY.includes(v)) throw new Error(`Claude Code updates must be one of: ${LEGACY.join(', ')}`);
  if (v === 'auto') return { itemModes: { claude: 'auto' } };
  return { notify: v === 'notify', itemModes: { claude: current.mode === 'auto' ? 'manual' : null } };
}

/**
 * Read the old Claude-only setting into the new one, once: writes config.json "updates" and drops
 * automation.updates. Returns true when it wrote something.
 */
export function migrateUpdates(cfg, saveConfig) {
  const a = cfg && isObj(cfg.automation) ? cfg.automation : null;
  if (!a || !('updates' in a)) return false;
  const { updates, ...rest } = a;
  const has = isObj(cfg.updates) && UPDATE_MODES.includes(cfg.updates.mode);
  saveConfig({ ...(has ? {} : { updates: readUpdateSettings(cfg) }), automation: rest });
  return true;
}

/** Is it time to look? → { actions: [{ type: 'check' }] | [], data } */
export function decide({ cards = [], data, now }) {
  const d = { lastCheckAt: 0, ...(data || {}) };
  const due = d.retryAt && d.retryAt < d.lastCheckAt + CHECK_EVERY_MS ? d.retryAt : d.lastCheckAt + CHECK_EVERY_MS;
  if (now < due || cards.some(busy)) return { actions: [], data: d };
  return { actions: [{ type: 'check' }], data: { ...d, lastCheckAt: now, retryAt: 0 } };
}

/**
 * What to do with what the look found. Pure. rows: the updater's rows (./updater.mjs). → { actions, data } with
 * actions { type: 'tell' | 'update', id, title, current, latest }.
 */
export function afterCheck({ rows, settings, data }) {
  const d = { ...data, told: { ...((data && data.told) || {}) } };
  const actions = [];
  for (const r of rows) {
    if (!r.installed || !r.updateAvailable || !r.latest) continue;
    const a = { id: r.id, title: r.title, current: r.installed, latest: r.latest };
    const auto = modeOf(settings, r.id) === 'auto';
    if (auto && r.canUpdate && r.auto) actions.push({ type: 'update', ...a });
    // Told once per version: with notify on, and also in Automatic for what Automatic does not install itself
    // (Hoprig: the running dashboard would need a restart), so the owner learns of it.
    else if ((settings.notify || auto) && d.told[r.id] !== r.latest) {
      actions.push({ type: 'tell', ...a });
      d.told[r.id] = r.latest;
    }
  }
  return { actions, data: d };
}

/** ctx: { updater, settings, data, save(data), record(entry), notify(ev), now() }. */
export async function apply(actions, ctx) {
  if (!actions.some((a) => a.type === 'check')) return;
  let view;
  try {
    view = await ctx.updater.view({ fresh: true });
  } catch (e) {
    ctx.record({ automation: 'updates', did: 'could not look for new versions', outcome: `failed: ${e.message}` });
    return;
  }
  const found = afterCheck({ rows: view.items, settings: ctx.settings, data: ctx.data });
  let data = { ...found.data, waiting: { ...((found.data && found.data.waiting) || {}) } };
  if (!found.actions.length) ctx.record({ automation: 'updates', did: 'looked for new versions', outcome: 'nothing new' });
  for (const a of found.actions) {
    if (a.type === 'tell') {
      ctx.record({ automation: 'updates', did: `${a.title} ${a.latest} is available (you have ${a.current})`, outcome: 'told the owner' });
      ctx.notify({ title: `${a.title} ${a.latest} is available`, message: `You have ${a.current}. Settings → Updates installs it.`, session: '' });
      continue;
    }
    // Look again right before: a session may have started meanwhile (the updater asks the item with fresh cards).
    const r = await ctx.updater.auto(a.id);
    if (r.waited) {
      if (data.waiting[a.id] !== a.latest) ctx.record({ automation: 'updates', did: `${a.title} ${a.latest} waits`, outcome: `postponed: ${r.waited}` });
      data.waiting[a.id] = a.latest;
      data.retryAt = ctx.now() + RETRY_MS;
      continue;
    }
    delete data.waiting[a.id];
    const outcome = r.ok ? `ok: now ${r.version || a.latest}` : `failed: ${r.error || 'see the log'}`;
    ctx.record({ automation: 'updates', did: `updated ${a.title} from ${a.current} to ${a.latest}`, outcome });
    ctx.notify({ title: r.ok ? `${a.title} updated to ${r.version || a.latest}` : `${a.title} update failed`, message: outcome, session: '' });
  }
  ctx.save(data);
}
