// One computer's health in one answer (Computers → Health): GET /api/health on every computer, which a hub that
// controls it reads with its own token over its own link. Only what this list names leaves the computer:
//
//   { hoprig: 'health', at, checks: [{ group, id, label, status, detail, fix, fixId, where, action, admin, commands }], line,
//     versions: { hoprig, claude, opencode }, service: { status, detail }, listens: { host, port },
//     load: [1, 5, 15], cpus, memory: { total, available }, disks: [{ mount, size, used, avail }],
//     own: { working, runs: { running, atOnce }, holdLeftMs, mount } | null }
//
// own: what its dashboard knows about new work there (sessions working now, Work's runs against its limit, how long a
// "Start nothing new" hold still stands), so a hub can say its room (src/operator/rooms.mjs). The hold travels as the
// time left, so a computer whose clock is wrong does not move it.
//
// checks are the doctor's (`hoprig doctor --json` there). fixId: a check Setup's Fix can run there (POST
// /api/pcsetup/fix { id }); commands: what that Fix runs (its kit's plan), admin: whether they need administrator
// rights, so the page shows them and asks first. Read when the owner opens the view or presses Refresh, never on a tick.
import { defaultHubLabel } from './hub.mjs';
import { dashboardAddress, VERSION } from './pairing.mjs';
import { mountHolding } from '../operator/room.mjs';
import { healthLineRoute } from './healthline.mjs';

const pickDisk = (d) => ({ mount: String(d.mount || ''), size: Number(d.size) || 0, used: Number(d.used) || 0, avail: Number(d.avail) || 0 });
/** A number another computer sent, kept only when it is one: null, '', true, [] or '8' become null, never 0 or 8. */
const typed = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Another computer's disk: a size or a use that is not a number stays null, so its room is "could not be read".
const answerDisk = (d) => (d && typeof d === 'object' ? { mount: String(d.mount || '').slice(0, 200), size: typed(d.size), used: typed(d.used), avail: typed(d.avail) } : { mount: '', size: null, used: null, avail: null });

/**
 * The doctor's checks as the health view shows them. `plans`: { <kit>: { admin, commands } }, what Setup's Fix runs
 * for a check with that kit (kits.mjs buildPlan): its administrator rights are the plan's, never a guess from the
 * fix's words (a fix line "hoprig pc setup --kits github" runs sudo apt there).
 */
// Checks that `pc setup --yes` cannot do (a name to type, a sign-in): their Fix would end "ok" and change nothing.
// They point to the part of Setup that does them instead.
const ASKED = { identity: 'Setup → Git and GitHub', signin: 'Setup → Git and GitHub' };
// Checks a part of the page does with a press (Health links there instead of showing a command to type): by id, or for
// a family of ids by its prefix. The page knows each place's address (web/health.js PLACES).
const DONE_ON = { root: 'Settings → Runs as root', profiles: 'Providers', 'skill:': 'Skills', 'skill-update:': 'Skills' };
const PLACES = [...new Set([...Object.values(ASKED), ...Object.values(DONE_ON)])];
const placeOf = (id) => ASKED[id] || DONE_ON[id] || Object.entries(DONE_ON).find(([k]) => k.endsWith(':') && String(id).startsWith(k))?.[1] || null;

// The page parts a check may name as its press (src/setup/checks.mjs `action`).
const ACTIONS = ['claude-login'];

export function healthChecks(results, plans = {}) {
  return (results || []).map((c) => {
    const bad = c.status !== 'ok';
    const where = bad && (placeOf(c.id) || (typeof c.where === 'string' && PLACES.includes(c.where) ? c.where : null)) || null;
    const plan = bad && c.fixKit && !where ? plans[c.fixKit] || null : null;
    return {
      group: c.group || null,
      id: String(c.id || ''),
      label: String(c.label || ''),
      status: ['ok', 'fail', 'warn', 'info'].includes(c.status) ? c.status : 'info',
      detail: String(c.detail || ''),
      fix: bad && c.fix ? String(c.fix) : '',
      fixId: bad && c.fixKit && !where ? String(c.id) : null,
      where,
      // A press of the page does it (the coding tool's sign-in: web/claudelogin.js): never a line to type there.
      action: bad && !where && !plan && ACTIONS.includes(c.action) ? c.action : null,
      admin: bad && (plan ? plan.admin === true : /(^|\s|&&\s*)sudo\s/.test(String(c.fix || ''))),
      commands: plan && Array.isArray(plan.commands) ? plan.commands.map(String) : [],
    };
  });
}

/** What Setup's Fix would run for each kit the checks name: { <kit>: { admin, commands } } (nothing is run). */
async function fixPlans(results) {
  const kits = [...new Set((results || []).filter((c) => c.status !== 'ok' && c.fixKit && !placeOf(c.id)).map((c) => c.fixKit))];
  if (!kits.length) return {};
  const { sysFacts, detectKits } = await import('../pcsetup/detect.mjs');
  const { buildPlan } = await import('../pcsetup/kits.mjs');
  const { showCommand } = await import('../setup/system.mjs');
  const sys = await sysFacts();
  const found = await detectKits(sys, kits);
  return Object.fromEntries(kits.map((k) => {
    const plan = buildPlan([k], found, sys);
    return [k, { admin: plan.admin, commands: plan.steps.map((st) => showCommand(st.argv)) }];
  }));
}

/** The doctor's checks of this computer (`parts.checks` in tests and the demo). */
const doctorChecks = (parts) => parts.checks || (async () => {
  const { sysInfo } = await import('../setup/checks.mjs');
  const { overview } = await import('../setup/overview.mjs');
  const { loadConfig } = await import('../config.mjs');
  const sys = sysInfo();
  let hub = false;
  try {
    hub = loadConfig().hubOnly === true || sys.env.HOPRIG_HUB === '1';
  } catch {
    /* unreadable config: not a hub */
  }
  // The doctor's own checks, offline: no lookup on the network, so a slow registry never holds the view.
  return overview({ sys, hub, offline: true });
});

/** This computer's checks as Health lists them (healthChecks), without the rest of its health. */
export async function localChecks({ parts = {} } = {}) {
  const results = await doctorChecks(parts)().catch((e) => [{ id: 'health', label: 'Checks', status: 'warn', detail: `could not be run: ${e.message}` }]);
  return healthChecks(results, await (parts.plans || fixPlans)(results).catch(() => ({})));
}

/**
 * This computer's health. `parts` replaces the sources (tests, the demo): { checks(), snapshot(), versions(),
 * listens() }.
 */
export async function localHealth({ parts = {}, now = Date.now, own = null } = {}) {
  const checks = doctorChecks(parts);
  const snapshot = parts.snapshot || (async () => (await import('../server/platform.mjs')).snapshot());
  const versions = parts.versions || (async () => {
    const { claudeVersionQuick } = await import('../claudecode.mjs');
    const { anyTool } = await import('../codetools/index.mjs');
    const oc = anyTool('opencode');
    return { hoprig: VERSION, claude: (await Promise.resolve(claudeVersionQuick()).catch(() => null)) || null, opencode: (oc && (await Promise.resolve(oc.installedVersion()).catch(() => null))) || null };
  });
  const listens = parts.listens || (() => dashboardAddress());
  const [results, snap, v] = await Promise.all([checks().catch((e) => [{ id: 'health', label: 'Checks', status: 'warn', detail: `could not be run: ${e.message}` }]), snapshot().catch(() => ({})), versions().catch(() => ({}))]);
  const plans = await (parts.plans || fixPlans)(results).catch(() => ({}));
  const ownNow = own ? await Promise.resolve().then(own).catch(() => null) : null; // server.mjs: rooms.mjs ownFacts
  const list = healthChecks(results, plans);
  const svc = list.find((c) => c.id === 'service');
  const addr = listens();
  return {
    hoprig: 'health',
    at: now(),
    computer: defaultHubLabel(), // the name its Fix's confirmation sends back (src/server/ownerpress.mjs)
    checks: list,
    line: true, // it answers POST /api/health/line: Health offers "Open a terminal with this line" for it
    versions: { hoprig: v.hoprig || null, claude: v.claude || null, opencode: v.opencode || null },
    service: svc ? { status: svc.status, detail: svc.detail } : { status: 'info', detail: 'unknown' },
    listens: { host: String(addr.host), port: Number(addr.port) },
    load: Array.isArray(snap.load) ? snap.load.slice(0, 3).map(Number) : null,
    cpus: Number(snap.cpus) || null,
    memory: snap.mem ? { total: Number(snap.mem.total) || 0, available: Number(snap.mem.available) || 0 } : null,
    disks: Array.isArray(snap.disks) ? snap.disks.slice(0, 8).map(pickDisk) : [],
    // `workspace` (the path) stays here: only the mount of its disk leaves the computer.
    own: pickOwn(ownNow ? { ...ownNow, mount: mountHolding(ownNow.workspace, (Array.isArray(snap.disks) ? snap.disks : []).map((d) => d && d.mount)) } : null),
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const whole = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);

/** `own` of an answer, typed and bounded: a count that cannot be true is left out (null), never guessed. */
export function pickOwn(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o.runs && typeof o.runs === 'object' ? { running: whole(o.runs.running, 100), atOnce: whole(o.runs.atOnce, 100) } : null;
  const left = typeof o.holdLeftMs === 'number' && Number.isFinite(o.holdLeftMs) && o.holdLeftMs > 0 ? Math.min(Math.round(o.holdLeftMs), 24 * 3600_000) : null;
  // mount: the mount of the disk the workspace is on there (never the workspace's path), so a hub reads that disk.
  const mount = typeof o.mount === 'string' && o.mount && o.mount.length <= 200 ? o.mount : null;
  return { working: whole(o.working, 1000), runs: r && r.running != null && r.atOnce != null ? r : null, holdLeftMs: left, mount };
}
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null);

/** Another computer's answer, cut down to exactly the fields above (whatever else it sent stays out). */
export function pickHealth(j) {
  const v = j.versions || {};
  return {
    hoprig: 'health',
    at: num(j.at),
    computer: str(j.computer, 40),
    // A check's administrator rights and commands as that computer said them (from its own plan), cut to size.
    checks: (Array.isArray(j.checks) ? j.checks.slice(0, 200) : []).map((c) => {
      const kit = c && c.fixId ? `#${String(c.fixId)}` : undefined;
      const plan = kit ? { [kit]: { admin: c.admin === true, commands: Array.isArray(c.commands) ? c.commands.slice(0, 30).map((x) => String(x).slice(0, 500)) : [] } } : {};
      return healthChecks([{ ...c, fixKit: kit }], plan).map((x) => ({ ...x, fixId: x.fixId, group: str(x.group, 60), label: x.label.slice(0, 120), detail: x.detail.slice(0, 500), fix: x.fix.slice(0, 500) }))[0];
    }),
    line: j.line === true, // an older Hoprig there has no such route: no press is shown for it
    versions: { hoprig: str(v.hoprig, 40), claude: str(v.claude, 40), opencode: str(v.opencode, 40) },
    service: j.service ? { status: str(j.service.status, 10), detail: str(j.service.detail, 300) } : null,
    listens: j.listens ? { host: str(j.listens.host, 100), port: num(j.listens.port) } : null,
    // The figures a room is read from (src/operator/room.mjs) are typed strictly: Number(null) is 0, which would read
    // as an idle computer with room.
    load: Array.isArray(j.load) ? j.load.slice(0, 3).map(typed) : null,
    cpus: typed(j.cpus),
    memory: j.memory && typeof j.memory === 'object' ? { total: typed(j.memory.total), available: typed(j.memory.available) } : null,
    disks: Array.isArray(j.disks) ? j.disks.slice(0, 8).map(answerDisk) : [],
    own: pickOwn(j.own),
  };
}

/** The server feature: GET /api/health (the page here, or the token of a hub that controls this computer). */
export function healthFeature(ctx, opts = {}) {
  // POST /api/health/line: one check's line, rebuilt here from this computer's own checks (./healthline.mjs).
  const line = healthLineRoute(ctx, { checks: () => localChecks(opts), name: defaultHubLabel, tokenId: opts.tokenId || null });
  return { name: 'health', routes: [['GET', /^\/api\/health$/, () => localHealth(opts)], line] };
}
