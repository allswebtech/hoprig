// What Settings → Updates looks after: Hoprig itself, the three coding tools and the tunnel helper (cloudflared, for
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
// The rules: Hoprig from a git checkout never updates by itself; a coding tool updates by itself only while none of
// its sessions is working (Claude Code: a running session keeps its own copy) or open at all (Codex, OpenCode: npm
// replaces their program files); the tunnel helper never while a public link is on (a Temporary link would come
// back with a new address).
import { findTool, turnOn } from '../codetools/index.mjs';
import { capture, compareVersions, npmMajor, showCommand, stream } from '../setup/system.mjs';
import { busy } from './cards.mjs';

/** The coding tool a session card belongs to: `tool` when the card says it, else Claude Code (older cards). */
export const toolOf = (c) => (c && typeof c.tool === 'string' ? c.tool : c && (c.kind === 'claude' || c.kind === 'chat') ? 'claude' : c && (c.kind === 'codex' || c.kind === 'opencode') ? c.kind : null);
const plural = (n, one) => `${n} ${one} session${n === 1 ? '' : 's'}`;

// ---------- Hoprig ----------

/**
 * A git checkout's facts without changing anything in it (no fetch: `ls-remote` only reads the server).
 * → { head, upstream, remoteHead, newer: true|false|null, error }
 */
export async function gitFacts(root, run = capture) {
  const git = (...a) => run(['git', '-C', root, ...a], { timeout: 20_000 });
  const head = (await git('rev-parse', 'HEAD')).stdout.trim() || null;
  const up = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  const upstream = up.ok ? up.stdout.trim() : '';
  if (!upstream || !upstream.includes('/')) return { head, upstream: null, remoteHead: null, newer: null };
  const [remote, ...rest] = upstream.split('/');
  const branch = rest.join('/');
  const ls = await git('ls-remote', '--heads', remote, `refs/heads/${branch}`);
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
      'The new version is used after the dashboard restarts: sessions kept by tmux go on through the restart, sessions in the built-in terminals end then (their conversations can be continued). From a git checkout Hoprig never updates by itself.',
    installable: false,
    async info() {
      const [{ installKind, publishedVersion }, { appRoot, appVersion }] = await Promise.all([sel(), chk()]);
      const root = appRoot();
      const kind = installKind(root);
      const installed = appVersion();
      if (kind === 'git') {
        const g = await gitFacts(root, run);
        const short = (h) => (h ? h.slice(0, 7) : '');
        const base = { installed: g.head ? `${installed} (${short(g.head)})` : installed, method: 'git checkout' };
        if (!g.upstream) return { ...base, latest: null, updateAvailable: false, canUpdate: false, why: 'This checkout follows no branch on a server: update it with git yourself.' };
        if (g.newer === null) return { ...base, latest: null, updateAvailable: false, canUpdate: true, note: g.error || null };
        return { ...base, latest: g.newer ? `newer commits on ${g.upstream}` : base.installed, updateAvailable: g.newer, canUpdate: true };
      }
      if (kind === 'npm') {
        const latest = await publishedVersion();
        return { installed, method: 'npm', latest, updateAvailable: !!(latest && installed && compareVersions(latest, installed) > 0), canUpdate: true };
      }
      return { installed, method: 'copied folder', latest: null, updateAvailable: false, canUpdate: false, why: 'Installed from a copied folder or a tarball: install it again the way you did first.' };
    },
    async update({ onLine = () => {} } = {}) {
      const [{ installKind, updatePlan }, { appRoot, appVersion }] = await Promise.all([sel(), chk()]);
      const root = appRoot();
      const kind = installKind(root);
      const plan = updatePlan(kind, root, process.platform, kind === 'npm' ? await npmMajor() : null);
      if (!plan.length) {
        onLine('This install cannot update itself: install it again the way you did first.');
        return { ok: false, version: appVersion(), output: '' };
      }
      for (const step of plan) {
        onLine(`$ ${showCommand(step.argv)}`);
        const r = await (deps.stream || stream)(step.argv, { cwd: step.cwd, onLine });
        if (!r.ok && step.ifFails) onLine(step.ifFails);
        else if (!r.ok) return { ok: false, version: appVersion(), output: `exit code ${r.code}` };
      }
      onLine('Done. The new version is used after the dashboard restarts (hoprig service install restarts the background one).');
      return { ok: true, version: appVersion(), output: '' };
    },
    blocked: () => null,
    autoBlocked: (cards) => {
      const n = cards.filter(busy).length;
      return n ? `${plural(n, 'working')} would be cut off by the restart` : null;
    },
    autoOk: (info) => info.method === 'npm',
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
    async info() {
      const i = await tool.info();
      const method = { hoprig: "Hoprig's tools folder", native: 'official installer', npm: 'npm', unknown: 'a package manager' }[i.method] || i.method || 'unknown';
      const note = tool.managed ? `Installs ${tool.pin} at first, the version this Hoprig is tested with.` : null;
      return { installed: i.installed, latest: i.latest, method, updateAvailable: !!i.updateAvailable, canUpdate: true, note };
    },
    async update({ onLine = () => {} } = {}) {
      // Missing: install it (a managed tool at its tested version) and turn it on. Present: update it.
      if (tool.installedVersion()) return tool.update({ onLine });
      const r = await tool.install({ onLine });
      if (r.ok) (deps.turnOn || turnOn)(id);
      return { ...r, installed: true };
    },
    blocked(cards) {
      if (keepsCopy) return null;
      const n = mine(cards).length;
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
    title: 'Tunnel helper (cloudflared)',
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
      const r = await p.publicLink.update({ onLine });
      const after = await facts();
      return { ok: !!r.ok, version: after.installed, output: r.error || '' };
    },
    blocked() {
      // Read at the moment of asking: the state files of the two links (src/addons/cloudflared.mjs).
      const c = deps.linkState ? deps.linkState() : null;
      return c && c.on ? `The public link is on (${c.kind}): turn it off first` : null;
    },
    autoOk: (info) => info.method === "Hoprig's add-ons folder",
    // The link state needs the add-on module; loaded once before blocked() is asked.
    async prepare() {
      if (deps.linkState) return;
      const c = await cf();
      deps.linkState = () => {
        const q = c.readQuick();
        if (q && c.alive(q.pid) && q.url) return { on: true, kind: 'Temporary' };
        const f = c.readFixed();
        return f && f.enabled ? { on: true, kind: 'Custom' } : { on: false };
      };
    },
  };
}

/** The five items, in the order the page shows them. */
export const realItems = (deps = {}) => [hoprigItem(deps), toolItem('claude'), toolItem('codex'), toolItem('opencode'), tunnelItem(deps)];
