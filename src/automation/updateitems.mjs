// What Settings → Updates looks after: Hoprig itself, the coding tools this version offers and the tunnel helper (cloudflared, for
// the public link). One item each, all with the same shape, so the page, the command line and the automatic rule
// treat them alike:
//
//   id, title
//   whenRunning        one sentence under the row: what an update does to what is running now
//   info()             → { installed, latest, method, updateAvailable, canUpdate, why?, note? }
//                        installed null: not installed. latest null: could not be looked up (offline).
//                        canUpdate false: this install is not updated from here; `why` says so in plain words.
//   installable        a missing item may be installed from the row (the coding tools)
//   update({ onLine }) → { ok, version, output }: update, or install when it is missing
//   blocked(cards)     → null, or the sentence that says why it must wait now (both for "Update now" and for
//                        Automatic); `autoBlocked(cards)` (optional) adds what only Automatic waits for
//   autoOk(info)       may Automatic update this install at all
//
// The rules: Hoprig never updates by itself (a running dashboard loads a new version only when it restarts), and a
// git checkout is never part of "Update all" nor pulled with uncommitted changes; a coding tool updates by itself only while none of
// its sessions is working (Claude Code: a running session keeps its own copy) or open at all (Codex, OpenCode: npm
// replaces their program files); the tunnel helper never while a public link is on (a Temporary link would come
// back with a new address).
import { TOOLS, findTool, turnOn } from '../codetools/index.mjs';
import { readyToReplace, toolRuns } from '../codetools/servers.mjs';
import { gitRead } from '../gitread.mjs';
import { forInstalls } from '../secretenv.mjs';
import { capture, compareVersions, npmMajor, showCommand, stream } from '../setup/system.mjs';
import { busy, toolOf } from './cards.mjs';

export { toolOf };
const plural = (n, one) => `${n} ${one} session${n === 1 ? '' : 's'}`;

// ---------- Hoprig ----------

/**
 * A git checkout's facts without changing anything in it (no fetch: `ls-remote` only reads the server).
 * → { head, upstream, remoteHead, newer: true|false|null, error }
 */
// git never asks for a password here: a server that wants one is "could not reach", not a 20-second wait.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

export async function gitFacts(root, run = capture) {
  // The checkout's own state through the reader (gitread.mjs); only ls-remote talks to the server.
  const git = (...a) => gitRead(root, a, { run, timeout: 20_000 });
  const head = (await git('rev-parse', 'HEAD')).stdout.trim() || null;
  const up = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  const upstream = up.ok ? up.stdout.trim() : '';
  if (!upstream || !upstream.includes('/')) return { head, upstream: null, remoteHead: null, newer: null };
  const [remote, ...rest] = upstream.split('/');
  const branch = rest.join('/');
  const ls = await run(['git', '-C', root, 'ls-remote', '--heads', remote, `refs/heads/${branch}`], { timeout: 20_000, env: GIT_ENV });
  const remoteHead = ls.ok ? (/^([0-9a-f]{40,64})\s/m.exec(ls.stdout) || [])[1] || null : null;
  if (!remoteHead) return { head, upstream, remoteHead: null, newer: null, error: 'could not reach the git server' };
  if (remoteHead === head) return { head, upstream, remoteHead, newer: false };
  // Known here and already in HEAD: this checkout is ahead, nothing newer. Unknown or not in HEAD: newer commits.
  const anc = await git('merge-base', '--is-ancestor', remoteHead, 'HEAD');
  return { head, upstream, remoteHead, newer: anc.code !== 0 };
}

export function hoprigItem(deps = {}) {
  const run = deps.run || capture;
  const sel = () => deps.selfupdate || import('../setup/selfupdate.mjs');
  const chk = () => deps.checks || import('../setup/checks.mjs');
  return {
    id: 'hoprig',
    title: 'Hoprig',
    whenRunning:
      'The new version is used after the dashboard restarts: sessions kept by tmux go on through the restart, sessions in the built-in terminals end then (their conversations can be continued). Hoprig never updates itself: Automatic tells you, and you choose the moment.',
    installable: false,
    async info() {
      const [{ installKind, newestVersion }, { appRoot, appVersion }] = await Promise.all([sel(), chk()]);
      const root = appRoot();
      const kind = installKind(root);
      const installed = appVersion();
      if (kind === 'git') {
        const g = await gitFacts(root, run);
        // Never part of "Update all": it pulls into the folder the dashboard runs from (a developer's checkout).
        const git = { notInAll: 'a git checkout is updated on its own (Update now on its card)' };
        const short = (h) => (h ? h.slice(0, 7) : '');
        const base = { installed: g.head ? `${installed} (${short(g.head)})` : installed, method: 'git checkout' };
        if (!g.upstream) return { ...base, latest: null, updateAvailable: false, canUpdate: false, why: 'This checkout follows no branch on a server: update it with git yourself.' };
        if (g.newer === null) return { ...base, ...git, latest: null, updateAvailable: false, canUpdate: true, note: g.error || null };
        return { ...base, ...git, latest: g.newer ? `newer commits on ${g.upstream}` : base.installed, updateAvailable: g.newer, canUpdate: true };
      }
      if (kind === 'npm') {
        // From where the install and the update come from (paths.mjs hoprigSource): unknown is null with a note.
        const { version: latest, note } = await newestVersion();
        return { installed, method: 'npm', latest, updateAvailable: !!(latest && installed && compareVersions(latest, installed) > 0), canUpdate: true, note: note || null };
      }
      return { installed, method: 'copied folder', latest: null, updateAvailable: false, canUpdate: false, why: 'Installed from a copied folder or a tarball: install it again the way you did first.' };
    },
    async update({ onLine = () => {} } = {}) {
      const [{ installKind, updatePlan }, { appRoot, appVersion }] = await Promise.all([sel(), chk()]);
      const root = appRoot();
      const kind = installKind(root);
      if (kind === 'git') {
        // A pull into a checkout with work in it is the developer's to do, not a button's.
        const st = await gitRead(root, ['status', '--porcelain', '--untracked-files=no'], { run, timeout: 20_000 });
        if (!st.ok || st.stdout.trim()) {
          const why = st.ok ? 'The checkout has changes that are not committed: update it with git yourself.' : 'git could not read the checkout.';
          onLine(why);
          return { ok: false, version: appVersion(), output: why };
        }
      }
      const plan = updatePlan(kind, root, process.platform, kind === 'npm' ? await npmMajor({ env: forInstalls(process.env) }) : null);
      if (!plan.length) {
        onLine('This install cannot update itself: install it again the way you did first.');
        return { ok: false, version: appVersion(), output: '' };
      }
      for (const step of plan) {
        onLine(`$ ${showCommand(step.argv)}`);
        const r = await (deps.stream || stream)(step.argv, { cwd: step.cwd, env: forInstalls(process.env), onLine });
        if (!r.ok && step.ifFails) onLine(step.ifFails);
        else if (!r.ok) return { ok: false, version: appVersion(), output: `exit code ${r.code}` };
      }
      onLine('Done. Restart the dashboard to use the new version (hoprig service restart starts the background one again; on Windows type it in PowerShell, not in the dashboard\'s own terminal). Until then it runs the version it started with.');
      return { ok: true, version: appVersion(), output: '', restart: true };
    },
    blocked: () => null,
    // Never by itself: the files change under the running dashboard, and only a restart loads the new version as a
    // whole (until then a part loaded later would come from the new files next to the old ones). Automatic tells.
    autoOk: () => false,
  };
}

// ---------- the coding tools ----------

export function toolItem(id, deps = {}) {
  const tool = deps.tool || findTool(id);
  const keepsCopy = tool.updateItem.whenRunning === 'keeps-copy';
  const mine = (cards) => cards.filter((c) => toolOf(c) === id);
  return {
    id,
    title: tool.name,
    whenRunning: keepsCopy
      ? `Running sessions keep the version they started with and use the new one when they start again. Automatic updates wait until no ${tool.name} session is working.`
      : `Close its sessions first: the update replaces the program's files. Automatic updates wait until no ${tool.name} session is open.`,
    installable: true,
    async info({ fresh = false } = {}) {
      const i = await tool.info({ fresh });
      const method = { hoprig: "Hoprig's tools folder", native: 'official installer', npm: 'npm', unknown: 'a package manager' }[i.method] || i.method || 'unknown';
      const note = !tool.managed ? null
        : !i.installed ? `Installs ${tool.pin}, the version this Hoprig is tested with.`
          : i.latest && compareVersions(i.latest, tool.pin) > 0 ? `This Hoprig is tested with ${tool.pin}: a newer version may behave differently.` : null;
      return { installed: i.installed, latest: i.latest, method, updateAvailable: !!i.updateAvailable, canUpdate: true, note };
    },
    async update({ onLine = () => {} } = {}) {
      // Missing: install it (a managed tool at its tested version) and turn it on. Present: update it, once nothing
      // of it runs (its server is stopped here when nobody uses it).
      if (tool.installedVersion()) {
        const why = keepsCopy ? null : await (deps.readyToReplace || readyToReplace)(id);
        if (why) {
          onLine(`${why}. Nothing changed.`);
          return { ok: false, version: tool.installedVersion(), output: why };
        }
        return tool.update({ onLine });
      }
      const r = await tool.install({ onLine });
      if (r.ok) (deps.turnOn || turnOn)(id);
      return { ...r, installed: true };
    },
    blocked(cards) {
      if (keepsCopy) return null;
      // The dashboard's cards, and the sessions started in a terminal it does not hold (`hoprig codex …`): each has
      // a run record. Its server is looked at when the update starts (readyToReplace).
      const n = Math.max(mine(cards).length, (deps.runs || toolRuns)(id).length);
      return n ? `${plural(n, tool.name)} open: close ${n === 1 ? 'it' : 'them'} first` : null;
    },
    autoBlocked(cards) {
      if (!keepsCopy) return null;
      const n = mine(cards).filter(busy).length;
      return n ? `${plural(n, `working ${tool.name}`)}` : null;
    },
    autoOk: (info) => !!info.installed,
  };
}

// ---------- the tunnel helper ----------

export function tunnelItem(deps = {}) {
  const cf = () => deps.cloudflared || import('../addons/cloudflared.mjs');
  const pl = () => deps.publiclink || import('../addons/publiclink.mjs');
  const run = deps.run || capture;
  async function facts() {
    const [c, p] = await Promise.all([cf(), pl()]);
    const bin = c.findBin();
    let installed = null;
    if (bin) installed = (/(\d{4}\.\d+\.\d+)/.exec((await run([bin, '--version'], { timeout: 10_000 })).stdout || '') || [])[1] || null;
    const own = !!bin && bin.startsWith(c.binDir());
    return { c, p, bin, installed, own, pin: p.CLOUDFLARED_VERSION };
  }
  return {
    id: 'cloudflared',
    title: 'The helper for the public link (cloudflared)',
    whenRunning: 'Turn the public link off first: a Temporary link comes back with a new address. Automatic updates wait until the public link is off.',
    installable: false,
    async info() {
      const f = await facts();
      const base = { installed: f.installed, latest: f.pin, method: f.own ? "Hoprig's add-ons folder" : f.bin ? 'the system' : null };
      if (!f.bin) return { ...base, updateAvailable: false, canUpdate: false, why: 'Installs itself the first time the public link is turned on.' };
      const newer = !!(f.installed && compareVersions(f.pin, f.installed) > 0);
      if (!f.own) return { ...base, updateAvailable: newer, canUpdate: false, why: 'Installed by the system: update it with its package manager (on a Mac: brew upgrade cloudflared).' };
      return { ...base, updateAvailable: newer, canUpdate: true, note: 'Hoprig ships the version it is tested with; it comes with a Hoprig update.' };
    },
    async update({ onLine = () => {} } = {}) {
      const { p } = await facts();
      const r = await p.update({ onLine });
      const after = await facts();
      return { ok: !!r.ok, version: after.installed, output: r.error || '' };
    },
    blocked() {
      // Read at the moment of asking: the Public link switch (src/addons/linkswitch.mjs).
      const c = deps.linkState ? deps.linkState() : null;
      return c && c.on ? `The public link is on (${c.kind}): turn it off first` : null;
    },
    autoOk: (info) => info.method === "Hoprig's add-ons folder",
    // The link state needs the switch's module; loaded once before blocked() is asked.
    async prepare() {
      if (deps.linkState) return;
      const ls = deps.linkswitch || (await import('../addons/linkswitch.mjs'));
      deps.linkState = () => publicLinkState(ls);
    },
  };
}

/**
 * Is a public link on, for the tunnel helper's rule: { on, kind: 'Temporary'|'Custom' }. The owner's switch
 * (config.json publicLink, either kind) counts while it is on, also while it starts or tries again; after it was
 * turned off, a cloudflared of ours that the switch's record still names counts until it has ended.
 * `ls`: the switch's module (readSwitch, readRecord, ours); `cfg`: for tests.
 */
export function publicLinkState(ls, cfg) {
  const name = (k) => (k === 'custom' ? 'Custom' : 'Temporary');
  const s = ls.readSwitch(cfg);
  if (s.on) return { on: true, kind: name(s.kind) };
  const rec = ls.readRecord() || {};
  return rec.pid && ls.ours(rec.pid) ? { on: true, kind: name(rec.kind) } : { on: false };
}

/** The items, in the order the page shows them: Hoprig, each offered coding tool (src/codetools/index.mjs), the tunnel helper. */
export const realItems = (deps = {}) => [hoprigItem(deps), ...TOOLS.map((t) => toolItem(t.id)), tunnelItem(deps)];
