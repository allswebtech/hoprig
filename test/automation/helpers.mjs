// Fakes for the automation tests: session cards, a deck that records what it was asked to do, and a sandbox
// folder for the store. Nothing here touches the real user's setup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const claude = (name, o = {}) => ({
  name, kind: 'claude', cwd: '/w', command: 'node', attached: false, activity: 0,
  profile: { name: 'sub' }, status: 'waiting', statusAt: 1, sessionId: '11111111-1111-4111-8111-111111111111',
  runId: 'r1', stopAt: null, limit: null, runLimit: null, failure: null, ...o,
});

export const shell = (name, o = {}) => ({ name, kind: 'shell', cwd: '/w', command: 'zsh', attached: false, activity: 0, ...o });

export function fakeDeck(cards = []) {
  const d = {
    cards,
    sent: [],
    started: [],
    killed: [],
    failSend: false,
    async list() {
      return d.cards.map((c) => ({ ...c }));
    },
    async send(name, text) {
      if (d.failSend) throw new Error('the terminal is gone');
      // The coding tool is not the program in front (src/server/deck.mjs sendToTool): nothing typed.
      if (d.notInFront) throw Object.assign(new Error(d.notInFront), { status: 409, code: 'not_in_front' });
      d.sent.push([name, text]);
      if (d.onSend) d.onSend(name, text);
    },
    async start(o) {
      d.started.push(o);
      const taken = new Set(d.cards.map((c) => c.name));
      const name = o.name && !taken.has(o.name) ? o.name : `s${d.started.length}`;
      if (d.onStart) d.onStart(name, o);
      return name;
    },
    async kill(name) {
      d.killed.push(name);
      d.cards = d.cards.filter((c) => c.name !== name);
    },
  };
  return d;
}

export function tmpDir(prefix = 'auto') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hop-${prefix}-`));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * An update item (src/automation/updateitems.mjs) that touches nothing: `info` is what it reports, `update` what an
 * update returns; `calls` counts both. `blocked`/`autoBlocked` (cards) → a reason or null.
 */
export function fakeItem(id, o = {}) {
  const facts = o.info || { installed: '1.0.0', latest: '1.0.0', method: 'test', updateAvailable: false, canUpdate: true };
  const it = {
    id,
    title: o.title || id,
    whenRunning: 'test',
    installable: o.installable ?? false,
    calls: { info: 0, update: 0, fresh: 0 },
    async info({ fresh = false } = {}) {
      it.calls.info++;
      if (fresh) it.calls.fresh++;
      if (o.fail) throw new Error(o.fail);
      return typeof facts === 'function' ? facts() : facts;
    },
    async update({ onLine = () => {} } = {}) {
      it.calls.update++;
      onLine(`updating ${id}`);
      if (o.update) return o.update();
      return { ok: true, version: typeof facts === 'function' ? null : facts.latest };
    },
    blocked: o.blocked || (() => null),
    autoBlocked: o.autoBlocked || (() => null),
    autoOk: o.autoOk || (() => true),
  };
  return it;
}

/** A ctx for createAutomation with an in-memory config. */
export function fakeCtx({ deck, automation = {}, persistent = false, now, stateDir, ...rest }) {
  let cfg = { automation };
  const notes = [];
  const lines = [];
  const ctx = {
    deck,
    backend: { kind: persistent ? 'tmux' : 'pty', capabilities: { persistent } },
    config: () => JSON.parse(JSON.stringify(cfg)),
    saveConfig: (patch) => {
      cfg = { ...cfg, ...JSON.parse(JSON.stringify(patch)) };
      return cfg;
    },
    notify: (ev) => notes.push(ev),
    log: (l) => lines.push(l),
    now,
    stateDir,
    conversationExists: () => true,
    updateItems: [fakeItem('claude')],
    addons: [],
    autoOrder: () => [],
    // The workspace rule's engines: never the real ones, which look at the real workspace.
    workspaceSync: async () => ({ repos: [], tools: [] }),
    workspaceMap: async () => ({ lines: [], needs: [] }),
    brainRemote: () => null, // the AI brain's address: never the real brain's
    ...rest,
  };
  return { ctx, notes, lines, config: () => cfg };
}

/** Records the entries an apply() writes to the activity log. */
export function recorder() {
  const entries = [];
  const notes = [];
  return { entries, notes, record: (e) => entries.push(e), notify: (n) => notes.push(n) };
}
