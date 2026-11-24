// Automations: things the dashboard does by itself, by fixed rules, with no AI involved.
//
//   queue      send the next queued message each time Claude finishes a reply        ./queue.mjs
//   schedules  start a session or send a message at a set time                        ./schedules.mjs
//   restore    reopen the sessions a restart took away (resumed, nothing typed)        ./restore.mjs
//   retry      after a server error, wait and send "continue" (1, 2, 4 … minutes)      ./retry.mjs
//   updates    look for new versions (Hoprig, coding tools, tunnel helper); show,      ./updates.mjs
//              tell, or (Automatic) update each at a safe moment                      ./updater.mjs
//   idle       close idle plain shells, stop an unused gateway add-on                  ./idle.mjs
//   workspace  the map keeps building itself; keep the workspace in step (if chosen)   ./workspacesync.mjs
//
// Each automation is a pair: decide(state, now) → actions (pure, tested without a server) and apply(actions, ctx)
// (does them). One tick: read the sessions once, let every automation that is on decide and save what it
// remembers, then carry out the actions. Everything done lands in the activity log (<stateDir>/automation.log).
//
// The server hands in `ctx`:
//   deck.list()                         → session cards (see ./cards.mjs for the fields used)
//   deck.start({ dir, profile, mode: 'new'|'resume', sessionId?, name? }) → the new session's name. `profile` is
//                                         a profile name or "auto"; `name` is a wish (taken names get a suffix)
//   deck.send(name, text)               type text for the session's coding tool and press Enter; only while the
//                                       tool is in front (src/server/typing.mjs), else an error with code
//                                       "not_in_front" (nothing typed) or "typed_not_sent" (no Enter followed)
//   deck.kill(name)                     close the session
//   backend                             { kind, capabilities: { persistent } }
//   config()                            the current config.json (loadConfig)
//   notify({ title, message, session }) a push notification (the server's notify module)
//   log(line)                           the service log
// Optional (real ones are used when left out; tests pass fakes):
//   saveConfig(patch), stateDir (hoprig's state folder), now(), updateItems (./updateitems.mjs), addons [{ id, title,
//   profile, status(), stop() }], autoOrder() → profile names, conversationExists(cwd, id), checks { dirOk(dir),
//   profileOk(name) } for schedules, workspaceSync({ push }) and workspaceMap({ commit, push }) (the workspace rule's engines),
//   label(profile) → the provider's name as the owner reads it, alone(schedule, action) → a run that ends by itself
//   (src/work/schedfeature.mjs), work { itemRuns() → { me, items }, startItem(id), drain() } (./itemruns.mjs; drain:
//   start Work's runs that wait for a place, as far as the switches let them).
import path from 'node:path';
import { saveConfig as realSaveConfig } from '../config.mjs';
import { stateDir as realStateDir } from '../paths.mjs';
import { sessionsIn } from '../sessions.mjs';
import * as idleCare from './idle.mjs';
import * as queue from './queue.mjs';
import * as restore from './restore.mjs';
import * as retry from './retry.mjs';
import * as schedules from './schedules.mjs';
import * as itemRuns from './itemruns.mjs';
import { brainDir, remoteOf } from '../workspace/layout.mjs';
import { SCHEDULES_MAX, cleanSchedule, cleanSettingsPatch, commitMapState, effectiveSettings, newId, readSettings, restoreOn } from './settings.mjs';
import { createActivityLog, createStore } from './store.mjs';
import { readTaken, takenFile, writeTaken } from './taken.mjs';
import { realItems } from './updateitems.mjs';
import { createUpdater } from './updater.mjs';
import { serviceInstalled } from '../server/service/index.mjs';
import { spawnServiceRestart } from '../server/selfrestart.mjs';
import * as updates from './updates.mjs';
import * as workspaceRule from './workspacesync.mjs';

export const FAST_TICK_MS = 5_000; // while a queue or a retry waits for its moment
export const SLOW_TICK_MS = 20_000;

async function realAddons() {
  const { allAddons } = await import('../addons/index.mjs');
  // Only the gateways: an add-on without a profile (the public link) has nothing a session uses, and asking it for one
  // would end every tick.
  return allAddons().filter((a) => a.gateway && typeof a.profile === 'function').map((a) => ({ id: a.id, title: a.title, profile: a.profile().name, status: a.status, stop: a.stop }));
}

async function realAutoOrder() {
  return (await import('../autoswitch.mjs')).getAutoSwitch().order;
}

const realConversationExists = (cwd, id) => sessionsIn(cwd).some((s) => s.id === id);

export function createAutomation(ctx) {
  const now = ctx.now || Date.now;
  const base = ctx.stateDir || realStateDir();
  const store = createStore(path.join(base, 'automation'));
  const activity = createActivityLog(path.join(base, 'automation.log'), { now });
  const saveConfig = ctx.saveConfig || realSaveConfig;
  const log = ctx.log || (() => {});
  const conversationExists = ctx.conversationExists || realConversationExists;

  let booted = false;
  let running = null; // the tick in progress
  let closed = false;
  let timer = null;

  const settings = () => readSettings((ctx.config() || {}).automation);
  // The address of the AI brain's git server, or null: decides "save a change of the map" when the owner never did.
  const brainRemote = ctx.brainRemote || (() => remoteOf(brainDir()));
  const saveSettings = (s) => saveConfig({ automation: s });
  // The old Claude-only update setting is read once into Settings → Updates (./updates.mjs).
  try {
    updates.migrateUpdates(ctx.config() || {}, saveConfig);
  } catch (e) {
    log(`automation: the update settings could not be moved: ${e.message}`);
  }

  const record = (entry) => {
    const e = activity.add(entry);
    log(`automation: ${e.automation}${e.session ? ` [${e.session}]` : ''}: ${e.did} (${e.outcome})`);
  };
  const notify = (ev) => {
    try {
      ctx.notify(ev);
    } catch (e) {
      log(`automation: a notification failed: ${e.message}`);
    }
  };

    // How a restart asked for on the Updates page is carried out (selfrestart.mjs): a detached helper runs once this
  // dashboard has stopped. ctx.restarter lets a test stand in for both.
  const restarter = ctx.restarter || {
    installed: () => serviceInstalled(),
    run: () => {
      spawnServiceRestart();
      // Stop this dashboard a moment later, so the page's answer is sent first; the helper then starts it fresh.
      setTimeout(() => {
        try {
          process.kill(process.pid, 'SIGTERM');
        } catch {
          /* already stopping */
        }
      }, 300).unref();
    },
  };
  const updater = createUpdater({ items: ctx.updateItems || realItems(), cards: () => ctx.deck.list(), config: () => ctx.config() || {}, saveConfig, record, now, restarter });

  /** Add a message to a session's queue (schedules and the page use this). */
  const enqueue = (session, text, opts = {}) =>
    store.update('queue', {}, (all) => ({ ...all, [session]: queue.add(all[session], text, { now: now(), id: newId(), ...opts }) }));

  // A failed send goes back to the front. The first two failures may try again at once; after that it waits
  // for the next reply, so a broken terminal does not mean a failed send every tick.
  // `why`: nothing was typed because the coding tool was not in front (queue.mjs held): no try is counted, the message
  // waits for a coding tool that waits there again, and the row says why. Returns true when that reason is new.
  // `pause`: the message was typed but not sent: the queue pauses until the owner has looked. It did not go, so no
  // reply counts as answered by it: once he resumes, it goes at the next idle moment.
  const putBack = (session, item, { why = null, pause = false } = {}) => {
    let fresh = false;
    store.update('queue', {}, (all) => {
      const q = all[session] || { paused: false, items: [], sentFor: null };
      if (why) {
        fresh = !(q.held && q.held.why === why);
        const held = { why, at: fresh ? now() : q.held.at, ...(pause ? { paused: true } : {}) };
        return { ...all, [session]: { ...q, items: [item, ...(q.items || [])], held, ...(pause ? { paused: true, sentFor: null } : {}) } };
      }
      const tries = (item.tries || 0) + 1;
      return { ...all, [session]: { ...q, items: [{ ...item, tries }, ...(q.items || [])], sentFor: tries < 3 ? null : q.sentFor } };
    });
    return fresh;
  };
  // A message went: the queue no longer waits for a coding tool in front.
  const sent = (session) =>
    store.update('queue', {}, (all) => (all[session] && all[session].held ? { ...all, [session]: { ...all[session], held: null } } : all));

  const deck = {
    ...ctx.deck,
    async has(name) {
      return (await ctx.deck.list()).some((c) => c.name === name);
    },
  };

  /** One round of every automation. Returns what was decided (for tests and the log). */
  async function tick(at) {
    if (closed) return { skipped: 'closed' };
    if (running) return running;
    running = (async () => {
      const s = settings();
      if (s.paused) return { paused: true };
      // Everything that waits comes first; after the cards arrive, every decision and save is synchronous, so a
      // queue change from the page cannot slip in between reading and writing.
      const needGateways = s.idle.gateway;
      const [addons, autoOrder] = needGateways ? await Promise.all([ctx.addons ? Promise.resolve(ctx.addons) : realAddons(), (ctx.autoOrder || realAutoOrder)()]) : [[], []];
      let cards;
      try {
        cards = await ctx.deck.list();
      } catch (e) {
        log(`automation: could not list the sessions: ${e.message}`);
        return { error: e.message };
      }
      if (closed) return { skipped: 'closed' };
      const t = at ?? now();
      const boot = !booted;
      booted = true;
      const plan = [];

      const restoreEnabled = restoreOn(s, ctx.backend);
      // The terminals "Continue here" took a conversation from (./taken.mjs): read fresh, written by the chat's take().
      const takenNow = readTaken(takenFile(base));
      const r = restore.decide({ cards, data: store.read('restore', null), now: t, boot, enabled: restoreEnabled, taken: takenNow });
      store.write('restore', r.data);
      if (r.taken.length !== takenNow.length) writeTaken(r.taken, takenFile(base));
      plan.push(['restore', r.actions]);

      if (s.queue.enabled) {
        const q = queue.decide({ cards, data: store.read('queue', {}), now: t });
        store.write('queue', q.data);
        plan.push(['queue', q.actions]);
      }
      if (s.retry.enabled) {
        const d = retry.decide({ cards, data: store.read('retry', {}), now: t, max: s.retry.max, firstMinutes: s.retry.firstMinutes });
        store.write('retry', d.data);
        plan.push(['retry', d.actions]);
      }
      if (s.schedules.enabled) {
        const d = schedules.decide({ schedules: s.schedules.list, lateHours: s.schedules.lateHours, data: store.read('schedules', {}), now: t });
        store.write('schedules', d.data);
        plan.push(['schedules', d.actions]);
      }
      // Items of Work with a run time ("run by AI at 07:30") that name THIS computer (./itemruns.mjs); the repeating
      // items whose day came round move on first. Under the schedules switch, the master switch of what starts by itself.
      if (s.schedules.enabled && ctx.work) {
        let w = null;
        try {
          w = await ctx.work.itemRuns();
        } catch (e) {
          log(`automation: Work's items could not be read: ${e.message}`);
        }
        if (w) {
          const d = itemRuns.decide({ items: w.items, me: w.me, lateHours: s.schedules.lateHours, data: store.read('items', {}), now: t });
          store.write('items', d.data);
          plan.push(['items', d.actions]);
        }
      }
      if (s.idle.shells || s.idle.gateway) {
        const d = idleCare.decide({ cards, data: store.read('idle', {}), now: t, settings: s.idle, addons, autoOrder });
        store.write('idle', d.data);
        plan.push(['idle', d.actions]);
      }
      // Updates look by themselves only to install (Automatic) or to tell (notify on); otherwise the Updates page
      // looks when it is opened, so a default dashboard asks no server anything in the background.
      const us = updater.settings();
      if (updates.looksInBackground(us)) {
        const u = updates.decide({ cards, data: store.read('updates', {}), now: t });
        store.write('updates', u.data);
        plan.push(['updates', u.actions]);
      }
      if (s.workspace.sync || s.workspace.map || Object.values(s.workspace.pushBranches || {}).some(Boolean)) {
        const d = workspaceRule.decide({ data: store.read('workspace', {}), now: t, boot, settings: effectiveSettings(s, brainRemote).workspace });
        store.write('workspace', d.data);
        plan.push(['workspace', d.actions]);
      }

      // Work's runs that wait for a place start first, oldest first: after a pause or with schedules switched back
      // on, nothing else starts them until another run ends (src/work/alone.mjs drain checks the switches itself).
      if (ctx.work && ctx.work.drain && !closed) {
        try {
          await ctx.work.drain();
        } catch (e) {
          log(`automation: the runs that wait could not start: ${e.message}`);
        }
      }
      const common = { deck, record, notify };
      for (const [name, actions] of plan) {
        if (!actions.length || closed) continue;
        try {
          if (name === 'restore') await restore.apply(actions, { ...common, conversationExists, label: ctx.label, later, closed: () => closed });
          else if (name === 'queue') await queue.apply(actions, { ...common, putBack, sent });
          else if (name === 'retry') await retry.apply(actions, { ...common, prompt: s.retry.prompt, max: s.retry.max });
          else if (name === 'schedules') await schedules.apply(actions, { ...common, enqueue, label: ctx.label, alone: ctx.alone });
          else if (name === 'items') await itemRuns.apply(actions, { ...common, startItem: ctx.work.startItem });
          else if (name === 'idle') await idleCare.apply(actions, { ...common, addons });
          else if (name === 'workspace') {
            await workspaceRule.apply(actions, { ...common, workspaceSync: ctx.workspaceSync || workspaceRule.realWorkspaceSync, workspaceMap: ctx.workspaceMap || workspaceRule.realWorkspaceMap, workspaceBranches: ctx.workspaceBranches || workspaceRule.realWorkspaceBranches, workspaceCredentials: ctx.workspaceCredentials || workspaceRule.realWorkspaceCredentials, data: store.read('workspace', {}), save: (d) => store.write('workspace', d) });
          } else if (name === 'updates') {
            await updates.apply(actions, { ...common, updater, settings: us, now, data: store.read('updates', {}), save: (d) => store.write('updates', d) });
          }
        } catch (e) {
          record({ automation: name, did: 'stopped with an unexpected error', outcome: `failed: ${e.message}` });
        }
      }
      return { plan: Object.fromEntries(plan) };
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  /** How soon the next tick should come: soon while a queued message or a retry waits for its moment. */
  function nextDelay() {
    const s = settings();
    if (s.paused) return SLOW_TICK_MS;
    const waiting = s.queue.enabled && Object.values(store.read('queue', {})).some((q) => !q.paused && q.items && q.items.length);
    const retrying = s.retry.enabled && Object.keys(store.read('retry', {})).length > 0;
    return waiting || retrying ? FAST_TICK_MS : SLOW_TICK_MS;
  }

  let loop = null;
  function start() {
    closed = false;
    loop = async () => {
      await tick().catch((e) => log(`automation: ${e.message}`));
      if (closed) return;
      timer = setTimeout(loop, nextDelay());
      timer.unref?.();
    };
    timer = setTimeout(loop, 1000);
    timer.unref?.();
  }

  /** The owner just changed something: look at it now, not at the next slow tick. */
  function soon() {
    if (!loop || closed || running) return;
    clearTimeout(timer);
    timer = setTimeout(loop, 300);
    timer.unref?.();
  }

  /** Stop ticking and wait for a tick in progress. Call it before the backend closes its terminals. */
  // A restore's second try (restore.mjs RETRY_MS) runs by itself, not inside a tick; it ends with the automations.
  const retries = new Set();
  function later(fn, ms) {
    const t = setTimeout(() => {
      retries.delete(t);
      if (!closed) fn().catch((e) => log(`automation: ${e.message}`));
    }, ms);
    t.unref?.();
    retries.add(t);
  }

  async function close() {
    closed = true;
    clearTimeout(timer);
    for (const t of retries) clearTimeout(t);
    retries.clear();
    if (running) await running.catch(() => {});
  }

  // ---- what the page calls (see ./feature.mjs) ----
  const api = {
    settings,
    status() {
      const s = settings();
      const t = now();
      const last = store.read('schedules', {});
      return {
        // `updates.claude`: the old setting's value, for older pages and Tia's rule (Settings → Updates holds it now)
        settings: { ...effectiveSettings(s, brainRemote), updates: { claude: updates.legacyValue(updater.settings()) } }, // commitMap true or false, as it acts
        commitMap: commitMapState(s.workspace, brainRemote()), // and why: chosen, or from the brain's address
        restoreDefault: !(ctx.backend && ctx.backend.capabilities && ctx.backend.capabilities.persistent),
        restoreOn: restoreOn(s, ctx.backend),
        // The computer's time zone: the page shows when a schedule runs next on this computer's clock, as its rule.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        schedules: s.schedules.list.map((x) => ({
          ...x,
          nextAt: x.enabled ? schedules.nextSlot(x.when, Math.max(t, (last[x.id] && last[x.id].last) || 0)) : null,
          lastAt: (last[x.id] && last[x.id].last) || null,
        })),
        queues: Object.fromEntries(Object.entries(store.read('queue', {})).map(([n, q]) => [n, { paused: !!q.paused, count: (q.items || []).length, ...(q.held && q.held.why ? { waits: q.held.why } : {}) }])),
      };
    },
    changeSettings(patch) {
      // An older page (or Tia) may still send the old update setting { updates: { claude } }: it becomes the new one.
      const old = patch && typeof patch === 'object' ? patch.updates : undefined;
      let up = null;
      if (old !== undefined) {
        if (!old || typeof old !== 'object' || Object.keys(old).some((k) => k !== 'claude')) throw Object.assign(new Error('updates are set in Settings → Updates'), { status: 400, details: { code: 'updates-moved' } }); // the code of that place (web/errorways.js): the page draws its button
        if ('claude' in old) up = updates.fromLegacy(old.claude, updater.settings());
      }
      const rest = old === undefined ? patch : Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'updates'));
      const next = cleanSettingsPatch(rest, settings());
      if (up) updater.changeSettings(up);
      saveSettings(next);
      soon(); // switched back on: what waits starts now, not at the next slow tick
      return { ...effectiveSettings(next, brainRemote), updates: { claude: updates.legacyValue(updater.settings()) } };
    },
    log: (limit) => activity.recent(limit),
    queueOf(session) {
      const q = store.read('queue', {})[session];
      return { paused: !!(q && q.paused), items: q && q.items ? q.items.map(({ id, text, addedAt }) => ({ id, text, addedAt })) : [], ...(q && q.held && q.held.why ? { waits: q.held.why } : {}) };
    },
    async changeQueue(session, op, b) {
      if (op === 'add') {
        if (!(await deck.has(session))) throw Object.assign(new Error('no such session'), { status: 404 });
        enqueue(session, b.text, b.position === undefined ? {} : { position: b.position });
        soon();
      } else {
        store.update('queue', {}, (all) => {
          const q = all[session] || { paused: false, items: [] };
          if (op === 'remove') return { ...all, [session]: queue.remove(q, b.id) };
          if (op === 'move') return { ...all, [session]: queue.move(q, b.id, b.to) };
          if (op === 'pause') {
            if (!b.paused) soon();
            return { ...all, [session]: queue.pause(q, b.paused) };
          }
          if (op === 'clear') return { ...all, [session]: queue.unheld({ ...q, items: [] }) };
          throw new Error(`unknown queue operation "${op}"`);
        });
      }
      return api.queueOf(session);
    },
    // `hers`: the request came through Tia's door (feature.mjs). The body's own word is dropped: a schedule is hers
    // when she added or changed it, and stays hers once it is.
    changeSchedules(op, b, { hers = false } = {}) {
      const s = settings();
      const list = [...s.schedules.list];
      const at = () => {
        const i = list.findIndex((x) => x.id === b.id);
        if (i < 0) throw Object.assign(new Error('no such schedule'), { status: 404 });
        return i;
      };
      if (op === 'add') {
        if (list.length >= SCHEDULES_MAX) throw new Error(`at most ${SCHEDULES_MAX} schedules`);
        const { hers: _said, ...given } = cleanSchedule(b.schedule, ctx.checks);
        list.push({ ...given, ...(hers ? { hers: true } : {}), id: newId(), since: now() });
      } else if (op === 'change') {
        // `since` moves to now: a schedule changed at 10:05 to run at 10:00 starts tomorrow, not right away.
        const i = at();
        const { hers: _said, ...given } = cleanSchedule(b.schedule, ctx.checks);
        list[i] = { ...given, ...(hers || list[i].hers === true ? { hers: true } : {}), id: b.id, since: now() };
      } else if (op === 'delete') {
        list.splice(at(), 1);
      } else {
        throw new Error(`unknown schedule operation "${op}"`);
      }
      saveSettings({ ...s, schedules: { ...s.schedules, list } });
      return api.status().schedules;
    },
  };

  return { tick, start, close, nextDelay, enqueue, api, store, activity, updater };
}
