// The dashboard's operations for Tia's core (the OPS interface in tools.mjs). Every action goes through the SAME
// route the page uses, run in-process on the owner's behalf (ctx.dispatch, server.mjs): one implementation per
// action, the same validators, nothing taken from the model as identity. Another computer is the same route at
// /m/<name>/… — the relay the page uses for it — so that computer re-validates every value itself.
//
// Background jobs of the setup routes (new project, get project, sync, add repository, install) are followed here
// until they end (or a time limit), so a tool result says what happened and what needs a decision.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { insideRoots, resolveRoots } from '../server/folders.mjs';
import { runAdmin as runAdminCmd } from './adminrun.mjs';
import { gatedDispatch } from './door.mjs';
import * as v from '../server/validate.mjs';
import { withoutSecrets } from '../secretenv.mjs';
import { LOCAL } from './shown.mjs';

export const OUTPUT_MAX = 64 * 1024;
const JOB_WAIT_MS = 120_000;

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** A path from Tia: absolute, or ~/… on this computer. */
function localPath(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Run one shell command: POSIX sh -c (Windows: cmd /d /s /c), in `cwd`, killed after `timeoutMs`. Output (stdout
 * and stderr together) keeps the last OUTPUT_MAX bytes. The dashboard's own account secrets are not passed on.
 * Resolves { code, output, timedOut }.
 */
export function runShell(command, { cwd, timeoutMs = 60_000, spawnImpl = spawn, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const env = withoutSecrets(process.env);
    const [cmd, args, extra] = platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true }]
      : ['/bin/sh', ['-c', command], {}];
    let child;
    try {
      child = spawnImpl(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32', ...extra });
    } catch (e) {
      resolve({ code: 127, output: e.message, timedOut: false });
      return;
    }
    let out = Buffer.alloc(0);
    let cut = 0;
    const take = (d) => {
      out = Buffer.concat([out, d]);
      if (out.length > OUTPUT_MAX) {
        cut += out.length - OUTPUT_MAX;
        out = out.subarray(out.length - OUTPUT_MAX);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // The whole process group: a command that started children must not leave them running.
        if (platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    const done = (code) => {
      clearTimeout(timer);
      const text = out.toString('utf8');
      resolve({ code, output: cut ? `(the first ${cut} bytes were cut)\n${text}` : text, timedOut });
    };
    child.on('error', (e) => {
      take(Buffer.from(e.message));
      done(127);
    });
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/**
 * o: { ctx (the server's feature ctx, with dispatch), runShell, jobWaitMs, sleep }
 */
export function createOps(o) {
  const { ctx } = o;
  const cfg = () => ctx.config();
  const roots = () => resolveRoots(cfg().server.roots);
  const isLocal = (c) => !c || c === LOCAL;
  const enc = encodeURIComponent;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let adminPwKnown; // whether this computer's sudo asks a password: detected once per process (below)

  /** One request of the page's own, on computer `c`. Resolves the JSON; a refusal becomes an error with its status. */
  async function api(c, method, p, body) {
    // Every request passes the door (door.mjs): an allowlist of the routes her tools use, a never-list, body checks.
    const r = await gatedDispatch(ctx, method, isLocal(c) ? p : `/m/${enc(c)}${p}`, body);
    if (r.status !== 200) throw fail(r.status, (r.json && r.json.error) || `the dashboard answered ${r.status}`, r.json && r.json.code ? { code: r.json.code } : {});
    return r.json || {};
  }
  const get = (c, p) => api(c, 'GET', p);
  const post = (c, p, body = {}) => api(c, 'POST', p, body);
  const dir = (c, p) => (isLocal(c) ? localPath(p) : p);

  /** Follow the setup routes' background job until it ends; { ok, error, data, lines } or { running: true }. */
  async function followJob(c, jobPath = '/api/pcsetup/job') {
    const until = Date.now() + (o.jobWaitMs ?? JOB_WAIT_MS);
    let lines = [];
    let from = 0;
    for (;;) {
      const j = await get(c, `${jobPath}?from=${from}`);
      lines = [...lines, ...(j.lines || [])].slice(-40);
      from = j.next || from;
      if (!j.running) return { ...(j.result || { ok: false, error: 'the job left no result' }), lines };
      if (Date.now() > until) return { running: true, lines };
      await sleep(500);
    }
  }
  const withJob = async (c, started, jobPath) => ({ ...started, job: started && started.started ? await followJob(c, jobPath) : null });
  const WS_JOB = '/api/workspace/job';

  return {
    // ---- sessions ----
    async listSessions({ computer = null } = {}) {
      if (computer) return ((await get(computer, '/api/state')).sessions || []).map((s) => ({ ...s, computer }));
      const all = await get(LOCAL, '/api/machines/sessions');
      return (all.machines || []).filter((m) => m.status === 'online').flatMap((m) => (m.sessions || []).map((s) => ({ ...s, computer: m.machine || LOCAL })));
    },
    async capture({ computer, session, lines = 60 }) {
      return (await get(computer, `/api/sessions/${enc(session)}/history?lines=${lines}`)).text || '';
    },
    // tool: the coding tool (left out: Claude Code); the computer checks it is on and installed.
    startSession: ({ computer, folder, profile, mode, sessionId, prompt, tool }) =>
      post(computer, '/api/sessions', { dir: dir(computer, folder), ...(tool ? { tool } : {}), profile, mode, ...(sessionId ? { sessionId } : {}), ...(prompt ? { prompt } : {}) }).then((r) => {
        ctx.poke?.(); // the watcher looks soon, so a job sees the session start working
        return r;
      }),
    sendText: ({ computer, session, text }) => post(computer, `/api/sessions/${enc(session)}/send`, { text }).then(() => ctx.poke?.()),
    pressKey: ({ computer, session, key }) => post(computer, `/api/sessions/${enc(session)}/key`, { key }),
    renameSession: ({ computer, session, name }) => post(computer, `/api/sessions/${enc(session)}/rename`, { name }),
    killSession: ({ computer, session }) => post(computer, `/api/sessions/${enc(session)}/kill`, {}),
    switchAccount: ({ computer, session, profile }) => post(computer, `/api/sessions/${enc(session)}/switch`, { profile }),
    // ---- chats (src/chat; a chat is "chat:<id>" among the sessions) ----
    // A chat on an earlier conversation is never hers (its history holds the owner's own words): she does not even ask
    // for the mark there, and the computer refuses it too (src/chat/feature.mjs openChat).
    startChat: ({ computer, folder, profile, sessionId, text, tool, lead, others }) =>
      post(computer, '/api/chats', { dir: dir(computer, folder), ...(tool ? { tool } : {}), profile, ...(sessionId ? { sessionId } : {}), ...(text ? { text } : {}), lead: lead === true, ...(lead && others && others.length ? { others } : {}), defaults: true, ...(sessionId ? {} : { byTia: true }) }).then((r) => {
        ctx.poke?.();
        return r;
      }),
    sendToChat: ({ computer, id, text }) => post(computer, `/api/chats/${enc(id)}/send`, { text, byTia: true }).then((r) => {
      ctx.poke?.();
      return r;
    }),
    answerChat: ({ computer, id, request, allow, always }) => post(computer, `/api/chats/${enc(id)}/answer`, { request, allow, always }),
    stopChat: ({ computer, id }) => post(computer, `/api/chats/${enc(id)}/stop`, {}),
    moveChat: ({ computer, id, profile }) => post(computer, `/api/chats/${enc(id)}/provider`, { profile }),
    renameChat: ({ computer, id, title }) => post(computer, `/api/chats/${enc(id)}/title`, { title }),
    // A new chat on a copy of chat `id`'s conversation (the session menu's Branch); it starts nothing until a message.
    forkChat: ({ computer, id }) => post(computer, `/api/chats/${enc(id)}/fork`, {}).then((r) => (ctx.poke?.(), r)),
    closeChat: ({ computer, id }) => post(computer, `/api/chats/${enc(id)}/close`, {}).then((r) => (ctx.poke?.(), r)),
    chatToTerminal: ({ computer, id }) => post(computer, `/api/chats/${enc(id)}/terminal`, {}).then((r) => (ctx.poke?.(), r)),
    chatFromSession: ({ computer, session }) => post(computer, '/api/chats/from-session', { session }).then((r) => (ctx.poke?.(), r)),
    continueSession: ({ computer, session }) => post(computer, `/api/sessions/${enc(session)}/continue`, {}).then((r) => (ctx.poke?.(), r)),

    // ---- folders and projects ----
    async recentFolders({ computer }) {
      const r = await get(computer, '/api/folders/recent');
      return { folders: (r.folders || []).map((f) => f.path || f), roots: (r.roots || []).map((f) => f.path || f) };
    },
    async browse({ computer, path: p }) {
      const r = await get(computer, `/api/folders/browse?path=${enc(dir(computer, p))}`);
      return { path: r.path, dirs: (r.dirs || []).map((d) => ({ name: d.name, path: d.path })) };
    },
    async conversations({ computer, folder }) {
      return ((await get(computer, `/api/folders/sessions?path=${enc(dir(computer, folder))}`)).sessions || []).map((s) => ({ id: s.id, at: s.at, title: s.title }));
    },
    projects: ({ computer }) => get(computer, '/api/pcsetup/projects'),
    projectPreview: ({ computer, name }) => get(computer, `/api/pcsetup/project/preview?name=${enc(name)}`),
    projectNew: async ({ computer, name, github }) => withJob(computer, await post(computer, '/api/pcsetup/project/new', { name, github: github === true })),
    projectGet: async ({ computer, spec }) => withJob(computer, await post(computer, '/api/pcsetup/project/clone', { spec })),
    projectAdd: async ({ computer, name, repo, github }) => withJob(computer, await post(computer, '/api/pcsetup/project/add', { name, repo, github: github === true })),
    projectSync: async ({ computer, name, memory }) => withJob(computer, await post(computer, '/api/pcsetup/project/sync', { name, memory: memory === true })),
    projectInstall: async ({ computer, dir: d }) => withJob(computer, await post(computer, '/api/pcsetup/install', { dir: d })),
    workspace: ({ computer }) => get(computer, '/api/workspace'),
    workspaceSetup: ({ computer, dryRun }) => post(computer, '/api/workspace/setup', { dryRun: dryRun === true }),
    // The workspace map, restore and sync (src/workspace/feature.mjs). Restore and sync run as background jobs.
    workspaceMap: ({ computer }) => get(computer, '/api/workspace/map'),
    workspaceMapWrite: ({ computer, dryRun }) => post(computer, '/api/workspace/map', { dryRun: dryRun === true }),
    workspaceGit: ({ computer }) => get(computer, '/api/workspace/git'),
    async workspaceRestore({ computer, url, dryRun }) {
      const r = await post(computer, '/api/workspace/restore', { url, dryRun: dryRun === true });
      return dryRun ? r : withJob(computer, r, WS_JOB);
    },
    workspaceSync: async ({ computer, push, memory, with: from, dryRun }) =>
      withJob(computer, await post(computer, '/api/workspace/sync', { ...(from ? { with: from } : { push: push === true, memory: memory === true }), dryRun: dryRun === true }), WS_JOB),
    workspacePlaces: ({ computer, dir: d, projects: pr }) => post(computer, '/api/workspace/settings', { ...(d ? { dir: dir(computer, d) } : {}), ...(pr ? { projects: dir(computer, pr) } : {}) }),
    workspaceForget: ({ computer, name }) => post(computer, '/api/workspace/forget', { name }),
    // Which computer has what, the naming rule's look-up, a drop's check and a group's dry run: all read only. A drop and
    // a group add are the owner's own presses on the Workspace page (whomay.mjs): her door never reaches them.
    workspaceWhoHas: ({ computer }) => get(computer, '/api/workspace/whohas'),
    workspaceFind: ({ computer, place }) => get(computer, `/api/workspace/find?in=${enc(place)}`),
    dropCheck: ({ computer, name }) => post(computer, '/api/workspace/drop/check', { name }),
    groupDryRun: ({ computer, dir: d, repo, holds }) => post(computer, '/api/workspace/group', { dir: d, ...(repo ? { repo } : {}), ...(holds ? { holds } : {}), dryRun: true }),

    // ---- Work (src/work: the list, Today, "Do it" and the runs; manage_work) ----
    // An item is named by its id and its place in the list (`at`), as the page names it.
    work: ({ computer }) => get(computer, '/api/work'),
    workAdd: ({ computer, item }) => post(computer, '/api/work/items', item),
    workEdit: ({ computer, id, at, changes }) => post(computer, `/api/work/items/${enc(id)}`, { at, ...changes }),
    workStatus: ({ computer, id, at, status }) => post(computer, `/api/work/items/${enc(id)}/status`, { at, status }),
    workRemove: ({ computer, id, at }) => post(computer, `/api/work/items/${enc(id)}/remove`, { at }),
    workPlan: ({ computer, id, at, project, folder }) => get(computer, `/api/work/items/${enc(id)}/do?at=${at}${project ? `&project=${enc(project)}` : ''}${folder ? `&folder=${enc(folder)}` : ''}`),
    workStart: ({ computer, id, at, choices }) => post(computer, `/api/work/items/${enc(id)}/do`, { at, ...choices }).then((r) => {
      ctx.poke?.(); // the watcher looks soon, so the job sees the run's session start working
      return r;
    }),
    workAccept: ({ computer, id, at }) => post(computer, `/api/work/items/${enc(id)}/accept`, { at }),
    workSendBack: ({ computer, id, at, text }) => post(computer, `/api/work/items/${enc(id)}/send-back`, { at, text }),
    // id: that one run (a computer of an older version gives them all: the caller still picks it by its id).
    workGoal: ({ computer, goal, project, dryRun }) => post(computer, '/api/work/missions', { goal, project, ...(dryRun ? { dryRun: true } : {}) }),
    workMissions: ({ computer }) => get(computer, '/api/work/missions'),
    workMission: ({ computer, id }) => get(computer, `/api/work/missions/${enc(id)}`),
    workFixIds: ({ computer }) => post(computer, '/api/work/fix-ids', {}),
    workTidyPlan: ({ computer }) => get(computer, '/api/work/tidy'),
    workTidy: ({ computer, hash }) => post(computer, '/api/work/tidy', { hash }),
    workMissionStop: ({ computer, id }) => post(computer, `/api/work/missions/${enc(id)}/stop`, {}),
    workMissionAdd: ({ computer, id, task }) => post(computer, `/api/work/missions/${enc(id)}/add`, { task }),
    workMissionTests: ({ computer, id, task }) => post(computer, `/api/work/missions/${enc(id)}/tasks/${enc(task)}/run-tests`, {}),
    workProgress: ({ computer, since, item, run }) => get(computer, `/api/work/progress${(() => {
      const q = new URLSearchParams();
      if (since) q.set('since', since);
      if (item) q.set('item', item);
      if (run) q.set('run', run);
      const t = q.toString();
      return t ? `?${t}` : '';
    })()}`),
    workRuns: ({ computer, item, id }) => get(computer, `/api/work/runs${item ? `?item=${enc(item)}` : id ? `?id=${enc(id)}` : ''}`),
    // Plans (src/work/planfeature.mjs): the list, one plan with its milestones, tasks and `hash`, and a task put into a
    // plan (its milestone, what it waits for) by the page's own route.
    workPlans: ({ computer }) => get(computer, '/api/work/plans'),
    workPlanOne: ({ computer, id }) => get(computer, `/api/work/plans/${enc(id)}`),
    workTaskPlan: ({ computer, id, at, plan, milestone, after }) => post(computer, `/api/work/items/${enc(id)}/plan`, { at, ...(plan !== undefined ? { plan, milestone: milestone ?? null } : {}), ...(after !== undefined ? { after } : {}) }),

    // ---- the AI brain (read-only) ----
    brainIndex: ({ computer }) => get(computer, '/api/brain'),
    brainItem: ({ computer, id }) => get(computer, `/api/brain/item?id=${enc(id)}`),

    // ---- the operator's attention list (read-only) ----
    attention: ({ computer, kind = null }) => get(computer, `/api/operator/attention${kind ? `?kind=${enc(kind)}` : ''}`),

    // ---- providers ----
    async accounts({ computer }) {
      const st = await get(computer, '/api/state');
      return { profiles: st.profiles || [], autoSwitch: st.autoSwitch || { enabled: false, order: [] }, recommended: st.recommended || null };
    },
    setAutoSwitch: ({ computer, patch }) => post(computer, '/api/settings', { autoSwitch: patch }),

    // ---- computers ----
    async computers() {
      const r = await get(LOCAL, '/api/machines');
      return [{ name: LOCAL, label: (r.self && r.self.label) || 'this computer', online: true }, ...(r.machines || []).map((m) => ({ name: m.name, label: m.label || m.name, online: m.state === 'online' }))];
    },
    async computerStatus({ computer }) {
      const [pc, cl] = await Promise.all([get(computer, '/api/pc'), get(computer, '/api/claude').catch(() => null)]);
      const mem = pc.mem || {};
      return {
        load: pc.load || null,
        memory: mem.total ? { usedPct: Math.round((1 - (mem.available || 0) / mem.total) * 100), totalGB: Math.round(mem.total / 2 ** 30) } : null,
        disks: (pc.disks || []).map((d) => ({ mount: d.mount, usedPct: d.size ? Math.round((d.used / d.size) * 100) : null })),
        // A process is pinned by pid and command line (age changes every second, so it cannot be part of a card).
        processes: (pc.topCpu || []).map((p) => ({ pid: p.pid, command: p.args || p.name, cpu: p.cpu, mem: p.rss, started: null })),
        claude: cl ? { version: cl.installed || null, latest: cl.latest || null, updateAvailable: !!cl.updateAvailable } : null,
      };
    },
    setupStatus: ({ computer }) => get(computer, '/api/pcsetup/status?offline=1'),
    setupKits: ({ computer }) => get(computer, '/api/pcsetup/kits'),
    setupFix: ({ computer, id, confirm }) => post(computer, '/api/pcsetup/fix', { id, ...(typeof confirm === 'string' ? { confirm } : {}) }),
    setUp: ({ computer, kits }) => post(computer, '/api/pcsetup/setup', { kits }),
    updateClaude: ({ computer }) => post(computer, '/api/claude/update', {}),
    // The coding tools (src/codetools/feature.mjs) and Settings → Updates (src/automation/feature.mjs, updater.mjs).
    codingTools: ({ computer }) => get(computer, '/api/codetools'),
    setCodingTool: ({ computer, id, on }) => post(computer, `/api/codetools/${enc(id)}`, { on: on === true }),
    updates: ({ computer }) => get(computer, '/api/updates'),
    checkUpdates: ({ computer }) => post(computer, '/api/updates/check', {}),
    runUpdate: ({ computer, id }) => post(computer, '/api/updates/run', { id }),
    // The restart that loads a version just installed (the Updates page's Restart now): it ends this dashboard, so her turn too.
    restartDashboard: ({ computer }) => post(computer, '/api/updates/restart', {}),
    killProcess: ({ computer, pid, signal }) => post(computer, '/api/pc/kill', { pid, signal: signal === 'KILL' ? 'KILL' : 'TERM' }),
    power: ({ computer, action }) => post(computer, '/api/pc/power', { action, confirm: action }),
    renameComputer: ({ computer, label }) => (isLocal(computer) ? post(LOCAL, '/api/machine/label', { label }) : post(LOCAL, `/api/machines/${enc(computer)}/rename`, { label })),
    addons: ({ computer }) => get(computer, '/api/addons'),
    addon: ({ computer, id, action, confirm }) => post(computer, `/api/addons/${enc(id)}/${action}`, typeof confirm === 'string' ? { confirm } : {}),
    publicLink: ({ computer }) => get(computer, '/api/public-link'),
    setPublicLink: ({ computer, on }) => post(computer, '/api/public-link', { on }),

    // ---- automations ----
    automation: ({ computer }) => get(computer, '/api/automation'),
    automationSettings: ({ computer, patch }) => post(computer, '/api/automation/settings', patch),
    schedules: ({ computer, body }) => post(computer, '/api/automation/schedules', body),
    queue: ({ computer, session, body }) => post(computer, `/api/automation/queue/${enc(session)}`, body),

    // ---- skills ----
    skillsInstalled: ({ computer, project }) => get(computer, `/api/skillhub${project ? `?project=${enc(dir(computer, project))}` : ''}`),
    skillsSuggested: ({ computer, project }) => get(computer, `/api/skillhub/suggest${project ? `?project=${enc(dir(computer, project))}` : ''}`),
    skillsFind: ({ computer, query }) => get(computer, `/api/skillhub/find?q=${enc(query)}`),
    skillReview: ({ computer, spec, project }) => post(computer, '/api/skillhub/review', { spec, ...(project ? { project: dir(computer, project), scope: 'project' } : { scope: 'user' }) }),
    skillUpdateReview: ({ computer, name, project }) => post(computer, '/api/skillhub/update-review', { name, ...(project ? { project: dir(computer, project) } : {}) }),
    skillApprove: ({ computer, id }) => post(computer, '/api/skillhub/approve', { id }),
    skillRemove: ({ computer, name, project }) => post(computer, '/api/skillhub/remove', { name, ...(project ? { project: dir(computer, project) } : {}) }),
    skillsCheck: ({ computer, project }) => post(computer, '/api/skillhub/check', project ? { project: dir(computer, project) } : {}),
    skillCancel: ({ computer, id }) => post(computer, '/api/skillhub/cancel', { id }),
    skillUndo: ({ computer, name, project }) => post(computer, '/api/skillhub/undo', { name, ...(project ? { project: dir(computer, project) } : {}) }),
    fieldTwice: ({ computer }) => get(computer, '/api/field/twice'),
    // The line's key is <kind>:<class>; the route reads the ":" as it is (the page sends it so), each side encoded.
    fieldTwiceAct: ({ computer, line, act }) => post(computer, `/api/field/twice/${String(line).split(':').map(enc).join(':')}/${act === 'draft' ? 'draft' : 'dismiss'}`, {}),

    projectsFolder: ({ computer, dir: d }) => post(computer, '/api/pcsetup/projects-dir', { dir: dir(computer, d) }),
    workingRules: ({ computer, add }) => post(computer, '/api/pcsetup/rules', { action: add ? 'add' : 'remove' }),
    skillsWeekly: ({ computer, weekly }) => post(computer, '/api/skillhub/settings', { weekly }),

    // ---- settings ----
    settings: ({ computer }) => get(computer, '/api/settings'),
    changeSettings: ({ computer, patch }) => post(computer, '/api/settings', patch),
    // Each computer's room (src/operator/rooms.mjs) for where a start of hers goes: always this dashboard's own view.
    rooms: () => get(LOCAL, '/api/operator/rooms?start=1'),
    async assistantSettings() {
      const a = cfg().assistant;
      return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
    },

    // ---- the owner ----
    // own: an event of the product's own kind ("waiting"), sent only when the owner's notification switches choose it
    // (Settings → Notifications); without it a note she writes on purpose always goes out.
    async notify({ title, message, session, own = false }) {
      // Tia's notes always go out (force): the owner chose the channel, and she only writes when it matters.
      const r = await ctx.notify({ ...(own ? {} : { force: true }), status: 'waiting', session: session || 'tia', title, message }).catch(() => ({ sent: false }));
      return { sent: !!(r && r.sent) };
    },

    // ---- one shell command ----
    runCommand: ({ computer, command, cwd, timeoutMs }) => post(computer, '/api/assistant/run', { command, ...(cwd ? { cwd } : {}), timeoutMs }),

    /** The implementation behind POST /api/assistant/run (this computer). A plain shell command: never an administrator
     * run (that is runAdmin, which is not an HTTP route), so a machine token — which reaches only this route — can never
     * trigger an administrator run with the owner's password. */
    async runHere({ command, cwd, timeoutMs }) {
      if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\0\r\n]/.test(command)) throw fail(400, 'one command line of at most 2000 characters');
      const r = roots();
      const d = cwd ? insideRoots(v.absPath(localPath(cwd)), r) : r[0];
      if (!d) throw fail(400, 'the folder must be inside the allowed roots');
      const ms = Number.isInteger(timeoutMs) ? Math.max(1000, Math.min(600_000, timeoutMs)) : 60_000;
      return o.runShell(command, { cwd: d, timeoutMs: ms });
    },

    /**
     * Run ONE administrator command of Tia's (Ask each time and Full): `sudo -S -k -p '' -- <program>
     * <args>` with the owner's one-shot password to sudo's input (where sudo needs one), or `sudo -n …` where it does
     * not — the construction of src/pcsetup/admin.mjs, which keeps, logs, audits and returns nothing of the password.
     * It is reached ONLY from run_command's run on the owner's own confirm (the password is his, typed on his page, for
     * THIS computer): it is not an HTTP route, so the machines gate (which reaches only runHere) can never trigger an
     * administrator run. The argv is the wall's one reader (sudoArgv), so nothing here reads a line for admin-ness, and
     * it only runs on this computer.
     */
    async runAdmin({ computer, argv, password = '', cwd = null }) {
      if (!isLocal(computer)) throw fail(400, 'an administrator command runs only on this computer: the password is the owner\'s own, for this computer');
      if (!Array.isArray(argv) || argv[0] !== 'sudo') throw fail(400, 'an administrator run needs a sudo argv from the wall\'s reader');
      const r = roots();
      const d = cwd ? insideRoots(v.absPath(localPath(cwd)), r) : r[0];
      if (!d) throw fail(400, 'the folder must be inside the allowed roots');
      return (o.runAdmin || runAdminCmd)({ argv, password, cwd: d });
    },

    /**
     * Whether this computer's sudo asks for a password (it drives the Ask card's password field, and
     * Full is offered only where it does not). The same reader setup uses (sudoNeedsPassword over sysFacts): not root,
     * sudo is there, and `sudo -n true` is refused. Detected once per process (sudo's configuration does not change
     * under the dashboard, and the product never writes a sudoers rule). Only this computer's own sudo runs an
     * administrator command (runAdmin above), so for any other computer a password is assumed (the card shows a field,
     * fail safe). The modules are loaded lazily so the assistant's ops carries no setup code it rarely needs.
     */
    async adminNeedsPassword({ computer } = {}) {
      if (!isLocal(computer)) return true;
      if (adminPwKnown === undefined) {
        const { sysFacts } = await import('../pcsetup/detect.mjs');
        const { sudoNeedsPassword } = await import('../pcsetup/admin.mjs');
        adminPwKnown = await sudoNeedsPassword(await sysFacts());
      }
      return adminPwKnown;
    },
  };
}
