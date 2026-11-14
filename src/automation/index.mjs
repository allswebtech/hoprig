// Automations: things the dashboard does by itself, by fixed rules, with no AI involved.
//
//   queue      send the next queued message each time Claude finishes a reply        ./queue.mjs
//   schedules  start a session or send a message at a set time                        ./schedules.mjs
//   restore    reopen the sessions a restart took away (resumed, nothing typed)        ./restore.mjs
//   retry      after a server error, wait and send "continue" (1, 2, 4 … minutes)      ./retry.mjs
//   updates    look for a new Claude Code; tell, or update it while nothing works      ./updates.mjs
//   idle       close idle plain shells, stop an unused gateway add-on                  ./idle.mjs
//
// Each automation is a pair: decide(state, now) → actions (pure, tested without a server) and apply(actions, ctx)
// (does them). One tick: read the sessions once, let every automation that is on decide and save what it
// remembers, then carry out the actions. Everything done lands in the activity log (<stateDir>/automation.log).
//
// The server hands in `ctx`:
//   deck.list()                         → session cards (see ./cards.mjs for the fields used)
//   deck.start({ dir, profile, mode: 'new'|'resume', sessionId?, name? }) → the new session's name. `profile` is
//                                         a profile name or "auto"; `name` is a wish (taken names get a suffix)
//   deck.send(name, text)               type text into the session and press Enter
//   deck.kill(name)                     close the session
//   backend                             { kind, capabilities: { persistent } }
//   config()                            the current config.json (loadConfig)
//   notify({ title, message, session }) a push notification (the server's notify module)
//   log(line)                           the service log
// Optional (real ones are used when left out; tests pass fakes):
//   saveConfig(patch), stateDir (hoprig's state folder), now(), updates { claudeInfo, claudeUpdate }, addons [{ id, title,
//   profile, status(), stop() }], autoOrder() → profile names, conversationExists(cwd, id), checks { dirOk(dir),
//   profileOk(name) } for schedules.
import path from 'node:path';
import { saveConfig as realSaveConfig } from '../config.mjs';
import { stateDir as realStateDir } from '../paths.mjs';
import { sessionsIn } from '../sessions.mjs';
import * as idleCare from './idle.mjs';
import * as queue from './queue.mjs';
import * as restore from './restore.mjs';
import * as retry from './retry.mjs';
import * as schedules from './schedules.mjs';
import { SCHEDULES_MAX, cleanSchedule, cleanSettingsPatch, newId, readSettings, restoreOn } from './settings.mjs';
import { createActivityLog, createStore } from './store.mjs';
import * as updates from './updates.mjs';

export const FAST_TICK_MS = 5_000; // while a queue or a retry waits for its moment
export const SLOW_TICK_MS = 20_000;

/** The real update checks, loaded only when updates are switched on. */
const realUpdates = {
  async claudeInfo() {
    return (await import('../claudecode.mjs')).claudeInfo();
  },
  async claudeUpdate() {
    return (await import('../claudecode.mjs')).claudeUpdate();
  },
};

async function realAddons() {
  const { ADDONS } = await import('../addons/index.mjs');
  return ADDONS.map((a) => ({ id: a.id, title: a.title, profile: a.profile().name, status: a.status, stop: a.stop }));
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
  const updatesImpl = ctx.updates || realUpdates;
  const conversationExists = ctx.conversationExists || realConversationExists;

  let booted = false;
  let running = null; // the tick in progress
  let closed = false;
  let timer = null;

  const settings = () => readSettings((ctx.config() || {}).automation);
  const saveSettings = (s) => saveConfig({ automation: s });

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

  /** Add a message to a session's queue (schedules and the page use this). */
  const enqueue = (session, text, opts = {}) =>
    store.update('queue', {}, (all) => ({ ...all, [session]: queue.add(all[session], text, { now: now(), id: newId(), ...opts }) }));

  // A failed send goes back to the front. The first two failures may try again at once; after that it waits
  // for the next reply, so a broken terminal does not mean a failed send every tick.
  const putBack = (session, item) =>
    store.update('queue', {}, (all) => {
      const q = all[session] || { paused: false, items: [], sentFor: null };
      const tries = (item.tries || 0) + 1;
      return { ...all, [session]: { ...q, items: [{ ...item, tries }, ...(q.items || [])], sentFor: tries < 3 ? null : q.sentFor } };
    });

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
      const r = restore.decide({ cards, data: store.read('restore', null), now: t, boot, enabled: restoreEnabled });
      store.write('restore', r.data);
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
      if (s.idle.shells || s.idle.gateway) {
        const d = idleCare.decide({ cards, data: store.read('idle', {}), now: t, settings: s.idle, addons, autoOrder });
        store.write('idle', d.data);
        plan.push(['idle', d.actions]);
      }
      if (s.updates.claude !== 'off') {
        const d = updates.decide({ cards, data: store.read('updates', {}), now: t, settings: s.updates });
        store.write('updates', d.data);
        plan.push(['updates', d.actions]);
      }

      const common = { deck, record, notify };
      for (const [name, actions] of plan) {
        if (!actions.length || closed) continue;
        try {
          if (name === 'restore') await restore.apply(actions, { ...common, conversationExists });
          else if (name === 'queue') await queue.apply(actions, { ...common, putBack });
          else if (name === 'retry') await retry.apply(actions, { ...common, prompt: s.retry.prompt, max: s.retry.max });
          else if (name === 'schedules') await schedules.apply(actions, { ...common, enqueue });
          else if (name === 'idle') await idleCare.apply(actions, { ...common, addons });
          else if (name === 'updates') {
            await updates.apply(actions, { ...common, updates: updatesImpl, settings: s.updates, data: store.read('updates', {}), save: (d) => store.write('updates', d) });
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
  async function close() {
    closed = true;
    clearTimeout(timer);
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
        settings: s,
        restoreDefault: !(ctx.backend && ctx.backend.capabilities && ctx.backend.capabilities.persistent),
        restoreOn: restoreOn(s, ctx.backend),
        schedules: s.schedules.list.map((x) => ({
          ...x,
          nextAt: x.enabled ? schedules.nextSlot(x.when, Math.max(t, (last[x.id] && last[x.id].last) || 0)) : null,
          lastAt: (last[x.id] && last[x.id].last) || null,
        })),
        queues: Object.fromEntries(Object.entries(store.read('queue', {})).map(([n, q]) => [n, { paused: !!q.paused, count: (q.items || []).length }])),
      };
    },
    changeSettings(patch) {
      const next = cleanSettingsPatch(patch, settings());
      saveSettings(next);
      return next;
    },
    log: (limit) => activity.recent(limit),
    queueOf(session) {
      const q = store.read('queue', {})[session];
      return { paused: !!(q && q.paused), items: q && q.items ? q.items.map(({ id, text, addedAt }) => ({ id, text, addedAt })) : [] };
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
          if (op === 'clear') return { ...all, [session]: { ...q, items: [] } };
          throw new Error(`unknown queue operation "${op}"`);
        });
      }
      return api.queueOf(session);
    },
    changeSchedules(op, b) {
      const s = settings();
      const list = [...s.schedules.list];
      const at = () => {
        const i = list.findIndex((x) => x.id === b.id);
        if (i < 0) throw Object.assign(new Error('no such schedule'), { status: 404 });
        return i;
      };
      if (op === 'add') {
        if (list.length >= SCHEDULES_MAX) throw new Error(`at most ${SCHEDULES_MAX} schedules`);
        list.push({ ...cleanSchedule(b.schedule, ctx.checks), id: newId(), since: now() });
      } else if (op === 'change') {
        // `since` moves to now: a schedule changed at 10:05 to run at 10:00 starts tomorrow, not right away.
        list[at()] = { ...cleanSchedule(b.schedule, ctx.checks), id: b.id, since: now() };
      } else if (op === 'delete') {
        list.splice(at(), 1);
      } else {
        throw new Error(`unknown schedule operation "${op}"`);
      }
      saveSettings({ ...s, schedules: { ...s.schedules, list } });
      return api.status().schedules;
    },
  };

  return { tick, start, close, nextDelay, enqueue, api, store, activity };
}
