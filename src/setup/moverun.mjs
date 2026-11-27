// The whole of `hoprig move-to-user`, in order, after the look (moveplan.mjs) and his yes: the copy, its check, the
// switch, the catch-up of conversation lines, root's idle terminals ended, the gateways, and the lines about the link
// and what to do once. One function for the command line and the page's job (moveroutes.mjs), so both say the same
// lines. A step that fails stops the rest, and the lines say what was made and how to take it away; root's copy is
// never deleted. Each step is handed in by tests (`steps`); the defaults are the real ones.
import fs from 'node:fs';
import path from 'node:path';
import { failedCopyLines, copyParts } from './movecopy.mjs';
import { checkCopy } from './movecheck.mjs';
import { realSwitchSys, stepBack, switchToUser } from './moveswitch.mjs';
import { catchLines, catchUp, compareAll, endTerminals, projectPairs } from './movecatch.mjs';
import { moveGateways } from './movegateway.mjs';
import { linkLines, linkOf, linkWarning, onceLines, systemWideLine } from './moveafter.mjs';
import { moved } from './movecopy.mjs';
import { size } from './moveplan.mjs';
import { realGatewaySys } from './movegatewaysys.mjs';
import { clearOwnCopy, leftLines, madeParts, markOf, writeMark } from './movemark.mjs';
import { makeWorkUser } from './movemake.mjs';
import { runAsUser } from './asuser.mjs';
import { lookUser } from './rootfacts.mjs';
import { NO_NETWORK, PROXY_LINE, reachAll, toCheck } from './movenet.mjs';

/**
 * The default steps (real programs, as root). None of them is made for a plan: each takes the plan or the user it works
 * for when it is called, because the move replaces its plan once it made the user (the planned user has no id yet, and
 * the system may give it another home). `low`: the lowest calls, handed in by tests (`run`, `has`, `chown`, `ownerOf`,
 * `marked`, `reachFetch` (the network look's), and those of moveswitch.mjs realSwitchSys and movegatewaysys.mjs); the
 * defaults are the real ones.
 */
export function realSteps(low = {}) {
  const chown = low.chown || fs.lchownSync;
  const own = (p, user) => chown(p, user.uid, user.gid ?? user.uid);
  const asUserOf = (user) => (low.run ? (argv, o) => runAsUser(user, argv, { ...o, run: low.run, ...(low.has && { has: low.has }) }) : undefined);
  return {
    reach: (plan) => reachAll(plan.network || [], low.reachFetch ? { fetch: low.reachFetch } : {}),
    copy: (p, o) => copyParts(p, { ...o, ...(low.chown && { io: { chown } }), asUser: asUserOf(p.user) }),
    check: (p, c, o) => checkCopy(p, c, { ...o, asUser: asUserOf(p.user), ...(low.ownerOf && { ownerOf: low.ownerOf }) }),
    switchSys: (plan) => realSwitchSys(plan.user, low),
    own,
    endTerminals: (t) => endTerminals(t),
    gateways: async () => {
      const { gatewayAddons } = await import('../addons/gateways.mjs');
      return gatewayAddons().map((a) => ({ id: a.id, title: a.title, port: a.gateway.port(), dataDir: a.dataDir || null, ...(a.ownCopy ? { own: true } : {}) }));
    },
    gatewaySys: (plan) => realGatewaySys(plan, low),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    makeUser: (p, o) => makeWorkUser(p, { ...o, ...(low.run && { run: low.run, look: (n) => lookUser(n, { run: low.run }) }), ...(low.marked && { marked: low.marked }) }),
    clearOwn: (p, m) => clearOwnCopy(p, m),
    mark: (m, plan) => writeMark(plan.dirs.state, m),
  };
}

/** Where a part's folder is in the user's home (`id` of moveParts). */
const toOf = (plan, id) => plan.parts.find((p) => p.id === id)?.to || null;

/**
 * Run the move of `plan` (movePlan, ok). `say(line)` takes each line; `progress(p)` how far the copy and check are;
 * `onSwitched(userState, user)` is told the user the move switched to (the one it made, when it made one). → { ok, step }.
 */
export async function runMove(plan, { say = () => {}, progress = () => {}, steps: given = {}, low = {}, onSwitched = () => {}, noAdmin = false } = {}) {
  const steps = { ...realSteps(low), ...given };
  // First of all: can the user's own install reach what it needs (movenet.mjs)? If not, nothing is made or copied.
  // Behind a proxy the look cannot ask (Node's fetch does not use it): said once, and the install goes through it. A
  // proxy only npm uses (~/.npmrc) covers the registry alone: the other hosts are still asked (toCheck).
  if (plan.network?.length && plan.proxy) say(PROXY_LINE(plan.proxy, plan.network));
  const asked = toCheck(plan.network || [], plan.proxy);
  if (asked.length) {
    const net = await steps.reach({ ...plan, network: asked });
    if (!net.ok) {
      // An earlier run's copy, and the user it made, are still here (a user the look would make is not): said, with
      // the way on. This run made nothing, so nothing is offered for removal (leftLines).
      const left = !!plan.again && !plan.make;
      say(NO_NETWORK(plan.user.name, net.unreached, { again: left }));
      if (left) for (const l of leftLines(plan, { early: true, kept: plan.again.kept || [] })) say(l);
      return { ok: false, step: 'network' };
    }
  }
  // No user Hoprig made: made now, after his yes, by the installer's one way of making it (movemake.mjs).
  if (plan.make) {
    const made = await steps.makeUser(plan, { say, noAdmin });
    if (!made.ok) {
      say(`STOPPED at "the user": ${made.why}`);
      say("Root's installation was not changed and works as before.");
      return { ok: false, step: 'user' };
    }
    // The parts go where the system really made the home (useradd's own default may differ from /home/<name>).
    const to = (p) => made.user.home + p.slice(plan.user.home.length);
    plan = { ...plan, parts: plan.parts.map((p) => ({ ...p, to: to(p.to) })), user: made.user, make: false, madeUser: true, admin: plan.admin.filter((s) => !['make-user', 'keys', 'sudoers', 'linger'].includes(s.id)) };
  }
  const { user } = plan;
  // What this run, or an earlier one, set aside in the user's home (kept in the mark): never offered for removal by a
  // stop's lines (leftLines), so no command there takes away the user or the home that holds it. Every stop below says
  // its lines through leftLines with what this run's copy made, the only parts a stop may offer to take away.
  const kept = [...(plan.again?.kept || [])];
  // An earlier run's own copy (movemark.mjs): cleared first, said in one line. What the move did not make stays.
  if (plan.again) {
    const c = steps.clearOwn(plan, plan.again);
    for (const [, to] of c.aside) kept.push(to);
    if (c.gone.length) say(`An earlier move began a copy here and did not switch: it was taken away first (${c.gone.length} folder${c.gone.length === 1 ? '' : 's'}, unchanged since that move made them), and the copy is made again.`);
    for (const [from, to, why] of c.aside) {
      say(why === 'changed'
        ? `${from} changed after an earlier move made it, so it is kept as ${to}; ${from} is made again from root's.`
        : `An earlier move's copy, which ${user.name}'s dashboard used, is kept as ${to}; ${from} is made again from root's.`);
    }
  }
  const at = new Date().toISOString();
  const mark = (state, more = {}) => steps.mark(markOf(plan, state, { at, kept, ...more }), plan);
  const now = () => new Date().toISOString();
  mark('copying');
  // The copy and its check.
  say(`Copying ${plan.total.entries} entries (${size(plan.total.bytes)}) to ${user.home}…`);
  const t0 = Date.now();
  const copied = await steps.copy(plan, { onProgress: (p) => progress(p) });
  // The move's own writes ended here: a change after this, before the next run, is someone else's (clearOwnCopy). A
  // copy that stopped claims only the parts it made: one it found in the way (an earlier copy's that clearOwn left,
  // such as one under a link) is not this run's, so the next run never takes it away.
  mark('copying', { madeUntil: now(), ...(!copied.ok && { parts: madeParts(plan, copied.made || []) }) });
  if (!copied.ok) {
    for (const l of failedCopyLines(copied, user)) say(l);
    for (const l of leftLines(plan, { made: copied.made || [], kept })) say(l);
    return { ok: false, step: 'copy' };
  }
  const skipped = copied.skipped || [];
  if (skipped.length) say(`Not copied, because a socket or a pipe cannot be copied (the program that made it makes it again): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}.`);
  const r = copied.rewritten || { files: 0, values: 0, git: 0 };
  say(`Copied. In the copy, ${r.values} value(s) in ${r.files} settings file(s) and ${r.git} git record(s) of linked work trees now name ${user.home}; ${(copied.placed || []).length} project folder(s) of Claude Code are also under their new path's name.`);
  const check = await steps.check(plan, copied, { onProgress: (p) => progress(p) });
  if (!check.ok) {
    say('The check of the copy found differences, so nothing was switched. Root\'s installation still runs and is unchanged:');
    for (const l of check.problems) say(`  ${l}`);
    for (const l of leftLines(plan, { made: copied.made || [], kept })) say(l);
    return { ok: false, step: 'check' };
  }
  // The check runs git as the user: what it wrote is the move's too.
  mark('checked', { madeUntil: now() });
  say(`The copy is checked (${((Date.now() - t0) / 1000).toFixed(0)} s): ${check.repos} repositor${check.repos === 1 ? 'y' : 'ies'} with the same heads, status, branches and stashes; conversations ${check.hashes.same} of ${check.hashes.total} the same; entries not owned by ${user.name}: ${check.owners}.`);
  // The switch.
  const link = linkOf(plan.dirs.config, plan.dirs.state);
  const warn = linkWarning(link);
  if (warn) say(warn);
  const sys = steps.switchSys(plan);
  let switchingAt = null;
  const sw = await switchToUser(plan, { sys, say, keepHeld: true, onSwitching: () => mark('switching', { madeUntil: (switchingAt = now()), switchingAt }) });
  if (!sw.ok) {
    if ((sw.did || []).includes('stop-root')) {
      // The user's dashboard may have run on the copy: never taken for a half-made one. Root's runs again.
      mark('back', { madeUntil: switchingAt, switchingAt, backAt: now() });
    } else mark('checked', { madeUntil: now() }); // the install and the trial were the move's own writes
    for (const l of leftLines(plan, { did: sw.did || [], made: copied.made || [], kept })) say(l);
    return { ok: false, step: sw.step };
  }
  // The signals the switch held stay held until the gateways' step is done: a hang-up between root's gateway stopped
  // and the user's started would leave none running.
  try {
    mark('switched', { madeUntil: switchingAt, switchingAt, switchedAt: now() });
    onSwitched(moved(plan.dirs.state, plan.oldHome, user.home), user);
    // Lines root's side wrote after the copy, then root's idle terminals.
    const pairs = projectPairs(plan.dirs.claude, toOf(plan, 'claude') || moved(plan.dirs.claude, plan.oldHome, user.home), plan.oldHome, user.home);
    const caught = catchUp(pairs, { own: (p) => steps.own(p, user), home: user.home });
    const ended = await steps.endTerminals(plan.running.terminals);
    for (const l of catchLines(caught, ended, compareAll(pairs))) say(l);
    // Gateways that ran as root.
    const gws = (await steps.gateways()).filter((g) => g.dataDir);
    if (gws.length) await moveGateways(plan, gws, { sys: steps.gatewaySys(plan), say });
  } finally {
    sw.release?.();
  }
  // The link, root's old commands, and what to do once.
  const userCfg = moved(plan.dirs.config, plan.oldHome, user.home);
  const userState = moved(plan.dirs.state, plan.oldHome, user.home);
  if (link.on) {
    let after = null;
    for (let i = 0; i < 30 && !(after && after.connected && after.url); i += 1) {
      after = linkOf(userCfg, userState);
      if (!(after.connected && after.url)) await steps.sleep(2000);
    }
    for (const l of linkLines(link, after)) say(l);
  }
  const sw2 = systemWideLine(user);
  if (sw2) say(sw2);
  const once = onceLines(userCfg);
  if (once.length) {
    say('To do once now:');
    for (const l of once) say(`  ${l}`);
  }
  say(`Done. Hoprig runs as ${user.name}; sign in with the same password. Root's copy is kept in ${plan.oldHome}${sw.file ? ` (${path.basename(sw.file)} there says so)` : ''}; removing it is a later step of its own.`);
  return { ok: true, step: 'done' };
}

/** The step back (`hoprig move-to-user --back`). The mark then says so: a later move may start again. */
export async function runBack(plan, { say = () => {}, steps: given = {}, low = {} } = {}) {
  const steps = { ...realSteps(low), ...given };
  const r = await stepBack(plan, { sys: steps.switchSys(plan), say });
  if (r.ok && plan.again) steps.mark({ ...plan.again, state: 'back', backAt: new Date().toISOString() }, plan);
  return r;
}
